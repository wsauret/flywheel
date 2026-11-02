import { describe, expect, test } from "bun:test"

import { createProjectNotificationSink } from "../../../../../src/orchestration/modules/project-notifications/sink.js"

const occurrence = (sourceId: string) => ({ sourceId, title: sourceId, message: sourceId, severity: "warning" as const, action: { kind: "open-settings" as const } })

describe("project notification sink", () => {
  test("treats resolution without an active notification as a no-op", async () => {
    const resolved: string[] = []
    const sink = createProjectNotificationSink({
      journal: {
        raise: async (input) => ({ id: "raised", ...input, createdAt: 1, expiresAt: 2 }),
        resolve: async (sourceId) => { resolved.push(sourceId) },
        activeSourceIds: async () => new Set<string>(),
      },
    })

    await sink.apply({ type: "resolve", sourceId: "healthy-source" })
    await sink.settled()

    expect(resolved).toEqual([])
  })

  test("applies inputs in admission order and contains one failed raise", async () => {
    const operations: string[] = []
    const activeSources = new Set(["profile-source", "later"])
    let releaseRaise = (): void => {}
    const raiseBlocked = new Promise<void>((resolve) => { releaseRaise = resolve })
    const sink = createProjectNotificationSink({
      journal: {
        raise: async (input) => {
          operations.push(`raise:${input.sourceId}`)
          await raiseBlocked
          throw new Error("contained raise failure")
        },
        resolve: async (sourceId) => { operations.push(`resolve:${sourceId}`) },
        activeSourceIds: async () => new Set(activeSources),
      },
    })

    const first = sink.apply({ type: "raise", occurrence: occurrence("first") }).catch(() => "contained")
    const resolved = sink.apply({ type: "resolve", sourceId: "profile-source" })
    const later = sink.apply({ type: "resolve", sourceId: "later" })
    await Promise.resolve()
    expect(operations).toEqual(["raise:first"])

    releaseRaise()
    expect(await first).toBe("contained")
    await resolved
    expect(operations).toEqual(["raise:first", "resolve:profile-source"])

    sink.closeAdmission()
    await Promise.all([later, sink.settled()])
    expect(operations).toEqual(["raise:first", "resolve:profile-source", "resolve:later"])
  })

  test("a reconcile resolves the other active sources under its prefix, keeps the kept prefixes, and raises the desired ones", async () => {
    const operations: string[] = []
    const activeSources = new Set([
      "runtime:auth-attention:profile-b:provider",
      "runtime:auth-attention:profile-b:file",
      "runtime:auth-attention:profile-b-extra:provider",
      "runtime:auth-status-warning:profile-b",
    ])
    const sink = createProjectNotificationSink({
      journal: {
        raise: async (input) => {
          operations.push(`raise:${input.sourceId}`)
          activeSources.add(input.sourceId)
          return { id: "raised", ...input, createdAt: 1, expiresAt: 2 }
        },
        resolve: async (sourceId) => {
          operations.push(`resolve:${sourceId}`)
          activeSources.delete(sourceId)
        },
        activeSourceIds: async () => new Set(activeSources),
      },
    })

    await sink.apply({ type: "reconcile", prefix: "runtime:auth-attention:profile-b:", desired: [occurrence("runtime:auth-attention:profile-b:provider"), occurrence("runtime:auth-attention:profile-b:new")] })
    expect(operations).toEqual(["resolve:runtime:auth-attention:profile-b:file", "raise:runtime:auth-attention:profile-b:provider", "raise:runtime:auth-attention:profile-b:new"])

    operations.length = 0
    await sink.apply({ type: "reconcile", prefix: "runtime:auth-attention:", desired: [], keep: ["runtime:auth-attention:profile-b-extra:"] })
    expect(operations).toEqual(["resolve:runtime:auth-attention:profile-b:provider", "resolve:runtime:auth-attention:profile-b:new"])
    expect(activeSources).toEqual(new Set(["runtime:auth-attention:profile-b-extra:provider", "runtime:auth-status-warning:profile-b"]))
  })

  test("rejects inputs after admission closes", async () => {
    const sink = createProjectNotificationSink({
      journal: {
        raise: async () => { throw new Error("raise is not used") },
        resolve: async () => {},
        activeSourceIds: async () => new Set<string>(),
      },
    })
    sink.closeAdmission()
    await expect(sink.apply({ type: "resolve", sourceId: "late" })).rejects.toThrow("notification admission is closed")
  })
})
