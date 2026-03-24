/**
 * Augment API Types
 *
 * These types define the format used by the Augment VSCode extension
 * for communicating with the Augment backend.
 */

// ============================================================================
// Request Types
// ============================================================================

/**
 * Augment chat stream request format
 */
export interface AugmentChatRequest {
  /** Current user message */
  message: string

  /** Model identifier (e.g., "claude-sonnet-4-5") */
  model: string | null

  /** Chat history - previous messages */
  chat_history: AugmentChatHistoryItem[]

  /** Chat mode */
  mode: "CHAT" | "AGENT" | string

  /** Whether to stream the response */
  stream: boolean

  /** Prefix for completion (code completion mode) */
  prefix: string | null

  /** Suffix for completion (code completion mode) */
  suffix: string | null

  /** Selected code context */
  selected_code: string | null

  /** Programming language */
  lang: string | null

  /** Binary blobs (images, etc.) */
  blobs: AugmentBlob[]

  /** User-defined guidelines */
  user_guidelines: string | null

  /** Workspace-specific guidelines */
  workspace_guidelines: string | null

  /** Tool definitions available to the model */
  tool_definitions: AugmentToolDefinition[]

  /** Context nodes (files, symbols, etc.) */
  nodes: AugmentNode[]

  /** Conversation ID for tracking */
  conversation_id?: string

  /** Request ID */
  request_id?: string
}

/**
 * Chat history item - contains both request and response
 */
export interface AugmentChatHistoryItem {
  /** User's message in this turn */
  request_message: string

  /** Assistant's response text */
  response_text: string

  /** Request ID for this turn */
  request_id: string

  /** Context nodes provided in the request */
  request_nodes: AugmentNode[]

  /** Response nodes (including tool uses) */
  response_nodes: AugmentResponseNode[]
}

/**
 * Tool definition in Augment format
 */
export interface AugmentToolDefinition {
  /** Tool name */
  name: string

  /** Tool description */
  description: string

  /** JSON schema for parameters */
  parameters: {
    type: "object"
    properties: Record<string, AugmentToolParameter>
    required?: string[]
  }
}

/**
 * Tool parameter schema
 */
export interface AugmentToolParameter {
  type: "string" | "number" | "boolean" | "array" | "object"
  description?: string
  enum?: string[]
  items?: AugmentToolParameter
  properties?: Record<string, AugmentToolParameter>
}

/**
 * Binary blob (for images, etc.)
 */
export interface AugmentBlob {
  name: string
  data: string // base64 encoded
  mime_type: string
}

/**
 * Context node (file, symbol, etc.)
 */
export interface AugmentNode {
  id: number
  type: AugmentNodeType
  content: string
  path?: string
  name?: string
}

/**
 * Node types
 */
export const AugmentNodeType = {
  TEXT: 0,
  FILE: 1,
  SYMBOL: 2,
  DIRECTORY: 3,
  URL: 4,
  IMAGE: 5,
} as const
export type AugmentNodeType =
  (typeof AugmentNodeType)[keyof typeof AugmentNodeType]

// ============================================================================
// Response Types
// ============================================================================

/**
 * Augment streaming response chunk (NDJSON format)
 */
export interface AugmentStreamChunk {
  /** Incremental text content */
  text: string

  /** Full response text (for final chunk) */
  response_text?: string

  /** Request ID (echoed from request header) */
  request_id?: string

  /** Stop reason: null while streaming, 1 when complete, 2 for tool_use */
  stop_reason: number | null

  /** Unknown blob names (for error handling) */
  unknown_blob_names: string[]

  /** Whether checkpoint was not found */
  checkpoint_not_found: boolean

  /** Workspace file chunks */
  workspace_file_chunks: unknown[]

  /** External sources incorporated */
  incorporated_external_sources: unknown[]

  /** Response nodes (includes tool uses on final chunk) */
  nodes: AugmentResponseNode[]
}

/**
 * Response node - can be text or tool use
 * Supports both flat format (content, tool_use) and nested format (text_node, tool_use_node)
 */
export interface AugmentResponseNode {
  /** Node ID */
  id: number

  /** Node type (0 = text, 5 = tool_use, 2 = tool_result, 3 = sentinel, 8 = thinking) */
  type: AugmentResponseNodeType

  // Flat format (for compatibility)
  /** Text content (for text nodes) - flat format */
  content?: string | null

  /** Tool use information (for tool_use nodes) - flat format */
  tool_use?: AugmentToolUse | null

  /** Thinking content (for thinking nodes) - flat format */
  thinking?: AugmentThinking | string | null

  // Nested format (matches request format)
  /** Text node content (for type 0) - nested format */
  text_node?: { content: string }

  /** Tool use node (for type 5) - nested format */
  tool_use_node?: AugmentToolUse

  /** Tool result node (for type 2) - nested format */
  tool_result_node?: AugmentToolResult

  /** Thinking node (for type 8) - nested format */
  thinking_node?: AugmentThinking

  // Metadata fields
  billing_metadata?: unknown
  metadata?: { openai_id: string | null; google_ts: string | null; provider: string | null } | null
  token_usage?: unknown
}

/**
 * Thinking node content (for Gemini extended thinking / Claude thinking)
 */
export interface AugmentThinking {
  /** Visible thinking summary */
  summary: string
  /** Encrypted/opaque content - required for Gemini tool results */
  encrypted_content: string
  /** Plaintext content (usually null when encrypted_content is present) */
  content: string | null
  /** OpenAI responses API item ID */
  openai_responses_api_item_id: string | null
}

/**
 * Response node types
 */
export const AugmentResponseNodeType = {
  TEXT: 0,
  TOOL_USE: 5,
  TOOL_RESULT: 2,
  SENTINEL: 3,
  THINKING: 8,
} as const
export type AugmentResponseNodeType =
  (typeof AugmentResponseNodeType)[keyof typeof AugmentResponseNodeType]

/**
 * Tool use in response
 */
export interface AugmentToolUse {
  /** Tool call ID (for correlating with tool results) */
  id?: string
  tool_use_id: string

  /** Tool name */
  name?: string
  tool_name: string

  /** Tool arguments as JSON string or object */
  arguments?: string | Record<string, unknown>
  input_json: string

  /** Whether this is a partial tool call (streaming) */
  is_partial?: boolean
}

/**
 * Tool result in chat history
 */
export interface AugmentToolResult {
  /** Tool call ID this result corresponds to */
  tool_use_id: string

  /** Result content */
  content: string

  /** Whether the tool execution resulted in an error */
  is_error?: boolean
}

// ============================================================================
// Transformation Utilities
// ============================================================================

import type {
  Message,
  Tool,
  ToolCall,
} from "~/services/copilot/create-chat-completions"

/**
 * Transform Augment tool definitions to OpenAI tools format
 */
export function transformToolDefinitionsToOpenAI(
  toolDefinitions: AugmentToolDefinition[] | undefined,
): Tool[] | undefined {
  if (!toolDefinitions || toolDefinitions.length === 0) {
    return undefined
  }

  return toolDefinitions.map((tool) => ({
    type: "function" as const,
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters as Record<string, unknown>,
    },
  }))
}

/**
 * Transform Augment chat history to OpenAI messages format
 *
 * Note: Tool results are found in the NEXT chat history item's request_nodes (type 1),
 * or in the current request's nodes field for the last chat history item.
 */
export function transformChatHistoryToMessages(
  chatHistory: AugmentChatHistoryItem[] | undefined,
  currentMessage: string,
  currentRequestNodes?: AugmentNode[],
): Message[] {
  const messages: Message[] = []

  if (chatHistory && chatHistory.length > 0) {
    for (let i = 0; i < chatHistory.length; i++) {
      const item = chatHistory[i]
      const nextItem = chatHistory[i + 1]
      const isLastItem = i === chatHistory.length - 1

      // Add user message
      if (item.request_message) {
        messages.push({
          role: "user",
          content: item.request_message,
        })
      }

      // Check for tool uses in response nodes (check both nested and flat formats)
      const toolUseNodes =
        item.response_nodes?.filter(
          (node) =>
            node.type === AugmentResponseNodeType.TOOL_USE
            && (node.tool_use_node || node.tool_use),
        ) || []

      if (toolUseNodes.length > 0) {
        // Assistant message with tool calls
        const toolCalls: ToolCall[] = toolUseNodes.map((node, index) => {
          const toolUse = node.tool_use_node || node.tool_use
          if (!toolUse) {
            return {
              id: `call_${index}`,
              type: "function" as const,
              function: { name: "unknown_tool", arguments: "{}" },
            }
          }
          return {
            id: toolUse.tool_use_id || toolUse.id || `call_${index}`,
            type: "function" as const,
            function: {
              name: toolUse.tool_name || toolUse.name || "unknown_tool",
              arguments:
                typeof toolUse.input_json === "string"
                  ? toolUse.input_json
                  : typeof toolUse.arguments === "string"
                    ? toolUse.arguments
                    : JSON.stringify(toolUse.arguments || {}),
            },
          }
        })

        // Get text content from text nodes
        const textContent =
          item.response_nodes
            ?.filter(
              (node) =>
                node.type === AugmentResponseNodeType.TEXT
                && (node.text_node?.content || node.content),
            )
            .map((node) => node.text_node?.content || node.content || "")
            .join("") || ""

        messages.push({
          role: "assistant",
          content: textContent,
          tool_calls: toolCalls,
        })

        // Tool results are in the NEXT chat history item's request_nodes
        const toolResultsFound: Map<string, string> = new Map()

        if (nextItem?.request_nodes) {
          for (const node of nextItem.request_nodes) {
            if (node && typeof node === "object" && node.type === 1) {
              const toolResult = (node as unknown as AugmentResponseNode)
                .tool_result_node || node
              const toolUseId =
                (toolResult as unknown as AugmentToolResult)?.tool_use_id || ""
              const resultContent =
                (toolResult as unknown as AugmentToolResult)?.content
                || node.content
                || ""
              if (toolUseId) {
                toolResultsFound.set(toolUseId, resultContent)
              }
            }
          }
        }

        if (isLastItem && currentRequestNodes) {
          for (const node of currentRequestNodes) {
            if (node && typeof node === "object" && node.type === 1) {
              const toolResult = (node as unknown as AugmentResponseNode)
                .tool_result_node || node
              const toolUseId =
                (toolResult as unknown as AugmentToolResult)?.tool_use_id || ""
              const resultContent =
                (toolResult as unknown as AugmentToolResult)?.content
                || node.content
                || ""
              if (toolUseId) {
                toolResultsFound.set(toolUseId, resultContent)
              }
            }
          }
        }

        // Add tool results for each tool call
        for (const tc of toolCalls) {
          const resultContent = toolResultsFound.get(tc.id)
          messages.push({
            role: "tool",
            tool_call_id: tc.id,
            content:
              resultContent ?? "[Tool execution result not available]",
          })
        }
      } else if (item.response_text) {
        messages.push({
          role: "assistant",
          content: item.response_text,
        })
      }
    }
  }

  // Add current user message
  if (currentMessage) {
    messages.push({
      role: "user",
      content: currentMessage,
    })
  }

  return messages
}

/**
 * Transform OpenAI tool calls to Augment response nodes
 */
export function transformToolCallsToNodes(
  toolCalls: ToolCall[] | undefined,
  textContent: string,
  startNodeId: number = 1,
): AugmentResponseNode[] {
  const nodes: AugmentResponseNode[] = []
  let nodeId = startNodeId

  if (toolCalls && toolCalls.length > 0) {
    for (const toolCall of toolCalls) {
      const toolUseId = nodeId

      // THINKING node (type 8)
      const thinkingToolUse: AugmentToolUse = {
        tool_use_id: toolCall.id,
        tool_name: toolCall.function.name,
        input_json: "",
        is_partial: false,
        id: toolCall.id,
        name: toolCall.function.name,
        arguments: "",
      }
      nodes.push({
        id: toolUseId,
        type: AugmentResponseNodeType.THINKING,
        content: "",
        tool_use: thinkingToolUse,
        thinking: null,
        billing_metadata: null,
        metadata: { openai_id: null, google_ts: null, provider: null },
        token_usage: null,
      })

      // TOOL_USE node (type 5)
      const toolUseData: AugmentToolUse = {
        tool_use_id: toolCall.id,
        tool_name: toolCall.function.name,
        input_json: toolCall.function.arguments,
        is_partial: false,
        id: toolCall.id,
        name: toolCall.function.name,
        arguments: toolCall.function.arguments,
      }
      nodes.push({
        id: toolUseId,
        type: AugmentResponseNodeType.TOOL_USE,
        content: "",
        tool_use: toolUseData,
        thinking: null,
        billing_metadata: null,
        metadata: { openai_id: null, google_ts: null, provider: null },
        token_usage: null,
        tool_use_node: toolUseData,
      })

      nodeId++
    }
  }

  // TEXT node with the full content
  if (textContent) {
    nodes.push({
      id: nodeId++,
      type: AugmentResponseNodeType.TEXT,
      content: textContent,
      tool_use: null,
      thinking: null,
      billing_metadata: null,
      metadata: { openai_id: null, google_ts: null, provider: null },
      token_usage: null,
      text_node: { content: textContent },
    })
  }

  if (nodes.length === 0) {
    nodes.push({
      id: nodeId++,
      type: AugmentResponseNodeType.TEXT,
      content: "",
      tool_use: null,
      thinking: null,
      billing_metadata: null,
      metadata: { openai_id: null, google_ts: null, provider: null },
      token_usage: null,
      text_node: { content: "" },
    })
  }

  return nodes
}

/**
 * Create the TOOL_RESULT placeholder node (type 2)
 */
export function createToolResultNode(nodeId: number): AugmentResponseNode {
  return {
    id: nodeId,
    type: AugmentResponseNodeType.TOOL_RESULT,
    content: "",
    tool_use: null,
    thinking: null,
    billing_metadata: null,
    metadata: { openai_id: null, google_ts: null, provider: null },
    token_usage: null,
  }
}

/**
 * Create the SENTINEL/metadata node (type 3)
 */
export function createSentinelNode(nodeId: number): AugmentResponseNode {
  return {
    id: nodeId,
    type: AugmentResponseNodeType.SENTINEL,
    content: "",
    tool_use: null,
    thinking: null,
    billing_metadata: null,
    metadata: null,
    token_usage: null,
  }
}

/**
 * Create an Augment streaming chunk
 */
export function createAugmentStreamChunk(
  text: string,
  stopReason: number | null,
  nodes: AugmentResponseNode[] = [],
  responseText?: string,
  requestId?: string,
): AugmentStreamChunk {
  const chunk: AugmentStreamChunk = {
    text,
    stop_reason: stopReason,
    unknown_blob_names: [],
    checkpoint_not_found: false,
    workspace_file_chunks: [],
    incorporated_external_sources: [],
    nodes,
  }

  if (responseText !== undefined) {
    chunk.response_text = responseText
  }

  if (requestId !== undefined) {
    chunk.request_id = requestId
  }

  return chunk
}

/**
 * Determine stop reason from OpenAI finish_reason
 */
export function getAugmentStopReason(
  finishReason: "stop" | "length" | "tool_calls" | "content_filter" | null,
): number | null {
  if (finishReason === null) {
    return null
  }

  switch (finishReason) {
    case "stop":
      return 1
    case "tool_calls":
      return 3
    case "length":
      return 3
    case "content_filter":
      return 1
    default:
      return 1
  }
}
