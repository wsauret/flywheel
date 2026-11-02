import { describe, expect, test } from "bun:test"
import { createRuntimeUiPatchSequencer } from "../../../../src/orchestration/app-service/runtime-ui-patch-sequencer.js"
import type { RuntimeCursorIdentity, RuntimeUiPatch, RuntimeUiPatchPayload } from "../../../../src/protocol/runtime-ui-protocol-types.js"
import { RUNTIME_UI_PATCH_FIXTURES } from "../../protocol/runtime-ui-patch-fixtures.js"

function payload(): RuntimeUiPatchPayload {
  return { kind: "session.removed" }
}

describe("RuntimeUiPatchSequencer", () => {
  test("snapshots only observe published positions across repeated reads and two clients", () => {
    const sequencer = createRuntimeUiPatchSequencer()
    const session = { scope: "session", domain: "session", sessionId: "s1" } as const

    // Two reads with no intervening publish share one high-water position, so a
    // second client reading the same domain does not invalidate the first's chain.
    const first = sequencer.snapshotPosition({ kind: "workspace", domains: ["session"] })
    const reread = sequencer.snapshotPosition({ kind: "workspace", domains: ["session"] })
    expect(first).toBe(0)
    expect(reread).toBe(first)

    // A receiver holding `first` still classifies the next session patch in order
    // -- the idempotent re-read did not reseed and break the chain.
    const patch = sequencer.publish({ cursor: session, payload: payload() })
    expect(patch.prevPosition).toBe(first)
    expect(sequencer.classify(patch, { cursor: session, heldPosition: first })).toBe("applied")

    const secondClient = sequencer.snapshotPosition({ kind: "workspace", domains: ["session"] })
    expect(secondClient).toBe(patch.position)
    expect(sequencer.snapshotPosition({ kind: "workspace", domains: ["session"] })).toBe(secondClient)
    const next = sequencer.publish({ cursor: session, payload: payload() })
    expect(next.position).toBe(patch.position + 1)
    expect(next.prevPosition).toBe(patch.position)
    expect(sequencer.classify(next, { cursor: session, heldPosition: patch.position })).toBe("applied")
    expect(sequencer.classify(next, { cursor: session, heldPosition: secondClient })).toBe("applied")
  })

  test("an in-order patch is applied; a passed patch is a stale no-op", () => {
    const sequencer = createRuntimeUiPatchSequencer()
    const cursor = { scope: "session", domain: "output", sessionId: "s1" } as const
    const patch = sequencer.publish({ cursor, payload: payload() })
    expect(sequencer.classify(patch, { cursor, heldPosition: patch.prevPosition })).toBe("applied")
    expect(sequencer.classify(patch, { cursor, heldPosition: patch.position })).toBe("stale")
  })

  test("a patch whose prevPosition does not meet the held position is a gap", () => {
    const sequencer = createRuntimeUiPatchSequencer()
    const cursor = { scope: "session", domain: "output", sessionId: "s1" } as const
    sequencer.publish({ cursor, payload: payload() })
    const second = sequencer.publish({ cursor, payload: payload() })
    // Receiver still holds the snapshot base; the second patch skips the first.
    expect(sequencer.classify(second, { cursor, heldPosition: 0 })).toBe("gap")
  })

  test("a cross-domain or cross-session cursor mismatch is a gap", () => {
    const sequencer = createRuntimeUiPatchSequencer()
    const patch = sequencer.publish({ cursor: { scope: "session", domain: "output", sessionId: "s1" }, payload: payload() })
    const crossDomain: RuntimeUiPatch = { ...patch, cursor: { scope: "session", domain: "session", sessionId: "s1" } }
    const crossSession: RuntimeUiPatch = { ...patch, cursor: { scope: "session", domain: "output", sessionId: "s2" } }
    expect(sequencer.classify(crossDomain, { cursor: { scope: "session", domain: "output", sessionId: "s1" }, heldPosition: patch.prevPosition })).toBe("gap")
    expect(sequencer.classify(crossSession, { cursor: { scope: "session", domain: "output", sessionId: "s1" }, heldPosition: patch.prevPosition })).toBe("gap")
  })

  test("a single-cursor snapshot does not break an unrelated cursor's chain (no cross-domain resnapshot cascade)", () => {
    const sequencer = createRuntimeUiPatchSequencer()
    const session = { scope: "session", domain: "session", sessionId: "s1" } as const
    const output = { scope: "session", domain: "output", sessionId: "s1" } as const

    // Both cursors take a patch; the session cursor records its own last position.
    const sessionPatch = sequencer.publish({ cursor: session, payload: payload() })
    sequencer.publish({ cursor: output, payload: payload() })
    const sessionHeld = sessionPatch.position

    // A snapshot covering ONLY the output:s1 cursor must not disturb session:s1.
    // It is an observational high-water read of output:s1's current position.
    const outputHeld = sequencer.snapshotPosition({ kind: "cursor", cursor: output })
    expect(outputHeld).toBeGreaterThan(0)

    // The session cursor's next patch must still chain from its own held position,
    // so a receiver holding sessionHeld classifies it `applied`, not `gap`.
    const nextSession = sequencer.publish({ cursor: session, payload: payload() })
    expect(nextSession.prevPosition).toBe(sessionHeld)
    expect(sequencer.classify(nextSession, { cursor: session, heldPosition: sessionHeld })).toBe("applied")

    // And the inverse: a domain-wide session snapshot must not disturb output:s1,
    // whose receiver still holds the position its own resnapshot left.
    sequencer.snapshotPosition({ kind: "workspace", domains: ["session"] })
    const nextOutput = sequencer.publish({ cursor: output, payload: payload() })
    expect(nextOutput.prevPosition).toBe(outputHeld)
    expect(sequencer.classify(nextOutput, { cursor: output, heldPosition: outputHeld })).toBe("applied")
  })

  test("workspace coverage preserves cursor chains for old and new clients without hiding a real gap", () => {
    const sequencer = createRuntimeUiPatchSequencer()
    const a = { scope: "session", domain: "session", sessionId: "a" } as const
    const b = { scope: "session", domain: "session", sessionId: "b" } as const
    const a1 = sequencer.publish({ cursor: a, payload: payload() })
    const b2 = sequencer.publish({ cursor: b, payload: payload() })
    const base = sequencer.snapshotPosition({ kind: "workspace", domains: ["session"] })
    expect(base).toBe(2)
    const a3 = sequencer.publish({ cursor: a, payload: payload() })
    expect(a3.position).toBe(3)
    expect(a3.prevPosition).toBe(a1.position)
    expect(sequencer.classify(a3, { cursor: a, heldPosition: base })).toBe("applied")
    expect(sequencer.classify(a3, { cursor: a, heldPosition: a1.position })).toBe("applied")
    const b4 = sequencer.publish({ cursor: b, payload: payload() })
    expect(b4.prevPosition).toBe(b2.position)
    const a5 = sequencer.publish({ cursor: a, payload: payload() })
    expect(a5.prevPosition).toBe(a3.position)
    expect(sequencer.classify(a5, { cursor: a, heldPosition: base })).toBe("gap")
    expect(sequencer.classify(a5, { cursor: a, heldPosition: a3.position })).toBe("applied")
  })

  test("an empty domain observes another domain's watermark while unseen cursors still start at zero", () => {
    const sequencer = createRuntimeUiPatchSequencer()
    const output = { scope: "session", domain: "output", sessionId: "a" } as const
    const session = { scope: "session", domain: "session", sessionId: "new" } as const
    const published = sequencer.publish({ cursor: output, payload: payload() })
    const baseline = sequencer.snapshotPosition({ kind: "workspace", domains: ["session"] })
    expect(baseline).toBe(published.position)
    expect(sequencer.snapshotPosition({ kind: "cursor", cursor: session })).toBe(0)
    const first = sequencer.publish({ cursor: session, payload: payload() })
    expect(first.prevPosition).toBe(0)
    expect(first.position).toBe(2)
    expect(sequencer.classify(first, { cursor: session, heldPosition: baseline })).toBe("applied")
  })

  test("a single-cursor snapshot does not disturb an active same-domain sibling", () => {
    const sequencer = createRuntimeUiPatchSequencer()
    const first = { scope: "session", domain: "output", sessionId: "s1" } as const
    const second = { scope: "session", domain: "output", sessionId: "s2" } as const

    sequencer.publish({ cursor: first, payload: payload() })
    const secondHeld = sequencer.publish({ cursor: second, payload: payload() }).position

    expect(sequencer.snapshotPosition({ kind: "cursor", cursor: first })).toBeGreaterThan(0)

    const nextSecond = sequencer.publish({ cursor: second, payload: payload() })
    expect(nextSecond.prevPosition).toBe(secondHeld)
    expect(sequencer.classify(nextSecond, { cursor: second, heldPosition: secondHeld })).toBe("applied")
  })

  test("an equal whole-value publication mints nothing and the next change chains from the last publication", () => {
    const sequencer = createRuntimeUiPatchSequencer({ publishOnChange: true })
    const cursor = { scope: "workspace", domain: "chat_default" } as const
    const a = sequencer.publish({ cursor, payload: { kind: "chat_default.changed", chatDefault: { kind: "pending" } } })
    expect(sequencer.publish({ cursor, payload: { kind: "chat_default.changed", chatDefault: { kind: "pending" } } })).toBeUndefined()
    const b = sequencer.publish({ cursor, payload: { kind: "chat_default.changed", chatDefault: { kind: "none" } } })
    expect(b?.prevPosition).toBe(a?.position ?? -1)
    expect(b?.position).toBe((a?.position ?? -1) + 1)
  })

  test("change domains and invalidations always publish", () => {
    const sequencer = createRuntimeUiPatchSequencer({ publishOnChange: true })
    for (const fixture of [RUNTIME_UI_PATCH_FIXTURES["output.delta"], RUNTIME_UI_PATCH_FIXTURES["changes.changed"], RUNTIME_UI_PATCH_FIXTURES["roles.updated"], RUNTIME_UI_PATCH_FIXTURES["runtime.invalidate"]]) {
      const input = { cursor: fixture.cursor, payload: fixture.payload }
      const first = sequencer.publish(input)
      expect(sequencer.publish(input)?.prevPosition).toBe(first?.position ?? -1)
    }
    const status = RUNTIME_UI_PATCH_FIXTURES["status.updated"]
    sequencer.publish({ cursor: status.cursor, payload: status.payload })
    sequencer.publish({ cursor: status.cursor, payload: { kind: "runtime.invalidate", reason: "overflow" } })
    // An invalidation is the cursor's last publication, so the value after it publishes.
    expect(sequencer.publish({ cursor: status.cursor, payload: status.payload })).toBeDefined()
  })

  test("a read of the cursor's domain ends its baseline", () => {
    const sequencer = createRuntimeUiPatchSequencer({ publishOnChange: true })
    const config = RUNTIME_UI_PATCH_FIXTURES["config.changed"]
    const row = RUNTIME_UI_PATCH_FIXTURES["session.updated"]
    const publish = (fixture: { readonly cursor: RuntimeCursorIdentity; readonly payload: RuntimeUiPatchPayload }) => sequencer.publish({ cursor: fixture.cursor, payload: fixture.payload })
    publish(config)
    publish(row)
    sequencer.snapshotPosition({ kind: "cursor", cursor: config.cursor })
    expect(publish(config)).toBeDefined()
    expect(publish(row)).toBeUndefined()
    sequencer.snapshotPosition({ kind: "workspace", domains: ["config"] })
    expect(publish(row)).toBeUndefined()
    expect(publish(config)).toBeDefined()
    sequencer.snapshotPosition({ kind: "workspace", domains: [] })
    expect(publish(config)).toBeUndefined()
    sequencer.snapshotPosition({ kind: "workspace", domains: ["session", "chat_default"] })
    expect(publish(row)).toBeDefined()
  })

  test("a sequencer without publish-on-change publishes equal repeats", () => {
    const sequencer = createRuntimeUiPatchSequencer()
    const cursor = { scope: "workspace", domain: "chat_default" } as const
    const first = sequencer.publish({ cursor, payload: { kind: "chat_default.changed", chatDefault: { kind: "pending" } } })
    expect(sequencer.publish({ cursor, payload: { kind: "chat_default.changed", chatDefault: { kind: "pending" } } }).prevPosition).toBe(first.position)
  })
})
