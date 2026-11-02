import assert from "node:assert/strict"
import { test } from "node:test"

import { createRuntimeSession } from "./session.js"
import type { FrontendMutation, SessionCatalogRow } from "../../../src/protocol/app-service-types.js"
import type { RuntimeConnection } from "../../../src/protocol/client/connection.js"
import type { CommandOutcome } from "../../../src/protocol/command-catalog-protocol-types.js"
import { UNKNOWN_COMMAND_NOTICE } from "../../../src/protocol/client/slash-route.js"
import { fakeRuntimeConnection } from "./runtime-connection-fixture.js"
import { authView, settle } from "./session-connection-fixture.js"

interface ForkConnection extends RuntimeConnection {
  readonly dispatched: readonly FrontendMutation[]
  readonly sequence: readonly string[]
}

function chatRow(id: string, title: string): SessionCatalogRow {
  return { id, kind: "chat", title, shortTitle: title, lifecycleState: "inactive", activity: "idle", inputMode: { kind: "chat" }, createdAt: "2026-01-01T00:00:00.000Z", lastUpdated: "2026-01-01T00:00:00.000Z", executionCwd: "/workspace", notices: [], totalsLoading: true }
}

/** The id a `chat.open` names its chat by, which has a session id's shape. */
function assertNamedOpen(command: unknown): string {
  const sessionId = typeof command === "object" && command !== null && "sessionId" in command ? command.sessionId : undefined
  assert.ok(typeof sessionId === "string" && /^[0-9a-f]{12}$/.test(sessionId), "the open names its chat")
  return sessionId
}

const FORK_CATALOG = {
  revision: 3, snapshotPosition: 0,
  commands: [{ name: "ship", title: "Ship", description: "Commit and push", aliases: [] }],
  builtInCommands: [{ id: "fork", title: "Fork", description: "Fork this chat", aliases: ["branch"] }], offCommands: [],
}

function forkConnection(rows: readonly SessionCatalogRow[], forkResult: CommandOutcome): ForkConnection {
  const dispatched: FrontendMutation[] = []
  const sequence: string[] = []
  let snapshots = 0
  let opened = false
  const connection = fakeRuntimeConnection({
    queries: {
      snapshot: () => {
        snapshots += 1
        sequence.push(`snapshot:${snapshots}`)
        const destination = snapshots > 1 && forkResult.kind === "focus-session" ? [chatRow(forkResult.sessionId, "Forked chat")] : []
        return {
          rows: [...rows, ...(opened ? [chatRow("opened", "Opened chat")] : []), ...destination], activeRuntimeCount: 0, errors: [], snapshotPosition: snapshots,
          runtimeVersion: "test", runtimeBuildId: null, projectRoot: "/workspace", chatDefault: { kind: "none" }, executor: { kind: "serving" }, service: { kind: "serving" },
        }
      },
      commandCatalog: () => {
        sequence.push("commandCatalog")
        return FORK_CATALOG
      },
      authStatusSnapshot: () => ({ snapshotPosition: 0, auth: authView([]) }),
      outputWindow: (request) => {
        sequence.push(`transcript:${request.sessionId}`)
        return { snapshotPosition: 0, totalBlocks: 0, visibleMessageCount: 0, range: {
          kind: "ok", consistencyToken: "fixture", anchor: { kind: "tail" }, streamingToolText: {}, streamingOutputChars: 0, blocks: [],
          window: { startBlockIndex: 0, endBlockIndex: -1, hasBefore: false, hasAfter: false, contentBytes: 0 },
        } }
      },
    },
    mutations: {
      "chat.open": () => {
        opened = true
        return { ok: true, sessionId: "opened" }
      },
      "session.activate": () => ({ ok: true }),
      "command.invoke": () => forkResult,
    },
    onDispatch: (command) => {
      dispatched.push(command)
      sequence.push(`dispatch:${command.type}`)
    },
  })
  return { ...connection, dispatched, sequence }
}

test("a built-in invokes through the runtime with the rendered revision and opens the session its outcome focuses before refreshing", async () => {
  const source = chatRow("source", "Source")
  const connection = forkConnection([source], { kind: "focus-session", sessionId: "destination" })
  const session = createRuntimeSession({ connection })
  await settle()

  const outcome = await session.invokeCommand("source", "branch")

  assert.deepEqual(outcome, { kind: "focus-session", sessionId: "destination" })
  assert.deepEqual(connection.dispatched, [{ type: "session.activate", sessionId: "source" }, { type: "command.invoke", id: "fork", revision: 3, sessionId: "source" }, { type: "session.activate", sessionId: "destination" }])
  assert.equal(session.sessionId, "destination")
  assert.ok(connection.sequence.indexOf("transcript:destination") < connection.sequence.indexOf("snapshot:2"))
  assert.equal(source.id, "source")
  session.dispose()
})

test("a built-in without a selected session opens a chat first and runs in it", async () => {
  const connection = forkConnection([], { kind: "none" })
  const session = createRuntimeSession({ connection })
  await settle()

  const outcome = await session.invokeCommand(await session.newChat(), "fork")

  assert.deepEqual(outcome, { kind: "none" })
  assert.deepEqual(connection.dispatched, [{ type: "chat.open", sessionId: assertNamedOpen(connection.dispatched[0]) }, { type: "session.activate", sessionId: "opened" }, { type: "command.invoke", id: "fork", revision: 3, sessionId: "opened" }])
  assert.equal(session.sessionId, "opened")
  session.dispose()
})

test("a refused outcome retains the source and opens no destination", async () => {
  const source = chatRow("source", "Source")
  const connection = forkConnection([source], { kind: "warning", message: "Fork rejected" })
  const session = createRuntimeSession({ connection })
  await settle()

  assert.deepEqual(await session.invokeCommand("source", "fork"), { kind: "warning", message: "Fork rejected" })

  assert.equal(session.sessionId, "source")
  assert.equal(connection.sequence.includes("transcript:destination"), false)
  session.dispose()
})

test("a stale outcome re-reads the catalog", async () => {
  const source = chatRow("source", "Source")
  const connection = forkConnection([source], { kind: "stale" })
  const session = createRuntimeSession({ connection })
  await settle()
  const catalogReads = connection.sequence.filter((step) => step === "commandCatalog").length

  assert.deepEqual(await session.invokeCommand("source", "fork"), { kind: "stale" })

  assert.equal(connection.sequence.filter((step) => step === "commandCatalog").length, catalogReads + 1)
  session.dispose()
})

test("a skill id or any name outside the built-in roster answers the unknown-command notice and reaches no runtime", async () => {
  const source = chatRow("source", "Source")
  const connection = forkConnection([source], { kind: "none" })
  const session = createRuntimeSession({ connection })
  await settle()

  assert.deepEqual(await session.invokeCommand("source", "ship", "carefully"), { kind: "unavailable", message: UNKNOWN_COMMAND_NOTICE })

  assert.deepEqual(connection.dispatched, [{ type: "session.activate", sessionId: "source" }])
  session.dispose()
})
