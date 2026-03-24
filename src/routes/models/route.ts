import { Hono } from "hono"
import consola from "consola"
import { readFileSync, existsSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import {
  MODEL_MAPPINGS,
  type ModelMappingEntry,
} from "~/lib/augment-models"
import { forwardError } from "~/lib/error"
import {
  getCopilotTokenForRequest,
  GITHUB_TOKEN_HEADER,
} from "~/lib/request-token"
import { state } from "~/lib/state"
import { cacheModels } from "~/lib/utils"

// Load base Augment response (contains all feature flags)
const __dirname = dirname(fileURLToPath(import.meta.url))
let baseAugmentResponse: Record<string, unknown> | null = null

// Path to shared announcement file
const announcementPath = join(__dirname, "../../data/announcement.json")

function getActiveAnnouncement(): string {
  try {
    if (!existsSync(announcementPath)) {
      return ""
    }
    const data = JSON.parse(readFileSync(announcementPath, "utf-8")) as {
      message?: string
      isActive?: boolean
    }
    return data.isActive ? (data.message || "") : ""
  } catch (error) {
    consola.warn("Error reading announcement file:", error)
    return ""
  }
}

function loadBaseResponse() {
  const possiblePaths = [
    join(__dirname, "../data/augment_base_response.json"),
    join(process.cwd(), "src/data/augment_base_response.json"),
    join(process.cwd(), "data/augment_base_response.json"),
  ]

  for (const p of possiblePaths) {
    if (existsSync(p)) {
      try {
        baseAugmentResponse = JSON.parse(readFileSync(p, "utf-8"))
        consola.info(`Loaded base Augment response from: ${p}`)
        return
      } catch (e) {
        consola.warn(`Failed to parse ${p}:`, e)
      }
    }
  }
  consola.warn("Could not load base Augment response, using minimal response")
}
loadBaseResponse()

export const modelRoutes = new Hono()

// OpenAI-compatible GET /models
modelRoutes.get("/", async (c) => {
  try {
    const githubToken = c.req.header(GITHUB_TOKEN_HEADER)
    let copilotToken: string | null = null

    if (githubToken) {
      copilotToken = await getCopilotTokenForRequest(githubToken)
    }

    if (!state.models) {
      if (copilotToken) {
        await cacheModels(copilotToken)
      } else if (state.copilotToken) {
        await cacheModels()
      } else {
        consola.warn("[MODELS] No token available to fetch models")
        return c.json({
          object: "list",
          data: [],
          has_more: false,
        })
      }
    }

    const models = state.models?.data.map((model) => ({
      ...model,
      id: model.id,
      object: "model",
      type: "model",
      created: 0,
      created_at: new Date(0).toISOString(),
      owned_by: model.vendor,
      display_name: model.name,
    }))

    return c.json({
      object: "list",
      data: models,
      has_more: false,
    })
  } catch (error) {
    return await forwardError(c, error)
  }
})

// Augment-compatible POST /models (for /get-models)
modelRoutes.post("/", async (c) => {
  try {
    const githubToken = c.req.header(GITHUB_TOKEN_HEADER)
    let copilotToken: string | null = null

    if (githubToken) {
      copilotToken = await getCopilotTokenForRequest(githubToken)
    }

    if (!state.models) {
      try {
        if (copilotToken) {
          await cacheModels(copilotToken)
        } else if (state.copilotToken) {
          await cacheModels()
        }
      } catch (modelError) {
        consola.error("Failed to cache models:", modelError)
      }
    }

    const modelInfoRegistry = buildAugmentModelRegistry()
    const clientAnnouncement = getActiveAnnouncement()

    if (baseAugmentResponse) {
      const response = { ...baseAugmentResponse }
      const featureFlags = {
        ...(baseAugmentResponse.feature_flags as Record<string, unknown>),
        model_info_registry: JSON.stringify(modelInfoRegistry),
        client_announcement: clientAnnouncement,
      }
      response.feature_flags = featureFlags
      return c.json(response)
    }

    return c.json({
      default_model: "72b7b85098e1eda953085426d45be0618d863f3a9296850280c6f7e6ffb09509",
      models: generateHashedModels(),
      languages: getLanguages(),
      feature_flags: getFeatureFlags(modelInfoRegistry, clientAnnouncement),
      user_tier: "PROFESSIONAL_TIER",
      user: {
        id: "copilot-proxy-user",
        email: "copilot@proxy.local",
        tenant_id: "copilot-proxy",
        tenant_name: "copilot-proxy",
        created_at: new Date().toISOString(),
      },
    })
  } catch (error) {
    return await forwardError(c, error)
  }
})

function generateHashedModels() {
  const hashes = [
    "72b7b85098e1eda953085426d45be0618d863f3a9296850280c6f7e6ffb09509",
    "21fc800624d391122ce3b54ffdc1b66fb84c36dda16e0a8cb699f9a159aa4d50",
    "8543331b6c0e79fe107d12d839cfa76d91a2c17b07f8e0f26557f83acad14908",
  ]
  return hashes.map((hash, i) => ({
    suggested_prefix_char_count: i === 0 ? 9216 : 0,
    suggested_suffix_char_count: i === 0 ? 9216 : 0,
    max_memorize_size_bytes: 131072,
    name: hash,
    internal_name: null,
    is_default: i === 0,
  }))
}

function getLanguages() {
  return [
    { name: "TypeScript", vscode_name: "typescript", extensions: [".ts", ".tsx"] },
    { name: "JavaScript", vscode_name: "javascript", extensions: [".js", ".jsx"] },
    { name: "Python", vscode_name: "python", extensions: [".py"] },
    { name: "Go", vscode_name: "go", extensions: [".go"] },
    { name: "Rust", vscode_name: "rust", extensions: [".rs"] },
    { name: "Java", vscode_name: "java", extensions: [".java"] },
    { name: "C++", vscode_name: "cpp", extensions: [".cpp", ".cc", ".h", ".hpp"] },
    { name: "C#", vscode_name: "csharp", extensions: [".cs"] },
    { name: "Ruby", vscode_name: "ruby", extensions: [".rb"] },
    { name: "PHP", vscode_name: "php", extensions: [".php"] },
  ]
}

function getFeatureFlags(modelInfoRegistry: Record<string, AugmentModelInfo>, clientAnnouncement: string = "") {
  return {
    enable_code_edits: true,
    enable_chat: true,
    enable_workspace_manager_ui: false,
    enable_instructions: true,
    enable_smart_paste: false,
    enable_view_text_document: true,
    checkpoint_blobs_v2: true,
    enable_data_collection: false,
    bypass_language_filter: true,
    enable_hindsight: false,
    enable_external_sources_in_chat: true,
    enable_summary_titles: true,
    enable_guidelines: true,
    enable_sentry: false,
    client_deprecated: false,
    enable_parallel_tools: true,
    model_info_registry: JSON.stringify(modelInfoRegistry),
    client_announcement: clientAnnouncement,
    agent_chat_model: "claude-sonnet-4-5-200k-v13-c4-p2-agent",
  }
}

function buildAugmentModelRegistry(): Record<string, AugmentModelInfo> {
  const registry: Record<string, AugmentModelInfo> = {}
  const copilotModels = state.models?.data ?? []
  const availableIds = new Set(copilotModels.map((m) => m.id))

  if (copilotModels.length === 0) {
    consola.warn("No Copilot models available, using fallback model registry")
    for (const mapping of MODEL_MAPPINGS) {
      registry[mapping.augmentName] = buildRegistryEntry(mapping)
    }
    return registry
  }

  for (const mapping of MODEL_MAPPINGS) {
    if (availableIds.has(mapping.copilotId)) {
      registry[mapping.augmentName] = buildRegistryEntry(mapping)
    } else {
      consola.warn(`Model ${mapping.copilotId} not available in Copilot, skipping ${mapping.displayName}`)
    }
  }

  return registry
}

function buildRegistryEntry(mapping: ModelMappingEntry): AugmentModelInfo {
  const entry: AugmentModelInfo = {
    description: mapping.description,
    disabled: false,
    displayName: mapping.displayName,
    shortName: mapping.shortName,
  }

  if (mapping.modelGroupPriority !== undefined) {
    entry.modelGroupPriority = mapping.modelGroupPriority
  }
  if (mapping.priority !== undefined) {
    entry.priority = mapping.priority
  }
  if (mapping.isDefault) {
    entry.isDefault = true
  }
  if (mapping.isLegacyModel) {
    entry.isLegacyModel = true
  }
  if (mapping.isNew) {
    entry.isNew = true
  }

  return entry
}

interface AugmentModelInfo {
  description: string
  disabled: boolean
  displayName: string
  modelGroupPriority?: number
  priority?: number
  shortName: string
  isDefault?: boolean
  isLegacyModel?: boolean
  isNew?: boolean
}
