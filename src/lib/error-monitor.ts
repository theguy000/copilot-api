/**
 * Comprehensive Error Monitoring for Copilot API
 *
 * This module ensures ALL errors are captured, logged, and visible.
 * - File-based logging (survives process crashes)
 * - Console output with prominent formatting
 * - Process-level handlers for uncaught exceptions
 */

import { existsSync, mkdirSync, appendFileSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

import consola from "consola"
import type { Context } from "hono"
import type { ContentfulStatusCode } from "hono/utils/http-status"

const __dirname = dirname(fileURLToPath(import.meta.url))
const LOG_DIR = join(__dirname, "../../../logs")
const ERROR_LOG_FILE = join(LOG_DIR, "errors.log")

if (!existsSync(LOG_DIR)) {
  mkdirSync(LOG_DIR, { recursive: true })
}

export interface ErrorLogEntry {
  timestamp: string
  type: "uncaught" | "unhandled_rejection" | "http_error" | "request_error"
  message: string
  stack?: string
  path?: string
  method?: string
  status?: number
  details?: unknown
}

function writeErrorToFile(entry: ErrorLogEntry): void {
  try {
    const line = JSON.stringify(entry) + "\n"
    appendFileSync(ERROR_LOG_FILE, line, "utf-8")
  } catch (e) {
    consola.error("[ERROR-MONITOR] Failed to write to log file:", e)
  }
}

function formatErrorForConsole(entry: ErrorLogEntry): string {
  const divider = "=".repeat(60)
  return `
${"+" + divider + "+"}
| ERROR DETECTED: ${entry.type.toUpperCase().padEnd(40)}|
${"|" + divider + "|"}
| Time: ${entry.timestamp.padEnd(52)}|
| Message: ${(entry.message || "Unknown").slice(0, 50).padEnd(50)}|
${entry.path ? `| Path: ${entry.path.slice(0, 53).padEnd(53)}|\n` : ""}${entry.status ? `| Status: ${String(entry.status).padEnd(51)}|\n` : ""}${"+" + divider + "+"}
${entry.stack || ""}`
}

export function logError(entry: ErrorLogEntry): void {
  console.error(formatErrorForConsole(entry))
  writeErrorToFile(entry)
}

export function globalErrorHandler(err: Error, c: Context) {
  const entry: ErrorLogEntry = {
    timestamp: new Date().toISOString(),
    type: "request_error",
    message: err.message,
    stack: err.stack,
    path: c.req.path,
    method: c.req.method,
    status: 500,
  }

  logError(entry)

  return c.json(
    {
      error: {
        message: err.message,
        type: "internal_error",
        timestamp: entry.timestamp,
      },
    },
    500 as ContentfulStatusCode,
  )
}

export function setupProcessErrorHandlers(): void {
  process.on("uncaughtException", (error: Error) => {
    logError({
      timestamp: new Date().toISOString(),
      type: "uncaught",
      message: error.message,
      stack: error.stack,
    })
    console.error(
      "[ERROR-MONITOR] Uncaught exception - process continuing...",
    )
  })

  process.on("unhandledRejection", (reason: unknown) => {
    const message =
      reason instanceof Error ? reason.message : String(reason)
    const stack = reason instanceof Error ? reason.stack : undefined

    logError({
      timestamp: new Date().toISOString(),
      type: "unhandled_rejection",
      message,
      stack,
    })
    console.error(
      "[ERROR-MONITOR] Unhandled rejection - process continuing...",
    )
  })

  consola.success("[ERROR-MONITOR] Process error handlers installed")
  consola.info(`[ERROR-MONITOR] Error log file: ${ERROR_LOG_FILE}`)
}

export function getErrorLogPath(): string {
  return ERROR_LOG_FILE
}
