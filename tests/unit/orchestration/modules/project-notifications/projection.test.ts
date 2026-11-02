import { describe, expect, it } from "bun:test"

import type { StoredFact } from "../../../../../src/infra/event-store-types"
import { projectProjectNotifications } from "../../../../../src/orchestration/modules/project-notifications/projection"
import { parseProjectNotificationFact } from "../../../../../src/orchestration/modules/project-notifications/facts"

function fact(type: "project.notification.raised" | "project.notification.resolved" | "project.notification.dismissed", seq: number, sourceId: string, overrides: { [key: string]: unknown } = {}): StoredFact {
  const payload = type === "project.notification.raised"
    ? { sourceId, title: sourceId, message: `message ${sourceId}`, severity: "warning", action: { kind: "open-settings" }, createdAt: seq * 1_000, expiresAt: seq * 1_000 + 48 * 60 * 60 * 1_000, ...overrides }
    : { sourceId, episodeId: overrides.episodeId ?? "fact-0", ...overrides }
  return { id: `fact-${seq}`, position: seq + 1, seq, aggregateId: "project:notifications", type, version: 1, timestamp: seq * 1_000, actor: "system", sessionId: "session-1", payload }
}

describe("project notification projection", () => {
  it("decodes recorded episodes with an action unchanged and permits actionless notices", () => {
    for (const action of [{ kind: "open-settings" } as const, undefined]) {
      const recorded = fact("project.notification.raised", 0, "episode", { action })
      const payload = { sourceId: "episode", title: "episode", message: "message episode", severity: "warning", ...(action ? { action } : {}), createdAt: 0, expiresAt: 48 * 60 * 60 * 1_000 } as const
      const input = { type: "project.notification.raised", version: 1, actor: "system", payload } as const
      expect(parseProjectNotificationFact(input)).toEqual(input)
      expect(projectProjectNotifications([{ ...recorded, payload }], 0).visible).toEqual([{ id: "fact-0", ...payload }])
    }
  })

  it("derives visibility through the exact expiry boundary after replay", () => {
    const facts = [fact("project.notification.raised", 0, "episode")]
    expect(projectProjectNotifications(facts, 48 * 60 * 60 * 1_000 - 1).visible).toHaveLength(1)
    expect(projectProjectNotifications(facts, 48 * 60 * 60 * 1_000).visible).toEqual([])
    expect(projectProjectNotifications(facts, 48 * 60 * 60 * 1_000).episodes[0]?.id).toBe("fact-0")
  })

  it("keeps a recovered notification visible after replay until dismissal", () => {
    const facts = [
      fact("project.notification.raised", 0, "episode"),
      fact("project.notification.resolved", 1, "episode", { episodeId: "fact-0" }),
    ]
    expect(projectProjectNotifications(facts, 2_000).visible).toMatchObject([{ id: "fact-0", resolvedAt: 1_000 }])
    expect(projectProjectNotifications(facts, 48 * 60 * 60 * 1_000).visible).toEqual([])
  })

  it("keeps resolution and dismissal independent while dismissal hides the episode", () => {
    const projected = projectProjectNotifications([
      fact("project.notification.raised", 0, "episode"),
      fact("project.notification.resolved", 1, "episode", { episodeId: "fact-0" }),
      fact("project.notification.dismissed", 2, "episode", { episodeId: "fact-0" }),
    ], 2_000)

    expect(projected.visible).toEqual([])
    expect(projected.episodes[0]?.resolvedAt).toBe(1_000)
    expect(projected.episodes[0]?.dismissedAt).toBe(2_000)
  })

  it("deduplicates an active condition but permits a fresh occurrence after resolution", () => {
    const projected = projectProjectNotifications([
      fact("project.notification.raised", 0, "provider-auth:openai"),
      fact("project.notification.resolved", 1, "provider-auth:openai", { episodeId: "fact-0" }),
      fact("project.notification.raised", 2, "provider-auth:openai"),
      fact("project.notification.dismissed", 3, "provider-auth:openai", { episodeId: "fact-2" }),
    ], 3_000)

    expect(projected.episodes.map((episode) => episode.id)).toEqual(["fact-2", "fact-0"])
    expect(projected.episodes[0]).toMatchObject({ sourceId: "provider-auth:openai", dismissedAt: 3_000 })
    expect(projected.episodes[1]).toMatchObject({ sourceId: "provider-auth:openai", resolvedAt: 1_000 })
    expect(projected.visible.map((episode) => episode.id)).toEqual(["fact-0"])
  })

  it("strictly rejects malformed, excess, unknown, duplicate, wrong-aggregate, and wrong-target facts", () => {
    expect(() => projectProjectNotifications([fact("project.notification.raised", 0, "episode", { expiresAt: 1 })], 0)).toThrow("48 hours")
    expect(() => projectProjectNotifications([{ ...fact("project.notification.raised", 0, "episode"), aggregateId: "wrong" }], 0)).toThrow("project:notifications")
    expect(() => projectProjectNotifications([fact("project.notification.resolved", 0, "missing")], 0)).toThrow("unknown project notification")
    expect(() => projectProjectNotifications([fact("project.notification.raised", 0, "episode"), fact("project.notification.raised", 1, "episode")], 0)).toThrow("Duplicate project notification source")
    expect(() => projectProjectNotifications([fact("project.notification.raised", 0, "episode", { command: "rm -rf /" })], 0)).toThrow()
    expect(() => projectProjectNotifications([fact("project.notification.raised", 0, "episode", { severity: "info" })], 0)).toThrow()
    expect(() => projectProjectNotifications([{ ...fact("project.notification.raised", 0, "episode"), type: "project.notification.executed" }], 0)).toThrow()
    expect(() => projectProjectNotifications([
      fact("project.notification.raised", 0, "episode"),
      fact("project.notification.resolved", 1, "episode", { episodeId: "fact-other" }),
    ], 0)).toThrow("wrong episode")
  })
})
