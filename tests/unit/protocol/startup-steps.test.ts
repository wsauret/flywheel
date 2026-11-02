import { describe, expect, it } from "bun:test"
import { createAccountAttachResponseReader, encodeAccountAttachResponse } from "../../../src/protocol/account-attach.js"
import { decodeServeStatusLine, encodeServeStatusRecord } from "../../../src/protocol/serve-handshake.js"
import { isStartupStep, startupPhase, type StartupStep } from "../../../src/protocol/startup-steps.js"

/** One key for each step of the catalog. The type demands every step and
 *  admits no other, so the phases below are the whole catalog; the catalog
 *  alone decides their order. */
const EVERY_STEP = {
  "account-service": true,
  "project": true,
  "project-module-preparation": true,
  "state-worker": true,
  "workspace-state": true,
  "event-index": true,
  "stored-facts": true,
  "event-store": true,
  "sessions": true,
  "interrupted-sessions": true,
  "project-modules": true,
  "project-runtime": true,
  "project-transports": true,
} satisfies { readonly [Step in StartupStep]: true }
const catalog = Object.keys(EVERY_STEP).filter(isStartupStep).map((step) => startupPhase({ step }))

describe("startupPhase", () => {
  it("gives every step of the catalog its own label and its own place on one bar", () => {
    const places = catalog.map((phase) => phase.progress!.step).sort((left, right) => left - right)
    expect(places).toEqual(catalog.map((_, index) => index + 1))
    expect(catalog.every((phase) => phase.progress!.total === catalog.length)).toBe(true)
    expect(new Set(catalog.map((phase) => phase.label)).size).toBe(catalog.length)
  })

  it("names the claim of interrupted sessions as a check, because the start recovers none of them", () => {
    expect(startupPhase({ step: "interrupted-sessions" }).label).toBe("Checking interrupted sessions")
  })

  it("names a pass and its own count inside its step and leaves the bar at that step", () => {
    const step = startupPhase({ step: "stored-facts" })
    const pass = startupPhase({ step: "stored-facts", pass: { label: "memory facts", step: 2, total: 24 } })
    expect(pass).toEqual({ label: "Upgrading stored facts, pass 2 of 24: memory facts", progress: step.progress })
  })

  it("keeps the phase shape that every reader of this protocol decodes", () => {
    const phases = [...catalog, startupPhase({ step: "stored-facts", pass: { label: "memory facts", step: 1, total: 3 } })]
    for (const phase of phases) {
      expect(decodeServeStatusLine(encodeServeStatusRecord({ flywheel: "serve.startup.phase", ...phase }))).toEqual({ flywheel: "serve.startup.phase", ...phase })
    }
    const reported: unknown[] = []
    const reader = createAccountAttachResponseReader((phase) => reported.push(phase))
    const wire = phases.map((phase) => encodeAccountAttachResponse({ kind: "phase", ...phase })).join("") + encodeAccountAttachResponse({ kind: "ready" })
    expect(reader.push(new TextEncoder().encode(wire)).kind).toBe("ready")
    expect(reported).toEqual(phases)
  })
})
