/**
 * Per-request token management for copilot-api
 *
 * This module handles dynamic GitHub token to Copilot token conversion
 * when running behind a proxy that provides per-request GitHub tokens.
 *
 * The flow:
 * 1. Proxy sends x-github-token header with user's GitHub token from database
 * 2. copilot-api extracts this token and exchanges it for a Copilot token
 * 3. The Copilot token is cached for efficiency (tokens are valid for ~30 minutes)
 * 4. The chat completion uses the per-request Copilot token
 */

import { createHash } from "node:crypto"

import consola from "consola"

import { getCopilotTokenWithGitHubToken } from "~/services/github/get-copilot-token"

/**
 * Cached Copilot token with expiration
 */
interface CachedToken {
  token: string
  expiresAt: number
}

/**
 * Cache of GitHub token -> Copilot token
 * Key is SHA256 hash of GitHub token (for security - don't store raw tokens in memory)
 */
const tokenCache = new Map<string, CachedToken>()

/**
 * Hash a GitHub token for use as cache key
 * We don't store the raw token to limit exposure if memory is dumped
 */
function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex").slice(0, 16)
}

/**
 * Get a Copilot token for a given GitHub token.
 * Uses caching to avoid redundant API calls.
 *
 * @param githubToken - The GitHub token from x-github-token header
 * @returns Copilot token string, or null if token exchange fails
 */
export async function getCopilotTokenForRequest(
  githubToken: string,
): Promise<string | null> {
  const cacheKey = hashToken(githubToken)
  const now = Date.now()

  // Check cache first
  const cached = tokenCache.get(cacheKey)
  if (cached && cached.expiresAt > now) {
    consola.debug(
      `[TOKEN] Using cached Copilot token (expires in ${Math.round((cached.expiresAt - now) / 1000)}s)`,
    )
    return cached.token
  }

  // Exchange GitHub token for Copilot token
  try {
    consola.info("[TOKEN] Exchanging GitHub token for Copilot token...")
    const response = await getCopilotTokenWithGitHubToken(githubToken)

    // Cache with expiration (subtract 60 seconds as buffer)
    const expiresAt = response.expires_at * 1000 - 60000
    tokenCache.set(cacheKey, {
      token: response.token,
      expiresAt,
    })

    consola.info(
      `[TOKEN] Got Copilot token (expires in ${Math.round((expiresAt - now) / 1000)}s)`,
    )
    return response.token
  } catch (error) {
    consola.error("[TOKEN] Failed to exchange GitHub token:", error)
    return null
  }
}

/**
 * Clean up expired tokens from cache
 * Called periodically to prevent memory leaks
 */
function cleanupCache() {
  const now = Date.now()
  let removed = 0

  for (const [key, value] of tokenCache) {
    if (value.expiresAt <= now) {
      tokenCache.delete(key)
      removed++
    }
  }

  if (removed > 0) {
    consola.debug(
      `[TOKEN] Cleaned up ${removed} expired tokens from cache`,
    )
  }
}

// Clean up cache every 5 minutes
setInterval(cleanupCache, 5 * 60 * 1000)

/**
 * Header name for GitHub token passed from proxy
 */
export const GITHUB_TOKEN_HEADER = "x-github-token"
