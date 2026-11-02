import { describe, expect, it } from "bun:test"
import {
  diagnosticTier,
  isRegisteredDiagnostic,
  registeredDiagnosticTypes,
} from "../../../src/infra/diagnostics-registry.js"

describe("diagnostics registry", () => {
  it("defaults an undeclared type to debug so nothing is born loud", () => {
    expect(isRegisteredDiagnostic("family.nobody.declared")).toBe(false)
    expect(diagnosticTier("family.nobody.declared")).toBe("debug")
  })

  it("keeps raw stream events quiet and durable summaries out of diagnostics", () => {
    expect(diagnosticTier("model.stream.event_observed")).toBe("debug")
    expect(isRegisteredDiagnostic("model.stream.summary.recorded")).toBe(false)
  })

  it("declares every Log level record", () => {
    for (const type of ["log.debug", "log.info", "log.warn", "log.error"]) {
      expect(isRegisteredDiagnostic(type)).toBe(true)
    }
    expect(diagnosticTier("log.debug")).toBe("debug")
    expect(diagnosticTier("log.error")).toBe("info")
  })

  it("lists every declared type exactly once", () => {
    const types = registeredDiagnosticTypes()
    expect(new Set(types).size).toBe(types.length)
    expect(types.length).toBeGreaterThan(0)
  })
})
