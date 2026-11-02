import { mock } from "bun:test"
import type { RuntimeEvent } from "../../../../src/infra/runtime-event-types"
import type { SessionEntryBasePatch } from "../../../../src/orchestration/session-store/types"
import type { AnyBlock } from "../../../../src/infra/output-blocks"
import type { ContentBlock } from "../../../../src/infra/runtime-content-blocks"

/** Flush pending store syncs (time-gated via setTimeout). */
export const flushMicrotasks = () => new Promise<void>(r => setTimeout(r, 20))

export function createMocks() {
  const updateEntry = mock<(patch: SessionEntryBasePatch) => void>()
  return { updateEntry }
}

export function makeAssistantTextEvent(text: string): RuntimeEvent {
  return {
    type: "model.assistant_message.recorded",
    data: {
      type: "model.assistant_message.recorded",
      entry_id: crypto.randomUUID(),
      message: { content: [{ type: "text", text }] },
    },
  }
}

export function makeAssistantThinkingEvent(thinking: string): RuntimeEvent {
  return {
    type: "model.assistant_message.recorded",
    data: {
      type: "model.assistant_message.recorded",
      entry_id: crypto.randomUUID(),
      message: { content: [{ type: "thinking", thinking }] },
    },
  }
}

export function makeAssistantEvent(content: ContentBlock[]): RuntimeEvent {
  return {
    type: "model.assistant_message.recorded",
    data: { type: "model.assistant_message.recorded", entry_id: crypto.randomUUID(), message: { content } },
  }
}

export function outputSeamBlocks(): AnyBlock[] {
  const timestamp = Date.parse("2026-01-01T00:00:00.000Z")
  return [
    { kind: "userMessage", id: "user-1", content: "sanitized request", timestamp, pending: false, injected: false },
    { kind: "thinking", id: "thinking-1", content: "sanitized reasoning", status: "completed", timestamp, completedAt: timestamp + 1 },
    { kind: "text", id: "text-1", content: "sanitized answer", timestamp },
    { kind: "question", toolUseId: "question-1", questions: [{ question: "Proceed?", choices: [{ kind: "option", label: "Yes" }, { kind: "freeform", label: "Other" }], multiSelect: false }], timestamp },
    { kind: "tool", id: "tool-ok", name: "write", presentation: { name: "Write", detail: "src/sanitized.ts" }, status: "completed", content: "export const sanitized = true\n", filetype: "typescript", timestamp },
    { kind: "tool", id: "tool-error", name: "bash", presentation: { name: "Bash", detail: "false" }, status: "error", errorMessage: "sanitized failure", exitCode: 1, timestamp },
    { kind: "tool", id: "tool-partial", name: "read", presentation: { name: "Read", detail: "src/partial.ts" }, status: "interrupted", timestamp },
    { kind: "agentGroup", id: "group-1", label: "Sanitized Agent", description: "sanitized group", status: "completed", containerKind: "subagent", children: [], totalToolCount: 0, toolUseId: "group-1", timestamp },
    { kind: "divider", id: "step-1", label: "Sanitized workflow step", timestamp },
    { kind: "system", id: "compact-1", message: "Context compacted: 1,000 → 100 tokens (90% reduction)", timestamp },
    { kind: "system", id: "system-error", message: "Sanitized stream interrupted", level: "error", timestamp },
  ]
}

export function firstDifferingField(left: unknown, right: unknown, path = "$"): string | null {
  if (Object.is(left, right)) return null
  if (typeof left !== "object" || left === null || typeof right !== "object" || right === null) return path
  const leftRecord = Object.fromEntries(Object.entries(left))
  const rightRecord = Object.fromEntries(Object.entries(right))
  const keys = [...new Set([...Object.keys(leftRecord), ...Object.keys(rightRecord)])].sort()
  for (const key of keys) {
    const difference = firstDifferingField(leftRecord[key], rightRecord[key], `${path}.${key}`)
    if (difference) return difference
  }
  return null
}

export function assertOutputBlocksEquivalent(caseName: string, live: readonly unknown[], derived: readonly unknown[]): void {
  const difference = firstDifferingField(live, derived)
  if (!difference) return
  const liveBlock = live.find((_, index) => firstDifferingField(live[index], derived[index]) !== null)
  const identity = typeof liveBlock === "object" && liveBlock !== null && "id" in liveBlock ? String(liveBlock.id) : "unknown"
  const kind = typeof liveBlock === "object" && liveBlock !== null && "kind" in liveBlock ? String(liveBlock.kind) : "unknown"
  throw new Error(`output equivalence failed: case=${caseName} kind=${kind} identity=${identity} firstDifferingField=${difference}`)
}
