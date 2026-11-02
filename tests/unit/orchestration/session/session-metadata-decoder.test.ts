import { describe, expect, test } from "bun:test"
import { resolve } from "node:path"

/** Directory authorities are canonical for the running platform: a POSIX
 *  literal resolves onto the current drive on Windows and is not canonical. */
const WORKSPACE = resolve("/workspace")
import { decodeSessionMetadataFactForReplay, parseSessionMetadataFact, type SessionMetadataFact } from "../../../../src/orchestration/session/session-metadata-facts.js"

const now = "2026-01-01T00:00:00.000Z"
const facts: readonly SessionMetadataFact[] = [
  { type: "session.created", version: 5, actor: "flywheel", payload: { kind: "chat", command: "chat", conversationId: "conversation", label: "Chat", name: "Chat", lastUpdated: now, lifecycleState: "inactive", executionCwd: WORKSPACE, createdAt: now, repo: "repo", branch: "main" } },
  { type: "session.label.updated", version: 1, actor: "flywheel", payload: { label: "Label", shortLabel: "Short", name: "Name", lastUpdated: now } },
  { type: "session.lifecycle.changed", version: 1, actor: "flywheel", payload: { lifecycleState: "active", activatedAt: now, lastUpdated: now } },
  { type: "session.chat_metadata.updated", version: 1, actor: "flywheel", payload: { providerConversationId: "provider", seedContext: "seed", lastUpdated: now } },
  { type: "session.execution_cwd.updated", version: 1, actor: "flywheel", payload: { executionCwd: WORKSPACE, lastUpdated: now } },
  { type: "session.roles.snapshotted", version: 1, actor: "flywheel", payload: { roles: { implementer: { model: "model", effort: "high", provider: "provider" } }, lastUpdated: now } },
  { type: "session.roles.snapshotted", version: 2, actor: "flywheel", payload: { roles: { implementer: { model: "model", effort: "high" } }, lastUpdated: now } },
  { type: "session.roles.updated", version: 1, actor: "flywheel", payload: { roleId: "implementer", assignment: { model: "model", effort: "high", provider: "provider" }, lastUpdated: now } },
  { type: "session.roles.updated", version: 2, actor: "flywheel", payload: { roleId: "implementer", assignment: { model: "model", effort: "high" }, lastUpdated: now } },
  { type: "session.roles.removed", version: 1, actor: "flywheel", payload: { roleId: "implementer", lastUpdated: now } },
  { type: "session.child.linked", version: 1, actor: "flywheel", payload: { childSessionId: "child", lastUpdated: now } },
  { type: "session.child.unlinked", version: 1, actor: "flywheel", payload: { childSessionId: "child", lastUpdated: now } },
  { type: "session.deleted", version: 1, actor: "flywheel", payload: { lastUpdated: now } },
  { type: "session.auth.profile.selected", version: 1, actor: "flywheel", payload: { authProfileId: "default" } },
]

/** The creation fixture as its own descriptor, so a test can read the fields
 *  only a creation payload carries. */
function createdFixture(): Extract<SessionMetadataFact, { type: "session.created"; version: 5 }> {
  const created = parseSessionMetadataFact(facts[0])
  if (created?.type !== "session.created" || created.version !== 5) throw new Error("the first fixture is the creation fact")
  return created
}

describe("session metadata replay decoder", () => {
  test("is strictly equivalent for every current descriptor", () => {
    for (const fact of facts) expect(decodeSessionMetadataFactForReplay(fact)).toEqual(parseSessionMetadataFact(fact))
  })

  test("tolerates excess properties for every tolerant descriptor", () => {
    for (const fact of facts.filter((candidate) => candidate.type !== "session.auth.profile.selected")) {
      const decorated = { ...fact, retiredEnvelopeField: true, payload: { ...fact.payload, retiredPayloadField: true } }
      expect(decodeSessionMetadataFactForReplay(decorated)).toEqual(fact)
    }
  })

  test("rejects excess properties on the current auth profile fact", () => {
    const fact = facts.find((candidate) => candidate.type === "session.auth.profile.selected")
    if (!fact) throw new Error("missing auth profile fact fixture")
    expect(decodeSessionMetadataFactForReplay({ ...fact, payload: { ...fact.payload, retiredPayloadField: true } })).toBeUndefined()
  })

  test("preserves every valid current creation field while removing excess properties", () => {
    const created = createdFixture()
    expect(decodeSessionMetadataFactForReplay({ ...created, payload: { ...created.payload, retired: true } })).toEqual(created)
  })

  test("creation rows the current schema refuses replay through the one salvage rule", () => {
    const created = createdFixture()
    const replayTimestamp = Date.parse("2026-02-01T00:00:00.000Z")
    // Stored rows are JSON: a field the writer of that day did not know is
    // absent, never present as undefined.
    const { executionCwd: _absent, lastUpdated: _unrecorded, ...historicalPayload } = created.payload
    for (const version of [1, 2, 3]) {
      const historical = { ...created, version, payload: historicalPayload }
      // No execution directory is invented: the replayed session omits it and
      // the path-sensitive resolver selects one at use (ARCH-DIRECTORIES-007).
      expect<unknown>(decodeSessionMetadataFactForReplay(historical, replayTimestamp)).toEqual({
        ...created,
        version,
        payload: { ...historicalPayload, lastUpdated: new Date(replayTimestamp).toISOString() },
      })
    }
  })

  test("normalizes previous launch identifiers for every session kind", () => {
    const fact = {
      type: "session.created",
      version: 3,
      actor: "flywheel",
      payload: {
        kind: "subagent",
        command: "subagent",
        conversationId: "child-conversation",
        label: "Inspect the runtime",
        lastUpdated: now,
        lifecycleState: "active",
        executionCwd: WORKSPACE,
        launchedFrom: { parentSessionId: "parent", toolCallId: "tool-1" },
      },
    } as const

    const decoded = decodeSessionMetadataFactForReplay(fact)
    expect(decoded?.type === "session.created" ? decoded.payload.launchedFrom : undefined).toEqual({
      parentSessionId: "parent",
      toolUseId: "tool-1",
    })
    for (const variant of [
      { kind: "workflow", command: "workflow", workflowDefinitionId: "implement" },
      { kind: "chat", command: "chat" },
    ] as const) {
      const historical = decodeSessionMetadataFactForReplay({ ...fact, payload: { ...fact.payload, ...variant } })
      expect(historical?.type === "session.created" ? historical.payload.launchedFrom : undefined).toEqual({
        parentSessionId: "parent",
        toolUseId: "tool-1",
      })
    }
    // The recorded execution directory survives salvage (ARCH-DIRECTORIES-006).
    expect(decoded?.type === "session.created" ? decoded.payload.executionCwd : undefined).toBe(WORKSPACE)
    // A non-canonical recorded directory never makes the row unreadable; it is
    // omitted so the resolver selects the project root.
    const relative = decodeSessionMetadataFactForReplay({ ...fact, payload: { ...fact.payload, executionCwd: "relative/dir" } })
    expect(relative?.type).toBe("session.created")
    expect(relative?.type === "session.created" ? "executionCwd" in relative.payload : true).toBe(false)
  })

  test("a decoration no registered version reads is undefined rather than repaired", () => {
    expect(decodeSessionMetadataFactForReplay({ type: "session.label.updated", version: 1, actor: "flywheel", payload: { lastUpdated: 42 } })).toBeUndefined()
  })
})
