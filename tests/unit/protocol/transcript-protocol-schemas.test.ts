import { describe, expect, it } from "bun:test"
import { Schema } from "effect"
import { FrontendOutputBlockSchema } from "../../../src/protocol/transcript-protocol-schemas.js"
import type { FrontendOutputBlock } from "../../../src/protocol/app-service-types.js"

describe("transcript block wire schema", () => {
  it.each([
    { status: "active" }, { status: "completed" }, { status: "partial" },
    { status: "paused", pausedBy: "person" },
    { status: "error", failure: { title: "Failed", message: "Rate limited", guidance: "" } },
  ] as const)("carries the projected activity and handoff summary on a $status card", (state) => {
    const row: Extract<FrontendOutputBlock, { kind: "agentGroup" }> = {
      kind: "agentGroup", containerKind: "subagent", id: "dispatch", toolUseId: "dispatch", label: "Explorer", description: "Trace",
      children: [], totalToolCount: 2, timestamp: 1, ...state,
      activity: { name: "Read", detail: "a.ts" }, summary: "Fixed the issue",
    }
    expect(Schema.decodeUnknownSync(FrontendOutputBlockSchema)(Schema.encodeUnknownSync(FrontendOutputBlockSchema)(row))).toEqual(row)
  })

  it("carries a running card's open active episode to the client, and decodes a version-23 card that states none", () => {
    const running = {
      kind: "agentGroup" as const, containerKind: "workflow" as const, id: "workflow-1", label: "Review", description: "Check it",
      status: "active" as const, children: [], totalToolCount: 0, duration: 20_000, activeStartedAt: 1_000, timestamp: 1, toolUseId: "workflow-1",
    }
    expect(Schema.decodeUnknownSync(FrontendOutputBlockSchema)(Schema.encodeUnknownSync(FrontendOutputBlockSchema)(running))).toEqual(running)
    // A version-23 runtime never sent the open episode: the card decodes with a stopped clock.
    const { activeStartedAt: _open, ...version23 } = running
    expect(Schema.decodeUnknownSync(FrontendOutputBlockSchema)(version23)).toEqual(version23)
  })

  it("carries the sender of a message row and the words of the person it attached", () => {
    const row = {
      kind: "userMessage" as const, id: "msg:child-1:call-1", content: "Which parser?", timestamp: 1, pending: false, injected: false,
      from: { sessionId: "child-1", name: "Parser fix", relation: "child" as const, personWords: "use the old one" },
    }
    expect(Schema.decodeUnknownSync(FrontendOutputBlockSchema)(Schema.encodeUnknownSync(FrontendOutputBlockSchema)(row))).toEqual(row)
  })
})
