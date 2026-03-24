import {
  getGitHubApiBaseUrl,
  githubHeaders,
  githubHeadersWithToken,
} from "~/lib/api-config"
import { HTTPError } from "~/lib/error"
import { state } from "~/lib/state"

/**
 * Get Copilot token using the global state's GitHub token
 */
export const getCopilotToken = async () => {
  const response = await fetch(
    `${getGitHubApiBaseUrl()}/copilot_internal/v2/token`,
    {
      headers: githubHeaders(state),
    },
  )

  if (!response.ok)
    throw new HTTPError("Failed to get Copilot token", response)

  return (await response.json()) as GetCopilotTokenResponse
}

/**
 * Get Copilot token using a specific GitHub token (for per-request tokens from proxy)
 */
export const getCopilotTokenWithGitHubToken = async (
  githubToken: string,
) => {
  const response = await fetch(
    `${getGitHubApiBaseUrl()}/copilot_internal/v2/token`,
    {
      headers: githubHeadersWithToken(githubToken, state),
    },
  )

  if (!response.ok)
    throw new HTTPError("Failed to get Copilot token", response)

  return (await response.json()) as GetCopilotTokenResponse
}

// Trimmed for the sake of simplicity
interface GetCopilotTokenResponse {
  expires_at: number
  refresh_in: number
  token: string
}
