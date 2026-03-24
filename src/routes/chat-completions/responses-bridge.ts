/**
 * Bridge between OpenAI Chat Completions format and the Responses API.
 *
 * Used when a model only supports the /responses endpoint (e.g. codex models)
 * but the client sends an OpenAI /v1/chat/completions request.
 *
 * Translates:
 *   ChatCompletionsPayload  →  ResponsesPayload
 *   ResponsesResult         →  ChatCompletionResponse
 *   ResponseStreamEvent     →  ChatCompletionChunk (SSE)
 */

import type {
  ChatCompletionResponse,
  ChatCompletionsPayload,
  ContentPart,
  Message,
  ToolCall,
} from "~/services/copilot/create-chat-completions"
import type {
  ResponseInputContent,
  ResponseInputItem,
  ResponseInputMessage,
  ResponseInputText,
  ResponseOutputItem,
  ResponseOutputMessage,
  ResponseOutputReasoning,
  ResponsesPayload,
  ResponsesResult,
  ResponseStreamEvent,
  Tool as ResponsesTool,
} from "~/services/copilot/create-responses"

import {
  getExtraPromptForModel,
  getReasoningEffortForModel,
} from "~/lib/config"

// ---------------------------------------------------------------------------
// Payload translation: ChatCompletionsPayload → ResponsesPayload
// ---------------------------------------------------------------------------

export function translateChatCompletionsToResponsesPayload(
  payload: ChatCompletionsPayload,
): ResponsesPayload {
  const { systemInstructions, inputItems } = translateMessages(
    payload.messages,
    payload.model,
  )

  return {
    model: payload.model,
    input: inputItems,
    instructions: systemInstructions,
    temperature: 1,
    top_p: payload.top_p ?? null,
    max_output_tokens: Math.max(payload.max_tokens ?? 12800, 12800),
    tools: translateTools(payload.tools),
    tool_choice: translateToolChoice(payload.tool_choice),
    stream: payload.stream ?? null,
    store: false,
    parallel_tool_calls: true,
    reasoning: {
      effort: getReasoningEffortForModel(payload.model),
      summary: "detailed",
    },
    include: ["reasoning.encrypted_content"],
  }
}

// ---------------------------------------------------------------------------
// Message translation helpers
// ---------------------------------------------------------------------------

function translateMessages(
  messages: Array<Message>,
  model: string,
): { systemInstructions: string | null; inputItems: Array<ResponseInputItem> } {
  const inputItems: Array<ResponseInputItem> = []
  const systemParts: Array<string> = []

  for (const msg of messages) {
    switch (msg.role) {
      case "system":
      case "developer": {
        systemParts.push(extractTextContent(msg.content))
        break
      }
      case "user": {
        inputItems.push(translateUserMessage(msg))
        break
      }
      case "assistant": {
        inputItems.push(...translateAssistantMessage(msg))
        break
      }
      case "tool": {
        if (msg.tool_call_id) {
          inputItems.push({
            type: "function_call_output",
            call_id: msg.tool_call_id,
            output: extractTextContent(msg.content),
          })
        }
        break
      }
      default: {
        break
      }
    }
  }

  const extraPrompt = getExtraPromptForModel(model)
  const systemText =
    systemParts.length > 0 ? systemParts.join("\n\n") + extraPrompt : null

  return { systemInstructions: systemText, inputItems }
}

function translateUserMessage(msg: Message): ResponseInputMessage {
  return {
    type: "message",
    role: "user",
    content: translateContent(msg.content, "input_text"),
  }
}

function translateAssistantMessage(msg: Message): Array<ResponseInputItem> {
  const items: Array<ResponseInputItem> = []

  // If the assistant message has reasoning_opaque, emit a reasoning item
  if (msg.reasoning_opaque) {
    items.push({
      type: "reasoning",
      summary:
        msg.reasoning_text ?
          [{ type: "summary_text", text: msg.reasoning_text }]
        : [],
      encrypted_content: msg.reasoning_opaque,
    })
  }

  // If there are tool_calls, emit each as a function_call item
  if (msg.tool_calls && msg.tool_calls.length > 0) {
    // Emit an assistant message with the text content (if any)
    const text = extractTextContent(msg.content)
    if (text) {
      items.push({
        type: "message",
        role: "assistant",
        content: text,
      } as ResponseInputMessage)
    }

    for (const tc of msg.tool_calls) {
      items.push({
        type: "function_call",
        call_id: tc.id,
        name: tc.function.name,
        arguments: tc.function.arguments,
        status: "completed",
      })
    }
  } else {
    items.push({
      type: "message",
      role: "assistant",
      content: translateContent(msg.content, "output_text"),
    } as ResponseInputMessage)
  }

  return items
}

function translateContent(
  content: string | Array<ContentPart> | null,
  textType: "input_text" | "output_text",
): string | Array<ResponseInputContent> {
  if (content === null) {
    return ""
  }
  if (typeof content === "string") {
    return content
  }

  const parts: Array<ResponseInputContent> = []
  for (const part of content) {
    if (part.type === "text") {
      parts.push({ type: textType, text: part.text } as ResponseInputText)
    } else {
      parts.push({
        type: "input_image",
        image_url: part.image_url.url,
        detail: part.image_url.detail ?? "auto",
      })
    }
  }
  return parts.length > 0 ? parts : ""
}

function extractTextContent(
  content: string | Array<ContentPart> | null,
): string {
  if (content === null) return ""
  if (typeof content === "string") return content
  return content
    .filter((p): p is { type: "text"; text: string } => p.type === "text")
    .map((p) => p.text)
    .join("\n\n")
}

// ---------------------------------------------------------------------------
// Tool translation
// ---------------------------------------------------------------------------

function translateTools(
  tools: ChatCompletionsPayload["tools"],
): Array<ResponsesTool> | null {
  if (!tools || tools.length === 0) return null

  return tools.map((t) => ({
    type: "function" as const,
    name: t.function.name,
    description: t.function.description ?? null,
    parameters: normalizeSchema(t.function.parameters),
    strict: false,
  }))
}

function normalizeSchema(
  schema: Record<string, unknown>,
): Record<string, unknown> {
  if (schema.type === "object" && !schema.properties) {
    return { ...schema, properties: {} }
  }
  return schema
}

function translateToolChoice(
  choice: ChatCompletionsPayload["tool_choice"],
): ResponsesPayload["tool_choice"] {
  if (!choice) return "auto"
  if (typeof choice === "string") return choice
  if (choice.function.name) {
    return { type: "function", name: choice.function.name }
  }
  return "auto"
}

// ---------------------------------------------------------------------------
// Result translation: ResponsesResult → ChatCompletionResponse
// ---------------------------------------------------------------------------

export function translateResponsesResultToChatCompletion(
  result: ResponsesResult,
): ChatCompletionResponse {
  const textContent = collectOutputText(result.output)
  const toolCalls = collectToolCalls(result.output)
  const reasoningText = collectReasoningText(result.output)

  const finishReason = mapFinishReason(result)

  return {
    id: result.id,
    object: "chat.completion",
    created: result.created_at,
    model: result.model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: textContent || null,
          ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
          ...(reasoningText ? { reasoning_text: reasoningText } : {}),
        },
        logprobs: null,
        finish_reason: finishReason,
      },
    ],
    usage:
      result.usage ?
        {
          prompt_tokens: result.usage.input_tokens,
          completion_tokens: result.usage.output_tokens ?? 0,
          total_tokens: result.usage.total_tokens,
          ...(result.usage.input_tokens_details ?
            {
              prompt_tokens_details: {
                cached_tokens: result.usage.input_tokens_details.cached_tokens,
              },
            }
          : {}),
        }
      : undefined,
  }
}

function collectOutputText(output: Array<ResponseOutputItem>): string {
  const segments: Array<string> = []
  const messages = output.filter(
    (item): item is ResponseOutputMessage => item.type === "message",
  )
  for (const msg of messages) {
    if (!msg.content) continue
    for (const block of msg.content) {
      if ("text" in block && typeof block.text === "string") {
        segments.push(block.text)
      }
      if ("refusal" in block && typeof block.refusal === "string") {
        segments.push(block.refusal)
      }
    }
  }
  return segments.join("")
}

function collectToolCalls(output: Array<ResponseOutputItem>): Array<ToolCall> {
  const calls: Array<ToolCall> = []
  for (const item of output) {
    if (item.type === "function_call") {
      calls.push({
        id: item.call_id,
        type: "function",
        function: {
          name: item.name,
          arguments: item.arguments,
        },
      })
    }
  }
  return calls
}

function collectReasoningText(
  output: Array<ResponseOutputItem>,
): string | undefined {
  const parts: Array<string> = []
  const reasoningItems = output.filter(
    (item): item is ResponseOutputReasoning => item.type === "reasoning",
  )
  for (const reasoning of reasoningItems) {
    if (!reasoning.summary) continue
    for (const block of reasoning.summary) {
      if (block.text) parts.push(block.text)
    }
  }
  return parts.length > 0 ? parts.join("\n\n") : undefined
}

function mapFinishReason(
  result: ResponsesResult,
): "stop" | "length" | "tool_calls" | "content_filter" {
  if (result.status === "completed") {
    const hasToolCalls = result.output.some(
      (item) => item.type === "function_call",
    )
    return hasToolCalls ? "tool_calls" : "stop"
  }

  if (result.status === "incomplete") {
    if (result.incomplete_details?.reason === "max_output_tokens") {
      return "length"
    }
    if (result.incomplete_details?.reason === "content_filter") {
      return "content_filter"
    }
  }

  return "stop"
}

// ---------------------------------------------------------------------------
// Stream translation: ResponseStreamEvent → SSE data strings
//
// Converts Responses API stream events into OpenAI chat.completion.chunk
// events so the caller can emit them as SSE.
// ---------------------------------------------------------------------------

export interface ChatCompletionStreamState {
  responseId: string
  model: string
  created: number
  outputIndexToToolCallIndex: Map<number, number>
  nextToolCallIndex: number
  firstChunkSent: boolean
}

export function createChatCompletionStreamState(): ChatCompletionStreamState {
  return {
    responseId: "",
    model: "",
    created: 0,
    outputIndexToToolCallIndex: new Map(),
    nextToolCallIndex: 0,
    firstChunkSent: false,
  }
}

/**
 * Translates a single Responses API stream event into zero or more
 * SSE `data:` payloads in OpenAI chat.completion.chunk format.
 */
export function translateResponsesStreamEventToChatCompletionChunks(
  event: ResponseStreamEvent,
  state: ChatCompletionStreamState,
): Array<string> {
  switch (event.type) {
    case "response.created": {
      state.responseId = event.response.id
      state.model = event.response.model
      state.created = event.response.created_at
      // Emit initial chunk with role
      if (!state.firstChunkSent) {
        state.firstChunkSent = true
        return [
          buildChunkJson(state, {
            role: "assistant",
            content: "",
          }),
        ]
      }
      return []
    }

    case "response.output_text.delta": {
      return [buildChunkJson(state, { content: event.delta })]
    }

    case "response.reasoning_summary_text.delta": {
      return [buildChunkJson(state, { reasoning_text: event.delta })]
    }

    case "response.output_item.added": {
      if (event.item.type === "function_call") {
        const tcIdx = state.nextToolCallIndex++
        state.outputIndexToToolCallIndex.set(event.output_index, tcIdx)
        return [
          buildChunkJson(state, {
            tool_calls: [
              {
                index: tcIdx,
                id: event.item.call_id,
                type: "function" as const,
                function: { name: event.item.name, arguments: "" },
              },
            ],
          }),
        ]
      }
      return []
    }

    case "response.function_call_arguments.delta": {
      const tcIdx = state.outputIndexToToolCallIndex.get(event.output_index)
      if (tcIdx === undefined) return []
      return [
        buildChunkJson(state, {
          tool_calls: [
            {
              index: tcIdx,
              function: { arguments: event.delta },
            },
          ],
        }),
      ]
    }

    case "response.completed":
    case "response.incomplete": {
      const finishReason = mapFinishReason(event.response)
      return [buildChunkJson(state, null, finishReason)]
    }

    case "response.failed":
    case "error": {
      return [buildChunkJson(state, null, "stop")]
    }

    default: {
      return []
    }
  }
}

function buildChunkJson(
  state: ChatCompletionStreamState,
  delta: Record<string, unknown> | null,
  finishReason?: string,
): string {
  return JSON.stringify({
    id: state.responseId || "chatcmpl-bridge",
    object: "chat.completion.chunk",
    created: state.created || Math.floor(Date.now() / 1000),
    model: state.model || "",
    choices: [
      {
        index: 0,
        delta: delta ?? {},
        finish_reason: finishReason ?? null,
        logprobs: null,
      },
    ],
  })
}
