import type { Context } from "hono"

import { stream } from "hono/streaming"
import { streamSSE, type SSEMessage } from "hono/streaming"

import type { Model } from "~/services/copilot/get-models"

import { awaitApproval } from "~/lib/approval"
import { translateModelName, isGeminiModel } from "~/lib/augment-models"
import { createHandlerLogger, debugJson, debugJsonTail } from "~/lib/logger"
import { checkRateLimit } from "~/lib/rate-limit"
import {
  getCopilotTokenForRequest,
  GITHUB_TOKEN_HEADER,
} from "~/lib/request-token"
import { state } from "~/lib/state"
import { getTokenCount } from "~/lib/tokenizer"
import {
  logUserActivity,
  USER_ID_HEADER,
} from "~/lib/user-activity-logger"
import { cacheModels, generateRequestIdFromPayload, getUUID, isNullish } from "~/lib/utils"
import {
  applyResponsesApiContextManagement,
  compactInputByLatestCompaction,
} from "~/routes/responses/utils"
import {
  createChatCompletions,
  type ChatCompletionResponse,
  type ChatCompletionsPayload,
} from "~/services/copilot/create-chat-completions"
import {
  createResponses,
  type ResponsesResult,
  type ResponseStreamEvent,
} from "~/services/copilot/create-responses"

import {
  createChatCompletionStreamState,
  translateChatCompletionsToResponsesPayload,
  translateResponsesResultToChatCompletion,
  translateResponsesStreamEventToChatCompletionChunks,
} from "./responses-bridge"

const logger = createHandlerLogger("chat-completions-handler")

const RESPONSES_ENDPOINT = "/responses"
const CHAT_COMPLETIONS_ENDPOINT = "/chat/completions"

// Extended payload type with Augment format marker
interface ExtendedPayload extends ChatCompletionsPayload {
  _augment_format?: boolean
}

export async function handleCompletion(c: Context) {
  const requestStartTime = Date.now()

  // Extract user identification from headers (passed by proxy)
  const userId = c.req.header(USER_ID_HEADER)
  const clientIp =
    c.req.header("x-forwarded-for") || c.req.header("x-real-ip") || "unknown"

  await checkRateLimit(state)

  // Check for per-request GitHub token from proxy
  const githubToken = c.req.header(GITHUB_TOKEN_HEADER)
  let perRequestCopilotToken: string | null = null

  if (githubToken) {
    logger.info("Per-request GitHub token detected, exchanging for Copilot token...")
    perRequestCopilotToken = await getCopilotTokenForRequest(githubToken)

    if (!perRequestCopilotToken) {
      logger.error("Failed to get Copilot token from provided GitHub token")
      if (userId) {
        logUserActivity(userId, "ERROR", "AUTH", "GitHub token exchange failed", {
          clientIp,
          errorType: "github_token_invalid",
        })
      }
      return c.json(
        {
          error: {
            message: "Failed to authenticate with provided GitHub token",
            type: "authentication_error",
            code: "github_token_invalid",
          },
        },
        401,
      )
    }
  } else if (!state.copilotToken) {
    logger.error(
      "No authentication token available. In sidecar mode, x-github-token header is required.",
    )
    if (userId) {
      logUserActivity(userId, "ERROR", "AUTH", "Missing authentication token", {
        clientIp,
        errorType: "missing_token",
      })
    }
    return c.json(
      {
        error: {
          message:
            "No authentication token provided. The x-github-token header is required.",
          type: "authentication_error",
          code: "missing_token",
        },
      },
      401,
    )
  }

  const rawPayload = await c.req.json<ExtendedPayload>()
  const isAugmentFormat = rawPayload._augment_format === true

  // Remove internal marker before processing
  const { _augment_format, ...cleanPayload } = rawPayload
  let payload: ChatCompletionsPayload = cleanPayload

  debugJsonTail(logger, "Request payload:", { value: payload, tailLength: 400 })
  if (isAugmentFormat) {
    logger.info("Augment format requested - will return NDJSON response")
  }

  // Validate messages - must be non-empty
  if (!payload.messages || payload.messages.length === 0) {
    logger.error("Empty messages array received!")
    if (userId) {
      logUserActivity(userId, "ERROR", "REQUEST", "Empty messages array", {
        clientIp,
        errorType: "invalid_messages",
      })
    }
    return c.json(
      {
        error: {
          message: "messages must be non-empty",
          type: "invalid_request_error",
          code: "invalid_messages",
        },
      },
      400,
    )
  }

  // Log successful request start
  if (userId) {
    logUserActivity(userId, "INFO", "REQUEST", "Chat completion request started", {
      model: payload.model,
      clientIp,
      endpoint: "/chat/completions",
      method: "POST",
    })
  }

  // Translate model name to Copilot-compatible ID
  const translatedModel = translateModelName(payload.model)
  if (translatedModel !== payload.model) {
    logger.info(`Model translated: ${payload.model} -> ${translatedModel}`)
    payload = { ...payload, model: translatedModel }
  } else {
    logger.debug(`Model: ${payload.model} (no translation needed)`)
  }

  // Gemini support: Check for tool results and handle accordingly
  const isGemini = isGeminiModel(payload.model)
  if (isGemini) {
    const hasToolResult = payload.messages?.some((msg) => msg.role === "tool")
    if (hasToolResult) {
      const hasCache = checkReasoningCache(payload)
      if (hasCache) {
        logger.info(
          "Gemini model with tool results - injecting cached reasoning_opaque",
        )
        payload = injectReasoningOpaque(payload)
      } else {
        logger.warn(
          "Gemini tool results require reasoning_opaque but cache miss occurred",
        )
        logger.warn("Falling back to Claude Opus 4.5 for better tool result processing")
        payload = { ...payload, model: "claude-opus-4.5" }
      }
    }
  }

  // Ensure models are cached (sidecar mode may not have them yet)
  if (!state.models) {
    logger.info("Models not cached yet, fetching...")
    await cacheModels(perRequestCopilotToken ?? undefined)
  }

  // Find the selected model
  const selectedModel = state.models?.data.find(
    (model) => model.id === payload.model,
  )

  // Calculate and display token count
  try {
    if (selectedModel) {
      const tokenCount = await getTokenCount(payload, selectedModel)
      logger.info("Current token count:", tokenCount)
    } else {
      logger.warn("No model selected, skipping token count calculation")
    }
  } catch (error) {
    logger.warn("Failed to calculate token count:", error)
  }

  if (state.manualApprove) await awaitApproval()

  if (isNullish(payload.max_tokens)) {
    payload = {
      ...payload,
      max_tokens: selectedModel?.capabilities.limits.max_output_tokens,
    }
    debugJson(logger, "Set max_tokens to:", payload.max_tokens)
  }

  // not support subagent marker for now, set sessionId = getUUID(requestId)
  const requestId = generateRequestIdFromPayload(payload)
  logger.debug("Generated request ID:", requestId)

  const sessionId = getUUID(requestId)
  logger.debug("Extracted session ID:", sessionId)

  // Check if model only supports /responses (e.g. codex models)
  const supportsResponses =
    selectedModel?.supported_endpoints?.includes(RESPONSES_ENDPOINT) ?? false
  const supportsChatCompletions =
    selectedModel?.supported_endpoints?.includes(CHAT_COMPLETIONS_ENDPOINT)
    ?? true

  if (supportsResponses && !supportsChatCompletions) {
    logger.info(
      `Model ${payload.model} only supports /responses — routing through Responses API bridge`,
    )
    return await handleViaResponsesApi(c, payload, {
      requestId,
      sessionId,
      copilotToken: perRequestCopilotToken ?? undefined,
      selectedModel,
      userId,
      clientIp,
      requestStartTime,
      isAugmentFormat,
    })
  }

  // Pass per-request Copilot token if available
  const response = await createChatCompletions(payload, {
    requestId,
    sessionId,
    ...(perRequestCopilotToken
      ? { copilotToken: perRequestCopilotToken }
      : {}),
  })

  if (isNonStreaming(response)) {
    debugJson(logger, "Non-streaming response:", response)

    // Log successful non-streaming response
    const requestDuration = Date.now() - requestStartTime
    if (userId) {
      const usage = response.usage
      logUserActivity(
        userId,
        "INFO",
        "RESPONSE",
        "Chat completion completed (non-streaming)",
        {
          model: payload.model,
          status: 200,
          duration: requestDuration,
          inputTokens: usage?.prompt_tokens,
          outputTokens: usage?.completion_tokens,
          tokens: usage?.total_tokens,
          clientIp,
        },
      )
    }

    // Cache reasoning_opaque for Gemini models with tool_calls
    if (isGemini) {
      const message = response.choices?.[0]?.message as unknown as Record<string, unknown>
      if (message?.tool_calls && message.reasoning_opaque) {
        const toolCallIds = (
          message.tool_calls as Array<{ id: string }>
        ).map((tc) => tc.id)
        cacheReasoningOpaque(
          toolCallIds,
          message.reasoning_opaque as string,
          message.reasoning_text as string | undefined,
        )
      }
    }

    // For Augment format, wrap non-streaming response
    if (isAugmentFormat) {
      const content = response.choices?.[0]?.message?.content ?? ""
      return c.json({
        text: content,
        stop_reason: 1,
        unknown_blob_names: [],
        checkpoint_not_found: false,
        workspace_file_chunks: [],
        incorporated_external_sources: [],
        nodes: [
          { id: 1, type: 0, content, tool_use: null, thinking: null },
        ],
      })
    }
    return c.json(response)
  }

  // Streaming response
  logger.debug("Streaming response")

  if (isAugmentFormat) {
    // Return Augment NDJSON format with proper node types
    return stream(c, async (s) => {
      let fullContent = ""
      let nodeId = 0
      let finishReason: string | null = null

      // Track Gemini state
      let reasoningOpaque: string | undefined
      let reasoningText: string | undefined
      let thinkingNodeSent = false

      // Track tool calls
      const toolCalls: Array<{
        id: string
        name: string
        arguments: string
      }> = []
      const toolCallArgBuffers: Map<number, string> = new Map()

      // Generate synthetic thinking for all models at the start
      const userMessage = payload.messages.filter((m) => m.role === "user").pop()
      const userContent =
        typeof userMessage?.content === "string"
          ? userMessage.content
          : userMessage?.content?.find((c) => c.type === "text")?.text || ""

      if (userContent) {
        const syntheticThinking = generateSyntheticThinking(userContent)
        thinkingNodeSent = true
        const provider = isGemini ? "google" : "anthropic"
        const thinkingChunk = JSON.stringify({
          text: "",
          stop_reason: null,
          unknown_blob_names: [],
          checkpoint_not_found: false,
          workspace_file_chunks: [],
          incorporated_external_sources: [],
          nodes: [
            {
              id: nodeId++,
              type: 8, // THINKING
              content: "",
              tool_use: null,
              thinking: {
                summary: syntheticThinking,
                encrypted_content:
                  Buffer.from(syntheticThinking).toString("base64"),
                content: null,
                openai_responses_api_item_id: null,
              },
              billing_metadata: null,
              metadata: { openai_id: null, google_ts: null, provider },
              token_usage: null,
            },
          ],
        })
        await s.write(thinkingChunk + "\n")
      }

      for await (const rawEvent of response) {
        if (rawEvent.data === "[DONE]") {
          // Cache reasoning_opaque for Gemini models with tool_calls
          if (isGemini && toolCalls.length > 0 && reasoningOpaque) {
            const toolCallIds = toolCalls.map((tc) => tc.id)
            cacheReasoningOpaque(toolCallIds, reasoningOpaque, reasoningText)
          }

          // Build final nodes array
          const nodes: Array<Record<string, unknown>> = []

          // Add THINKING node (type 8) if we have reasoning_opaque
          if (reasoningOpaque && !thinkingNodeSent) {
            nodes.push({
              id: nodeId++,
              type: 8,
              content: "",
              tool_use: null,
              thinking: {
                summary: reasoningText || "",
                encrypted_content: reasoningOpaque,
                content: null,
                openai_responses_api_item_id: null,
              },
              billing_metadata: null,
              metadata: {
                openai_id: null,
                google_ts: null,
                provider: isGemini ? "google" : null,
              },
              token_usage: null,
            })
          }

          // Add TOOL_USE nodes (type 5) if present
          for (const tc of toolCalls.filter(Boolean)) {
            const validArgs =
              tc.arguments && tc.arguments.trim() ? tc.arguments : "{}"
            nodes.push({
              id: nodeId++,
              type: 5,
              content: "",
              tool_use: {
                tool_use_id: tc.id,
                tool_name: tc.name,
                input_json: validArgs,
                is_partial: false,
                id: tc.id,
                name: tc.name,
                arguments: validArgs,
              },
              thinking: null,
              billing_metadata: null,
              metadata: {
                openai_id: null,
                google_ts: null,
                provider: null,
              },
              token_usage: null,
            })
          }

          // Add TEXT node (type 0) with full content
          nodes.push({
            id: nodeId++,
            type: 0,
            content: fullContent,
            tool_use: null,
            thinking: null,
            billing_metadata: null,
            metadata: {
              openai_id: null,
              google_ts: null,
              provider: null,
            },
            token_usage: null,
          })

          // Determine stop_reason: 3 for tool_calls, 1 for normal end
          const stopReason = finishReason === "tool_calls" ? 3 : 1

          // Send final content chunk
          const contentChunk = JSON.stringify({
            text: "",
            stop_reason: null,
            unknown_blob_names: [],
            checkpoint_not_found: false,
            workspace_file_chunks: [],
            incorporated_external_sources: [],
            nodes,
          })
          await s.write(contentChunk + "\n")

          // Send TOOL_RESULT placeholder (type 2)
          const toolResultChunk = JSON.stringify({
            text: "",
            stop_reason: stopReason,
            unknown_blob_names: [],
            checkpoint_not_found: false,
            workspace_file_chunks: [],
            incorporated_external_sources: [],
            nodes: [
              {
                id: nodeId++,
                type: 2,
                content: "",
                tool_use: null,
                thinking: null,
                billing_metadata: null,
                metadata: {
                  openai_id: null,
                  google_ts: null,
                  provider: null,
                },
                token_usage: null,
              },
            ],
          })
          await s.write(toolResultChunk + "\n")

          // Send SENTINEL node (type 3)
          const sentinelChunk = JSON.stringify({
            text: "",
            stop_reason: stopReason,
            unknown_blob_names: [],
            checkpoint_not_found: false,
            workspace_file_chunks: [],
            incorporated_external_sources: [],
            nodes: [
              {
                id: nodeId++,
                type: 3,
                content: "",
                tool_use: null,
                thinking: null,
                billing_metadata: null,
                metadata: null,
                token_usage: null,
              },
            ],
          })
          await s.write(sentinelChunk + "\n")

          // Log successful streaming response (Augment format)
          const requestDuration = Date.now() - requestStartTime
          if (userId) {
            logUserActivity(
              userId,
              "INFO",
              "RESPONSE",
              "Chat completion completed (streaming, Augment format)",
              {
                model: payload.model,
                status: 200,
                duration: requestDuration,
                clientIp,
              },
            )
          }
          break
        }

        if (!rawEvent.data) continue

        try {
          const parsed = JSON.parse(rawEvent.data)
          const choice = parsed.choices?.[0]
          const delta = choice?.delta

          // Track finish_reason
          if (choice?.finish_reason) {
            finishReason = choice.finish_reason
          }

          // Extract reasoning_opaque from Gemini
          if (isGemini) {
            if (delta?.reasoning_opaque) {
              reasoningOpaque = delta.reasoning_opaque
              logger.debug("Found reasoning_opaque in delta")
            }
            if (delta?.reasoning_text) {
              reasoningText = delta.reasoning_text
            }
            if (choice?.message?.reasoning_opaque) {
              reasoningOpaque = choice.message.reasoning_opaque
            }
            if (choice?.message?.reasoning_text) {
              reasoningText = choice.message.reasoning_text
            }
          }

          // Send THINKING node early if we have reasoning_opaque (before text)
          if (reasoningOpaque && !thinkingNodeSent) {
            thinkingNodeSent = true
            const thinkingChunk = JSON.stringify({
              text: "",
              stop_reason: null,
              unknown_blob_names: [],
              checkpoint_not_found: false,
              workspace_file_chunks: [],
              incorporated_external_sources: [],
              nodes: [
                {
                  id: nodeId++,
                  type: 8,
                  content: "",
                  tool_use: null,
                  thinking: {
                    summary: reasoningText || "",
                    encrypted_content: reasoningOpaque,
                    content: null,
                    openai_responses_api_item_id: null,
                  },
                  billing_metadata: null,
                  metadata: {
                    openai_id: null,
                    google_ts: null,
                    provider: isGemini ? "google" : null,
                  },
                  token_usage: null,
                },
              ],
            })
            await s.write(thinkingChunk + "\n")
          }

          // Track tool_calls
          if (delta?.tool_calls) {
            for (const tc of delta.tool_calls) {
              const idx = tc.index ?? 0
              if (!toolCalls[idx]) {
                toolCalls[idx] = {
                  id: tc.id || `tool_${idx}`,
                  name: tc.function?.name || "",
                  arguments: "",
                }
              }
              if (tc.id) {
                toolCalls[idx].id = tc.id
              }
              if (tc.function?.name) {
                toolCalls[idx].name = tc.function.name
              }
              if (tc.function?.arguments) {
                const current = toolCallArgBuffers.get(idx) || ""
                toolCallArgBuffers.set(idx, current + tc.function.arguments)
                toolCalls[idx].arguments = toolCallArgBuffers.get(idx) || ""
              }
            }
          }

          // Stream text content
          const content = delta?.content ?? ""
          if (content) {
            fullContent += content
            const chunk = JSON.stringify({
              text: content,
              stop_reason: null,
              unknown_blob_names: [],
              checkpoint_not_found: false,
              workspace_file_chunks: [],
              incorporated_external_sources: [],
              nodes: [],
            })
            await s.write(chunk + "\n")
          }
        } catch (e) {
          logger.debug("Failed to parse streaming event:", rawEvent.data, e)
        }
      }
    })
  }

  // Default: OpenAI SSE format
  return streamSSE(c, async (s) => {
    // Track Gemini state for caching
    const toolCallIds: string[] = []
    let reasoningOpaque: string | undefined
    let reasoningText: string | undefined

    for await (const rawEvent of response) {
      debugJson(logger, "Raw stream event:", rawEvent)
      if (rawEvent.data === "[DONE]") {
        // Cache reasoning_opaque for Gemini models with tool_calls
        if (isGemini && toolCallIds.length > 0 && reasoningOpaque) {
          cacheReasoningOpaque(toolCallIds, reasoningOpaque, reasoningText)
        }

        // Log successful streaming response (SSE format)
        const requestDuration = Date.now() - requestStartTime
        if (userId) {
          logUserActivity(
            userId,
            "INFO",
            "RESPONSE",
            "Chat completion completed (streaming, SSE format)",
            {
              model: payload.model,
              status: 200,
              duration: requestDuration,
              clientIp,
            },
          )
        }

        await s.writeSSE({ data: "[DONE]" } as SSEMessage)
        break
      }

      if (!rawEvent.data) {
        continue
      }

      // Filter out chunks with null/empty content (problematic for non-Anthropic models)
      try {
        const parsed = JSON.parse(rawEvent.data)
        const choices = parsed.choices

        if (!choices || choices.length === 0) {
          logger.debug("Skipping chunk with empty choices")
          continue
        }

        const choice = choices[0]
        const delta = choice?.delta
        const finishReasonVal = choice?.finish_reason

        // Always pass through chunks with finish_reason (final chunks)
        if (finishReasonVal !== null && finishReasonVal !== undefined) {
          // Pass through
        } else {
          const content = delta?.content
          const toolCallsDelta = delta?.tool_calls
          const reasoningTextDelta = delta?.reasoning_text

          if (
            (content === null || content === "" || content === undefined) &&
            !toolCallsDelta &&
            !reasoningTextDelta
          ) {
            logger.debug("Skipping chunk with null/empty content")
            continue
          }
        }
      } catch {
        // If we can't parse, pass through as-is
      }

      // Parse streaming chunk to extract Gemini state
      if (isGemini) {
        try {
          const parsed = JSON.parse(rawEvent.data)
          const choice = parsed.choices?.[0]

          if (choice?.delta?.tool_calls) {
            for (const tc of choice.delta.tool_calls) {
              if (tc.id && !toolCallIds.includes(tc.id)) {
                toolCallIds.push(tc.id)
              }
            }
          }

          if (choice?.delta?.reasoning_opaque) {
            reasoningOpaque = choice.delta.reasoning_opaque
          }
          if (choice?.delta?.reasoning_text) {
            reasoningText = choice.delta.reasoning_text
          }
          if (choice?.message?.reasoning_opaque) {
            reasoningOpaque = choice.message.reasoning_opaque
          }
          if (choice?.message?.reasoning_text) {
            reasoningText = choice.message.reasoning_text
          }
        } catch {
          // Ignore parse errors
        }
      }

      await s.writeSSE({ data: rawEvent.data } as SSEMessage)
    }
  })
}

// ============================================================================
// Responses API Bridge (for models that only support /responses)
// ============================================================================

interface ResponsesBridgeOptions {
  requestId: string
  sessionId: string
  copilotToken?: string
  selectedModel?: Model
  userId?: string
  clientIp: string
  requestStartTime: number
  isAugmentFormat: boolean
}

async function handleViaResponsesApi(
  c: Context,
  payload: ChatCompletionsPayload,
  opts: ResponsesBridgeOptions,
) {
  const responsesPayload = translateChatCompletionsToResponsesPayload(payload)

  applyResponsesApiContextManagement(
    responsesPayload,
    opts.selectedModel?.capabilities.limits.max_prompt_tokens,
  )
  compactInputByLatestCompaction(responsesPayload)

  logger.debug(
    "Responses bridge payload:",
    JSON.stringify(responsesPayload).slice(-400),
  )

  // Determine vision / initiator
  const hasVision =
    Array.isArray(responsesPayload.input)
    && responsesPayload.input.some(
      (item) =>
        "content" in item
        && Array.isArray(item.content)
        && (item.content as Array<{ type?: string }>).some(
          (block) => block.type === "input_image",
        ),
    )

  const lastMsg = payload.messages.at(-1)
  const initiator =
    lastMsg && ["assistant", "tool"].includes(lastMsg.role) ? "agent" : "user"

  const response = await createResponses(responsesPayload, {
    vision: hasVision,
    initiator,
    requestId: opts.requestId,
    sessionId: opts.sessionId,
    ...(opts.copilotToken ? { copilotToken: opts.copilotToken } : {}),
  })

  logger.info(
    `Responses bridge: createResponses returned. stream=${payload.stream}, isAsyncIterable=${isAsyncIterable(response)}`,
  )

  // Non-streaming path
  if (!payload.stream || !isAsyncIterable(response)) {
    const result = response as ResponsesResult
    logger.debug(
      "Responses bridge non-streaming result:",
      JSON.stringify(result).slice(-400),
    )
    const chatResponse = translateResponsesResultToChatCompletion(result)

    const requestDuration = Date.now() - opts.requestStartTime
    if (opts.userId) {
      logUserActivity(
        opts.userId,
        "INFO",
        "RESPONSE",
        "Chat completion completed (responses-bridge, non-streaming)",
        {
          model: payload.model,
          status: 200,
          duration: requestDuration,
          clientIp: opts.clientIp,
        },
      )
    }

    if (opts.isAugmentFormat) {
      const content = chatResponse.choices?.[0]?.message?.content ?? ""
      return c.json({
        text: content,
        stop_reason: 1,
        unknown_blob_names: [],
        checkpoint_not_found: false,
        workspace_file_chunks: [],
        incorporated_external_sources: [],
        nodes: [
          { id: 1, type: 0, content, tool_use: null, thinking: null },
        ],
      })
    }

    return c.json(chatResponse)
  }

  // Streaming path
  logger.info("Responses bridge: entering streaming path, payload.stream =", payload.stream)

  return streamSSE(c, async (s) => {
    const streamState = createChatCompletionStreamState()
    let chunkCount = 0
    let emittedCount = 0

    for await (const chunk of response as AsyncIterable<{
      event?: string
      data?: string
    }>) {
      chunkCount++
      if (!chunk.data) {
        logger.debug(`Responses bridge: chunk #${chunkCount} has no data, event=${chunk.event}`)
        continue
      }

      let parsed: ResponseStreamEvent
      try {
        parsed = JSON.parse(chunk.data) as ResponseStreamEvent
      } catch {
        logger.debug(`Responses bridge: chunk #${chunkCount} failed to parse: ${chunk.data.slice(0, 100)}`)
        continue
      }

      logger.debug(`Responses bridge: chunk #${chunkCount} type=${parsed.type}`)

      const chunks =
        translateResponsesStreamEventToChatCompletionChunks(parsed, streamState)

      for (const data of chunks) {
        emittedCount++
        await s.writeSSE({ data } as SSEMessage)
      }
    }

    logger.info(`Responses bridge: stream ended. Received ${chunkCount} chunks, emitted ${emittedCount} SSE events`)

    // Send the [DONE] sentinel
    await s.writeSSE({ data: "[DONE]" } as SSEMessage)

    const requestDuration = Date.now() - opts.requestStartTime
    if (opts.userId) {
      logUserActivity(
        opts.userId,
        "INFO",
        "RESPONSE",
        "Chat completion completed (responses-bridge, streaming)",
        {
          model: payload.model,
          status: 200,
          duration: requestDuration,
          clientIp: opts.clientIp,
        },
      )
    }
  })
}

const isAsyncIterable = <T>(value: unknown): value is AsyncIterable<T> =>
  Boolean(value)
  && typeof (value as AsyncIterable<T>)[Symbol.asyncIterator] === "function"
const isNonStreaming = (
  response: Awaited<ReturnType<typeof createChatCompletions>>,
): response is ChatCompletionResponse => Object.hasOwn(response, "choices")

// ============================================================================
// Gemini Reasoning Cache
// ============================================================================

interface ReasoningCacheEntry {
  reasoning_opaque: string
  reasoning_text?: string
  timestamp: number
}

/** In-memory cache for Gemini reasoning_opaque by tool_call ID */
const reasoningOpaqueCache = new Map<string, ReasoningCacheEntry>()

function checkReasoningCache(payload: ChatCompletionsPayload): boolean {
  for (const msg of payload.messages) {
    if (
      msg.role === "assistant" &&
      msg.tool_calls &&
      msg.tool_calls.length > 0
    ) {
      for (const toolCall of msg.tool_calls) {
        if (reasoningOpaqueCache.has(toolCall.id)) {
          return true
        }
      }
    }
  }
  return false
}

function injectReasoningOpaque(
  payload: ChatCompletionsPayload,
): ChatCompletionsPayload {
  const messages = payload.messages.map((msg) => {
    if (
      msg.role === "assistant" &&
      msg.tool_calls &&
      msg.tool_calls.length > 0
    ) {
      for (const toolCall of msg.tool_calls) {
        const cached = reasoningOpaqueCache.get(toolCall.id)
        if (cached) {
          logger.info(
            `Injecting reasoning_opaque for tool_call ${toolCall.id}`,
          )
          return {
            ...msg,
            reasoning_opaque: cached.reasoning_opaque,
            reasoning_text: cached.reasoning_text,
          }
        }
      }
    }
    return msg
  })
  return { ...payload, messages }
}

function cacheReasoningOpaque(
  toolCallIds: string[],
  reasoningOpaque: string,
  reasoningText?: string,
): void {
  const entry: ReasoningCacheEntry = {
    reasoning_opaque: reasoningOpaque,
    reasoning_text: reasoningText,
    timestamp: Date.now(),
  }
  for (const id of toolCallIds) {
    logger.info(`Caching reasoning_opaque for tool_call ${id}`)
    reasoningOpaqueCache.set(id, entry)
  }
}

// ============================================================================
// Synthetic Thinking
// ============================================================================

function generateSyntheticThinking(userMessage: string): string {
  const maxLen = 200
  const truncated =
    userMessage.length > maxLen
      ? userMessage.slice(0, maxLen) + "..."
      : userMessage

  const cleaned = truncated.replace(/\n+/g, " ").replace(/\s+/g, " ").trim()

  if (cleaned.length < 20) {
    return `Processing a brief request: "${cleaned}"`
  }

  const lowerMsg = cleaned.toLowerCase()

  if (
    lowerMsg.includes("fix") ||
    lowerMsg.includes("bug") ||
    lowerMsg.includes("error")
  ) {
    return "The user needs help fixing an issue. Let me analyze the problem and provide a solution."
  }

  if (
    lowerMsg.includes("explain") ||
    lowerMsg.includes("what is") ||
    lowerMsg.includes("how does")
  ) {
    return "The user wants an explanation. Let me provide a clear and helpful response."
  }

  if (
    lowerMsg.includes("create") ||
    lowerMsg.includes("write") ||
    lowerMsg.includes("generate") ||
    lowerMsg.includes("implement")
  ) {
    return "The user wants me to create or implement something. Let me think through the requirements."
  }

  if (
    lowerMsg.includes("review") ||
    lowerMsg.includes("improve") ||
    lowerMsg.includes("refactor")
  ) {
    return "The user wants code review or improvements. Let me analyze and suggest enhancements."
  }

  if (lowerMsg.includes("tell me") || lowerMsg.includes("about")) {
    return "The user wants to learn about something. Let me gather relevant information."
  }

  return "Processing the user's request. Let me analyze and provide a helpful response."
}
