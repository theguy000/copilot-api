import consola from "consola"

import { copilotHeaders, copilotBaseUrl } from "./api-config"
import { state } from "./state"

const HEARTBEAT_INTERVAL_MS = 2.5 * 60 * 60 * 1000 // 2.5 hours

let heartbeatTimer: ReturnType<typeof setInterval> | null = null

async function sendBillingHeartbeat(): Promise<void> {
  if (!state.copilotToken) {
    consola.warn("[Billing Heartbeat] No Copilot token, skipping heartbeat")
    return
  }

  try {
    const headers: Record<string, string> = {
      ...copilotHeaders(state),
      "X-Initiator": "user",
    }

    const response = await fetch(
      `${copilotBaseUrl(state)}/chat/completions`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: "gpt-4o-mini",
          messages: [{ role: "user", content: "hi" }],
          max_tokens: 1,
        }),
      },
    )

    if (response.ok) {
      consola.success(
        "[Billing Heartbeat] Sent billing heartbeat successfully",
      )
    } else {
      consola.error(
        "[Billing Heartbeat] Failed to send heartbeat:",
        response.status,
      )
    }
  } catch (error) {
    consola.error("[Billing Heartbeat] Error sending heartbeat:", error)
  }
}

export function startBillingHeartbeat(): void {
  if (heartbeatTimer) {
    consola.warn("[Billing Heartbeat] Already running")
    return
  }

  sendBillingHeartbeat()

  heartbeatTimer = setInterval(sendBillingHeartbeat, HEARTBEAT_INTERVAL_MS)

  consola.info(
    "[Billing Heartbeat] Started - will send 'user' request every 2.5 hours",
  )
}

export function stopBillingHeartbeat(): void {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer)
    heartbeatTimer = null
    consola.info("[Billing Heartbeat] Stopped")
  }
}
