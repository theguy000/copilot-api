/**
 * User Activity Logger for Copilot API
 *
 * Logs all API activities per-user (by userId) to enable admin dashboard
 * to view user-specific activity logs.
 *
 * Log files are stored in: logs/users/{userId}_{YYYY-MM-DD}.log
 * Format: [timestamp] [level] [category] message | key=value pairs
 */

import {
  existsSync,
  mkdirSync,
  appendFileSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

import consola from "consola"

// Log directory (logs/users/ in project root)
const __dirname = dirname(fileURLToPath(import.meta.url))
const LOG_DIR = join(__dirname, "../../../logs/users")

// Configuration from environment variables
const MAX_LOG_FILE_SIZE = parseInt(
  process.env.MAX_LOG_FILE_SIZE || String(10 * 1024 * 1024),
  10,
) // 10MB default

// Ensure logs directory exists
if (!existsSync(LOG_DIR)) {
  mkdirSync(LOG_DIR, { recursive: true })
}

export type LogLevel = "INFO" | "WARN" | "ERROR"

export type LogCategory =
  | "AUTH"
  | "REQUEST"
  | "RESPONSE"
  | "ERROR"
  | "RATE_LIMIT"
  | "BLOCKED"
  | "SUBSCRIPTION"
  | "INJECT"
  | "REWRITE"
  | "ROUTE"
  | "SAFE_DOMAIN"

export const ALL_LOG_CATEGORIES: LogCategory[] = [
  "AUTH",
  "REQUEST",
  "RESPONSE",
  "ERROR",
  "RATE_LIMIT",
  "BLOCKED",
  "SUBSCRIPTION",
  "INJECT",
  "REWRITE",
  "ROUTE",
  "SAFE_DOMAIN",
]

export interface LogMetadata {
  clientIp?: string
  endpoint?: string
  method?: string
  status?: number
  model?: string
  duration?: number
  tokens?: number
  inputTokens?: number
  outputTokens?: number
  errorType?: string
  errorMessage?: string
  domain?: string
  originalHost?: string
  newHost?: string
  originalPath?: string
  targetPath?: string
  targetHost?: string
  reason?: string
  tokenType?: string
  token?: string
  allowed?: boolean
  remaining?: number
  username?: string
  [key: string]: string | number | boolean | undefined
}

export interface LogEntry {
  timestamp: string
  level: LogLevel
  category: LogCategory
  message: string
  metadata?: LogMetadata
}

function getLogFilePath(userId: string, date: Date = new Date()): string {
  const dateStr = date.toISOString().split("T")[0]
  const safeUserId = userId.replace(/[^a-zA-Z0-9_-]/g, "_")
  return join(LOG_DIR, `${safeUserId}_${dateStr}.log`)
}

function formatLogEntry(entry: LogEntry): string {
  const parts = [
    `[${entry.timestamp}]`,
    `[${entry.level}]`,
    `[${entry.category}]`,
    entry.message,
  ]

  if (entry.metadata && Object.keys(entry.metadata).length > 0) {
    const metadataStr = Object.entries(entry.metadata)
      .filter(([_, v]) => v !== undefined)
      .map(([k, v]) => `${k}=${v}`)
      .join(" | ")
    if (metadataStr) {
      parts.push(`| ${metadataStr}`)
    }
  }

  return parts.join(" ")
}

function truncateIfOversized(logPath: string): void {
  if (MAX_LOG_FILE_SIZE <= 0) return

  try {
    if (!existsSync(logPath)) return

    const stats = statSync(logPath)
    if (stats.size <= MAX_LOG_FILE_SIZE) return

    const content = readFileSync(logPath, "utf-8")
    const midpoint = Math.floor(content.length / 2)
    const nextNewline = content.indexOf("\n", midpoint)

    let truncatedContent: string
    if (nextNewline !== -1) {
      truncatedContent = content.slice(nextNewline + 1)
    } else {
      truncatedContent = content.slice(midpoint)
    }

    writeFileSync(logPath, truncatedContent, "utf-8")
    consola.info(
      `[USER-LOGGER] Truncated oversized log: ${logPath} (${stats.size} -> ${truncatedContent.length} bytes)`,
    )
  } catch (error) {
    consola.error("[USER-LOGGER] Failed to truncate log file:", error)
  }
}

export function logUserActivity(
  userId: string,
  level: LogLevel,
  category: LogCategory,
  message: string,
  metadata?: LogMetadata,
): void {
  if (!userId) {
    consola.debug("[USER-LOGGER] No userId provided, skipping log")
    return
  }

  try {
    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      category,
      message,
      metadata,
    }

    const logLine = formatLogEntry(entry) + "\n"
    const logPath = getLogFilePath(userId)

    truncateIfOversized(logPath)

    appendFileSync(logPath, logLine, "utf-8")
  } catch (error) {
    consola.error("[USER-LOGGER] Failed to write log:", error)
  }
}

export function readUserLogs(
  userId: string,
  date?: string,
  maxLines: number = 100,
): LogEntry[] {
  try {
    const targetDate = date ? new Date(date) : new Date()
    const logPath = getLogFilePath(userId, targetDate)

    if (!existsSync(logPath)) {
      return []
    }

    const content = readFileSync(logPath, "utf-8")
    const lines = content.trim().split("\n").filter(Boolean)

    const entries: LogEntry[] = []
    for (const line of lines.slice(-maxLines)) {
      const parsed = parseLogLine(line)
      if (parsed) {
        entries.push(parsed)
      }
    }

    return entries.reverse()
  } catch (error) {
    consola.error("[USER-LOGGER] Failed to read logs:", error)
    return []
  }
}

function parseLogLine(line: string): LogEntry | null {
  const match = line.match(
    /^\[([\d\-T:.Z]+)\]\s+\[(\w+)\]\s+\[(\w+)\]\s+(.+?)(?:\s+\|\s+(.+))?$/,
  )

  if (!match) return null

  const [, timestamp, level, category, message, metadataStr] = match

  let metadata: LogMetadata | undefined
  if (metadataStr) {
    metadata = {}
    const pairs = metadataStr.split(" | ")
    for (const pair of pairs) {
      const [key, value] = pair.split("=")
      if (key && value !== undefined) {
        const num = Number(value)
        metadata[key] = isNaN(num) ? value : num
      }
    }
  }

  return {
    timestamp,
    level: level as LogLevel,
    category: category as LogCategory,
    message,
    metadata,
  }
}

export function getUserLogDates(userId: string): string[] {
  try {
    const safeUserId = userId.replace(/[^a-zA-Z0-9_-]/g, "_")
    const files = readdirSync(LOG_DIR)
    const dates: string[] = []

    for (const file of files) {
      if (file.startsWith(`${safeUserId}_`) && file.endsWith(".log")) {
        const dateMatch = file.match(/_(\d{4}-\d{2}-\d{2})\.log$/)
        if (dateMatch) {
          dates.push(dateMatch[1])
        }
      }
    }

    return dates.sort().reverse()
  } catch (error) {
    consola.error("[USER-LOGGER] Failed to list log dates:", error)
    return []
  }
}

export function getLogDirectory(): string {
  return LOG_DIR
}

export const USER_ID_HEADER = "x-user-id"
export const USERNAME_HEADER = "x-username"
