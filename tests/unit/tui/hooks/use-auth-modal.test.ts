import { describe, expect, it } from "bun:test"
import { authStatusPresentation, providerModuleValue } from "../../../../src/tui/auth-status-presentation.js"

describe("shared auth status presentation", () => {
  it("classifies source and expiry without credentials", () => {
    expect(authStatusPresentation({ source: "stored_key", expired: false })).toEqual({ configured: true, text: "stored", tone: "healthy" })
    expect(authStatusPresentation({ source: "oauth", expired: false })).toEqual({ configured: true, text: "active", tone: "healthy" })
    expect(authStatusPresentation({ source: "oauth", expired: true })).toEqual({ configured: true, text: "expired", tone: "warning" })
    expect(authStatusPresentation({ source: "invalid", expired: false })).toEqual({ configured: false, text: "needs attention", tone: "warning" })
    expect(authStatusPresentation({ source: "oauth", expired: false, catalog: { kind: "unavailable", reason: "authentication-invalid" } })).toEqual({ configured: true, text: "needs attention", tone: "warning" })
    expect(authStatusPresentation({ source: "unconfigured", expired: false })).toEqual({ configured: false, text: "unconfigured", tone: "muted" })
  })

  it("maps every live provider status to the Settings vocabulary", () => {
    expect(providerModuleValue({ source: "oauth", expired: false })).toBe("On - active")
    expect(providerModuleValue({ source: "oauth", expired: true })).toBe("On - expired")
    expect(providerModuleValue({ source: "invalid", expired: false })).toBe("On - needs attention")
    expect(providerModuleValue({ source: "stored_key", expired: false })).toBe("On - stored")
    expect(providerModuleValue({ source: "unconfigured", expired: false })).toBe("On - not configured")
    expect(providerModuleValue(undefined)).toBe("On - not configured")
  })
})
