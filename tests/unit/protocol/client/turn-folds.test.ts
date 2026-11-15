import { describe, expect, it } from "bun:test"
import type { FrontendOutputBlock, FrontendToolEntry } from "../../../../src/protocol/app-service-types.js"
import { createTurnFolds, foldTurns, rowIdentity, type TurnFold } from "../../../../src/protocol/client/turn-folds.js"

const person: FrontendOutputBlock = { kind: "userMessage", id: "person", content: "Look into the flaky test", timestamp: 1000, pending: false, injected: false }
const route: FrontendToolEntry = { kind: "tool", id: "route", name: "route_request", action: "ui_meta", presentation: { name: "Route to new chat", detail: "" }, status: "completed", timestamp: 2000 }
const answer: FrontendOutputBlock = { kind: "text", id: "a1", content: "A new chat investigates it.", timestamp: 3000 }
// A hidden notice woke the lead after its answer: the first row of the new turn carries the runtime's mark.
const progress: FrontendToolEntry = { kind: "tool", id: "progress", name: "chat_progress", action: "ui_meta", presentation: { name: "Chat progress", detail: "" }, status: "completed", timestamp: 10_000, turnStart: true }
const comment: FrontendOutputBlock = { kind: "text", id: "a2", content: "That chat asks you a question.", timestamp: 12_000 }

const presented = (rows: readonly FrontendOutputBlock[]) => ({ rows, boundaryBefore: rows.map(() => false) })
const rowNames = (rows: readonly (FrontendOutputBlock | TurnFold<FrontendOutputBlock>)[]) => rows.map((row) => row.kind === "turnFold"
  ? `fold(${row.rows.map(rowIdentity).join(",")}; ${row.duration}ms)`
  : rowIdentity(row))

describe("the shared turn fold", () => {
  it("ends a turn where a turn that the runtime started begins, so the earlier answer stays in view and each turn folds alone", () => {
    expect(rowNames(foldTurns(presented([person, route, answer, progress, comment]), true).rows)).toEqual([
      "userMessage:person", "fold(tool:route; 2000ms)", "text:a1", "fold(tool:progress; 2000ms)", "text:a2",
    ])
  })

  it("folds a finished turn that ended without an answer, its words included, only on a presentation that asks for it", () => {
    const check: FrontendOutputBlock = { kind: "text", id: "check", content: "I will check that chat.", timestamp: 10_000, turnStart: true }
    const quiet = { ...progress, turnStart: undefined, timestamp: 10_500 }
    const rows = [person, route, answer, check, quiet]
    expect(rowNames(foldTurns(presented(rows), true, undefined, undefined, undefined, { foldsQuietTurns: true }).rows)).toEqual([
      "userMessage:person", "fold(tool:route; 2000ms)", "text:a1", "fold(text:check,tool:progress; 500ms)",
    ])
    const opened = foldTurns(presented(rows), true, () => true, undefined, undefined, { foldsQuietTurns: true }).rows
    expect(opened.slice(4).map((row) => row.kind === "turnFold" ? `fold+${row.held}` : rowIdentity(row))).toEqual(["fold+2", "text:check", "tool:progress"])
    expect(rowNames(foldTurns(presented(rows), true).rows).slice(3)).toEqual(["text:check", "tool:progress"])
  })

  it("keeps the notice of a quiet turn that was cut in view after its fold", () => {
    const check: FrontendOutputBlock = { kind: "text", id: "check", content: "I will check that chat.", timestamp: 10_000, turnStart: true }
    const cut: FrontendToolEntry = { ...progress, turnStart: undefined, status: "interrupted", timestamp: 10_500 }
    const notice: FrontendOutputBlock = { kind: "system", id: "cut", message: "Interrupted by you", timestamp: 14_000 }
    expect(rowNames(foldTurns(presented([person, route, answer, check, cut, notice]), true, undefined, undefined, undefined, { foldsQuietTurns: true }).rows).slice(3)).toEqual([
      "fold(text:check,tool:progress; 4000ms)", "system:cut",
    ])
  })

  it("keeps a settled fold folded while the turn that a notice started runs", () => {
    const fold = createTurnFolds()
    const settled = rowNames(fold(presented([person, route, answer]), true, () => undefined).rows)
    const running = rowNames(fold(presented([person, route, answer, { ...progress, status: "pending" }]), false, () => undefined).rows)
    expect(running).toEqual([...settled, "tool:progress"])
  })
})
