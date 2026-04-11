/**
 * Augment Model Name Translation
 *
 * Maps Augment-style model names to Copilot-compatible model IDs.
 * Works alongside upstream's findEndpointModel() for standard model resolution.
 */

import consola from "consola"

/**
 * Model mapping entry interface
 */
export interface ModelMappingEntry {
  augmentName: string
  copilotId: string
  displayName: string
  shortName: string
  description: string
  priority?: number
  modelGroupPriority?: number
  isDefault?: boolean
  isLegacyModel?: boolean
  isNew?: boolean
}

/**
 * Single source of truth for model mappings.
 * Used for both translation and building the Augment model registry.
 */
export const MODEL_MAPPINGS: ModelMappingEntry[] = [
  // === Main Models (modelGroupPriority: 1) ===
  {
    augmentName: "claude-opus-4-6",
    copilotId: "claude-opus-4.6",
    displayName: "Claude Opus 4.6",
    shortName: "opus4.6",
    description: "Most capable Anthropic model",
    priority: 1,
    modelGroupPriority: 1,
    isNew: true,
  },
  {
    augmentName: "claude-sonnet-4-6",
    copilotId: "claude-sonnet-4.6",
    displayName: "Claude Sonnet 4.6",
    shortName: "sonnet4.6",
    description: "Great for everyday tasks",
    priority: 2,
    modelGroupPriority: 1,
    isDefault: true,
  },
  {
    augmentName: "claude-haiku-4-5",
    copilotId: "claude-haiku-4.5",
    displayName: "Haiku 4.5",
    shortName: "haiku4.5",
    description: "Fast and efficient responses",
    priority: 3,
    modelGroupPriority: 1,
  },
  {
    augmentName: "gpt-5-4",
    copilotId: "gpt-5.4",
    displayName: "GPT-5.4",
    shortName: "gpt5.4",
    description: "Latest OpenAI model",
    priority: 4,
    modelGroupPriority: 1,
    isNew: true,
  },
  {
    augmentName: "gpt-5-4-mini",
    copilotId: "gpt-5.4-mini",
    displayName: "GPT-5.4 Mini",
    shortName: "gpt5.4mini",
    description: "Lightweight and fast",
    priority: 5,
    modelGroupPriority: 1,
    isNew: true,
  },
  {
    augmentName: "gpt-5-3-codex",
    copilotId: "gpt-5.3-codex",
    displayName: "GPT-5.3 Codex",
    shortName: "codex5.3",
    description: "Advanced code generation",
    priority: 6,
    modelGroupPriority: 1,
    isNew: true,
  },
  {
    augmentName: "gpt-5-2-codex",
    copilotId: "gpt-5.2-codex",
    displayName: "GPT-5.2 Codex",
    shortName: "codex5.2",
    description: "Code generation",
    priority: 7,
    modelGroupPriority: 1,
  },
  {
    augmentName: "gpt-5-2",
    copilotId: "gpt-5.2",
    displayName: "GPT-5.2",
    shortName: "gpt5.2",
    description: "Strong reasoning and planning",
    priority: 8,
    modelGroupPriority: 1,
  },
  {
    augmentName: "gemini-3-1-pro",
    copilotId: "gemini-3.1-pro-preview",
    displayName: "Gemini 3.1 Pro",
    shortName: "gemini3.1",
    description: "Advanced reasoning and analysis",
    priority: 9,
    modelGroupPriority: 1,
    isNew: true,
  },
  {
    augmentName: "gpt-5-mini",
    copilotId: "gpt-5-mini",
    displayName: "GPT-5 Mini",
    shortName: "gpt5mini",
    description: "Free tier model",
    priority: 10,
    modelGroupPriority: 1,
  },
  // === More Section (isLegacyModel: true) ===
  {
    augmentName: "gpt-5-1",
    copilotId: "gpt-5.1",
    displayName: "GPT-5.1",
    shortName: "gpt5.1",
    description: "Deprecating April 15",
    isLegacyModel: true,
  },
  {
    augmentName: "gemini-3-flash",
    copilotId: "gemini-3-flash-preview",
    displayName: "Gemini 3 Flash",
    shortName: "gemflash3",
    description: "Fast Gemini model",
    isLegacyModel: true,
  },
  {
    augmentName: "gemini-2-5-pro",
    copilotId: "gemini-2.5-pro",
    displayName: "Gemini 2.5 Pro",
    shortName: "gem2.5",
    description: "Gemini reasoning model",
    isLegacyModel: true,
  },
  {
    augmentName: "gpt-4-1",
    copilotId: "gpt-4.1",
    displayName: "GPT-4.1",
    shortName: "gpt4.1",
    description: "1M context size",
    isLegacyModel: true,
  },
  {
    augmentName: "groq-code-fast-1",
    copilotId: "grok-code-fast-1",
    displayName: "Grok Code Fast",
    shortName: "grokfast",
    description: "Quick code generation",
    isLegacyModel: true,
  },
  {
    augmentName: "internal-model",
    copilotId: "oswe-vscode-secondary",
    displayName: "Internal Model",
    shortName: "internal",
    description: "Internal testing model",
    isLegacyModel: true,
  },
]

/**
 * Augment model name to Copilot model ID mapping.
 */
const AUGMENT_TO_COPILOT_MAP: Record<string, string> = {
  ...Object.fromEntries(
    MODEL_MAPPINGS.map((m) => [m.augmentName, m.copilotId]),
  ),
  // Additional aliases
  "gpt-5": "gpt-5.1",
  "gemini-3.0": "gemini-3-pro-preview",
  "gemini-3": "gemini-3-pro-preview",
  "gemini-2.5": "gemini-2.5-pro",
  // Version-suffixed models
  "claude-sonnet-4-20250514": "claude-haiku-4.5",
  "claude-opus-4-20250514": "claude-opus-4.5",
  "claude-sonnet-4.5-20250514": "claude-sonnet-4.5",
}

/**
 * Translate Augment model names to Copilot-compatible model IDs.
 */
export function translateModelName(
  model: string | null | undefined,
): string {
  if (!model) {
    consola.warn("No model specified, defaulting to claude-sonnet-4.5")
    return "claude-sonnet-4.5"
  }

  consola.debug(`translateModelName called with: "${model}"`)

  const mapped = AUGMENT_TO_COPILOT_MAP[model]
  if (mapped) {
    consola.info(`Model mapped: ${model} -> ${mapped}`)
    return mapped
  }

  // Handle version-suffixed Claude models
  if (model.startsWith("claude-sonnet-4-") && model.length > 16) {
    consola.info(`Model mapped: ${model} -> claude-sonnet-4`)
    return "claude-sonnet-4"
  }
  if (model.startsWith("claude-opus-4-") && model.length > 14) {
    consola.info(`Model mapped: ${model} -> claude-opus-4.5`)
    return "claude-opus-4.5"
  }

  consola.debug(
    `Model "${model}" passed through unchanged (no mapping found)`,
  )
  return model
}

/**
 * Gemini models that require reasoning_opaque preservation for tool results.
 */
export const GEMINI_MODELS = ["gemini-3-pro-preview", "gemini-2.5-pro"]

/**
 * Check if a model is a Gemini model
 */
export function isGeminiModel(model: string | null | undefined): boolean {
  if (!model) return false
  return GEMINI_MODELS.some(
    (g) => model.includes(g) || model.toLowerCase().includes("gemini"),
  )
}
