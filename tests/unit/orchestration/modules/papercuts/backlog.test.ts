import { describe, expect, it } from "bun:test"

import type { StoredFact } from "../../../../../src/infra/event-store-types"
import { parsePapercutFact } from "../../../../../src/orchestration/modules/papercuts/facts"
import { projectPapercutBacklog } from "../../../../../src/orchestration/modules/papercuts/backlog"

function recorded(id: string, position: number, sessionId: string, observation = id): StoredFact {
  return {
    id,
    position,
    seq: 0,
    aggregateId: `session:${sessionId}`,
    type: "papercut.recorded",
    version: 1,
    timestamp: position,
    actor: "agent",
    sessionId,
    payload: {
      observation,
      category: "defect",
      conversationId: `conversation-${sessionId}`,
      modelRequestId: `request-${sessionId}`,
      toolUseId: `tool-${sessionId}`,
    },
  }
}

function disposed(id: string, position: number, recordedFactId: string, disposition: "fixed" | "dismissed" | "promoted" = "fixed"): StoredFact {
  return {
    id,
    position,
    seq: position,
    aggregateId: "project",
    type: "papercut.disposed",
    version: 1,
    timestamp: position,
    actor: "agent",
    sessionId: "disposing-session",
    payload: { recordedFactId, disposition, disposingSessionId: "disposing-session" },
  }
}

describe("papercut facts", () => {
  it("strictly validates categories, dispositions, and excess fields", () => {
    const valid = {
      type: "papercut.recorded" as const,
      version: 1 as const,
      actor: "agent" as const,
      payload: recorded("p1", 1, "s1").payload,
    }
    expect(parsePapercutFact(valid).type).toBe("papercut.recorded")
    expect(() => parsePapercutFact({ ...valid, payload: { ...valid.payload, category: "feature" } })).toThrow()
    expect(() => parsePapercutFact({ ...valid, payload: { ...valid.payload, sessionId: "s1" } })).toThrow()
    expect(() => parsePapercutFact({ type: "papercut.disposed", version: 1, actor: "agent", payload: { recordedFactId: "p1", disposition: "deferred", disposingSessionId: "s1" } })).toThrow()
  })
})

describe("projectPapercutBacklog", () => {
  it("folds mixed sessions in workspace position order and ignores unrelated facts", () => {
    const unrelated = { ...recorded("other", 2, "s0"), type: "session.created", payload: {} }
    const backlog = projectPapercutBacklog([
      recorded("p2", 3, "s2", "second"),
      unrelated,
      recorded("p1", 1, "s1", "first"),
    ])

    expect(backlog.live.map((entry) => [entry.recordedFactId, entry.owningSessionId, entry.observation])).toEqual([
      ["p1", "s1", "first"],
      ["p2", "s2", "second"],
    ])
    expect(backlog.count).toBe(backlog.live.length)
  })

  it("folds every disposition and preserves terminal state on replay", () => {
    const events = [
      recorded("p1", 1, "s1"),
      recorded("p2", 2, "s2"),
      recorded("p3", 3, "s3"),
      recorded("p4", 4, "s4"),
      disposed("d3", 7, "p3", "promoted"),
      disposed("d1", 5, "p1", "fixed"),
      disposed("d2", 6, "p2", "dismissed"),
    ]

    expect(projectPapercutBacklog(events).live.map((entry) => entry.recordedFactId)).toEqual(["p4"])
    expect(projectPapercutBacklog([...events]).live.map((entry) => entry.recordedFactId)).toEqual(["p4"])
  })

  it("rejects dispositions for unknown or already terminal recorded facts", () => {
    expect(() => projectPapercutBacklog([disposed("d1", 1, "missing")])).toThrow("unknown papercut")
    expect(() => projectPapercutBacklog([
      recorded("p1", 1, "s1"),
      disposed("d1", 2, "p1"),
      disposed("d2", 3, "p1", "dismissed"),
    ])).toThrow("already terminal")
  })
})
