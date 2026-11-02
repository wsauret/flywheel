import { authStatusState, type AuthStatusInput } from "../protocol/client/auth-status-state.js"

export interface AuthStatusPresentation {
  readonly configured: boolean
  readonly text: "active" | "expired" | "stored" | "unconfigured" | "misconfigured" | "needs attention"
  readonly tone: "healthy" | "warning" | "muted"
}

/** The terminal's words for the shared auth status state (`authStatusState`) on every TUI auth surface. */
export function authStatusPresentation(status: AuthStatusInput): AuthStatusPresentation {
  const configured = status.source === "stored_key" || status.source === "oauth"
  switch (authStatusState(status)) {
    case "needs-attention": case "invalid": return { configured, text: "needs attention", tone: "warning" }
    case "unconfigured": return { configured: false, text: "unconfigured", tone: "muted" }
    case "misconfigured": return { configured: false, text: "misconfigured", tone: "warning" }
    case "expired": return { configured: true, text: "expired", tone: "warning" }
    case "stored": return { configured: true, text: "stored", tone: "healthy" }
    case "connected": return { configured: true, text: "active", tone: "healthy" }
  }
}

export function providerModuleValue(status: AuthStatusInput | undefined): "On - active" | "On - expired" | "On - stored" | "On - misconfigured" | "On - needs attention" | "On - not configured" {
  if (status === undefined) return "On - not configured"
  const text = authStatusPresentation(status).text
  return text === "unconfigured" ? "On - not configured" : `On - ${text}`
}
