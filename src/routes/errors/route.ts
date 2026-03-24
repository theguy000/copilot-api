import { readFileSync, existsSync, statSync } from "node:fs"

import { Hono } from "hono"

import { getErrorLogPath } from "~/lib/error-monitor"

export const errorRoutes = new Hono()

/**
 * GET /errors - View recent errors
 * Query params:
 *   - limit: number of recent errors to return (default: 50)
 *   - format: "json" (default) or "text"
 */
errorRoutes.get("/", async (c) => {
  const limit = Number(c.req.query("limit") || "50")
  const format = c.req.query("format") || "json"

  const logPath = getErrorLogPath()

  if (!existsSync(logPath)) {
    return c.json({
      message: "No errors logged yet",
      errors: [],
      logPath,
    })
  }

  try {
    const content = readFileSync(logPath, "utf-8")
    const lines = content.trim().split("\n").filter(Boolean)

    const recentLines = lines.slice(-limit)
    const errors = recentLines
      .map((line) => {
        try {
          return JSON.parse(line)
        } catch {
          return { raw: line }
        }
      })
      .reverse()

    if (format === "text") {
      const text = errors
        .map(
          (e: { timestamp: string; type: string; message: string; method?: string; path?: string }) =>
            `[${e.timestamp}] ${e.type}: ${e.message}${e.path ? ` (${e.method} ${e.path})` : ""}`,
        )
        .join("\n")
      return c.text(text)
    }

    const stats = statSync(logPath)

    return c.json({
      message: `Showing ${errors.length} most recent errors`,
      totalErrors: lines.length,
      logPath,
      logSize: `${(stats.size / 1024).toFixed(2)} KB`,
      errors,
    })
  } catch (error) {
    return c.json(
      {
        error: "Failed to read error log",
        details: (error as Error).message,
      },
      500,
    )
  }
})

/**
 * GET /errors/stats - Get error statistics
 */
errorRoutes.get("/stats", async (c) => {
  const logPath = getErrorLogPath()

  if (!existsSync(logPath)) {
    return c.json({
      totalErrors: 0,
      byType: {},
      recent24h: 0,
    })
  }

  try {
    const content = readFileSync(logPath, "utf-8")
    const lines = content.trim().split("\n").filter(Boolean)

    const now = Date.now()
    const oneDayAgo = now - 24 * 60 * 60 * 1000

    const byType: Record<string, number> = {}
    let recent24h = 0

    for (const line of lines) {
      try {
        const entry = JSON.parse(line)
        const type = entry.type || "unknown"
        byType[type] = (byType[type] || 0) + 1

        if (entry.timestamp) {
          const ts = new Date(entry.timestamp).getTime()
          if (ts > oneDayAgo) recent24h++
        }
      } catch {
        byType["parse_error"] = (byType["parse_error"] || 0) + 1
      }
    }

    return c.json({
      totalErrors: lines.length,
      byType,
      recent24h,
      logPath,
    })
  } catch (error) {
    return c.json(
      {
        error: "Failed to read error log",
        details: (error as Error).message,
      },
      500,
    )
  }
})

/**
 * POST /errors/test - Intentionally throw an error for testing
 */
errorRoutes.post("/test", async () => {
  throw new Error(
    "This is a test error to verify error monitoring is working!",
  )
})
