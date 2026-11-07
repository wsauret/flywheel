import { expect, test } from "bun:test"
import { Schema } from "effect"
import { createSideQuestionHost, sideQuestionHost, type SideQuestionHost } from "../../../../../src/orchestration/modules/side-question/host.js"
import { createSideQuestionProtocol } from "../../../../../src/orchestration/modules/side-question/protocol.js"
import { sideQuestionCursor, sideQuestionDomain, sideQuestionRequestCursor, sideQuestionRequestDomain, readSideQuestionView } from "../../../../../src/protocol/modules/side-question.js"
import { moduleDomainReader } from "../../../../../src/protocol/client/module-domain.js"
import type { ConversationMessage } from "../../../../../src/orchestration/agent-runtime/llm/types.js"
import type { RuntimeUiPatchInput } from "../../../../../src/protocol/runtime-ui-protocol-types.js"
import { composeModuleRuntimes } from "../../../../../src/infra/module-runtime.js"
import { sideQuestionModule } from "../../../../../src/orchestration/modules/side-question/module.js"
import type { CommandHost } from "../../../../../src/orchestration/app-service/command-host.js"
import { createSessionFactWriter, emptyEventReader } from "../../chat/_chat-session-agent-runtime-fixtures.js"
import { asAsyncEventReadSurface } from "../../../../../src/infra/event-store-types.js"
import { testDirectories } from "../../../../helpers/directories.js"
import type { ConversationSessionEntry } from "../../../../../src/orchestration/session-store/types.js"
import { CommandOutcomeSchema } from "../../../../../src/protocol/command-catalog-protocol-schemas.js"
import type { ChatModuleHostContribution } from "../../../../../src/orchestration/chat-module-host.js"
import { composeModules } from "../../../../../src/infra/module-descriptor.js"
import type { FirstPartyModule } from "../../../../../src/orchestration/modules.js"
import { makeLifecycle } from "../../chat/_chat-runner-lifecycle-fixtures.js"

type Runner = { readonly chatModuleHosts: ReturnType<typeof composeModuleRuntimes> }

/** A session store holding resident sessions; `attach` notifies like the real store. */
function residentStore(sessions: { readonly [sessionId: string]: ConversationSessionEntry["kind"] }) {
  const entries = new Map<string, { readonly kind: ConversationSessionEntry["kind"]; readonly runner: Runner | null }>(Object.entries(sessions).map(([id, kind]) => [id, { kind, runner: null }]))
  const listeners = new Set<(changed: ReadonlySet<string> | undefined) => void>()
  return {
    get: (sessionId: string) => entries.get(sessionId),
    allIds: () => [...entries.keys()],
    onChange: (listener: (changed: ReadonlySet<string> | undefined) => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    attach(sessionId: string, runner: Runner | null) {
      entries.set(sessionId, { ...entries.get(sessionId)!, runner })
      for (const listener of listeners) listener(new Set([sessionId]))
    },
  }
}

function sideHost(run: Parameters<typeof createSideQuestionHost>[0]["run"] = async ({ onAnswer }) => { onAnswer("answer"); return { servedRequests: 0, durationMs: 0, terminal: { kind: "completed" } } }) {
  return createSideQuestionHost({ signal: new AbortController().signal, capture: async () => [], run })
}

test("reads answer only a resident host and never open a chat runner", async () => {
  for (const kind of ["chat", "subagent", "workflow-agent"] as const) {
    const patches: RuntimeUiPatchInput[] = []
    const runtime = createSideQuestionProtocol({
      enabled: () => true,
      sessionStore: residentStore({ session: kind }),
      openChatRunner: async (sessionId) => { throw new Error(`A read must not open ${sessionId}`) },
      publish: (patch) => { patches.push(patch); return undefined },
      snapshotPosition: () => 3,
      manager: { read: async () => null, createChatFromContext: async () => "unused" },
    })
    expect(await runtime.serve.sideQuestionSnapshot({ type: "sideQuestionSnapshot", sessionId: "session" })).toEqual({ view: null, snapshotPosition: 3 })
    expect(await runtime.serve.sideQuestionRequestSnapshot({ type: "sideQuestionRequestSnapshot", sessionId: "session" })).toEqual({ view: null, snapshotPosition: 3 })
    expect(patches).toEqual([])
    runtime.dispose()
  }
})

test("an attached runner's host publishes on both cursors, including a question asked outside the protocol", async () => {
  const store = residentStore({ parent: "chat" })
  const patches: RuntimeUiPatchInput[] = []
  const runtime = createSideQuestionProtocol({
    enabled: () => true,
    sessionStore: store,
    publish: (patch) => { patches.push(patch); return undefined },
    snapshotPosition: () => 0,
    manager: { read: async () => null, createChatFromContext: async () => "unused" },
  })
  const first = sideHost()
  store.attach("parent", { chatModuleHosts: composeModuleRuntimes([["side-question", first]]) })
  expect(patches.map((patch) => patch.payload)).toEqual([
    { kind: "side-question.changed", view: { revision: 0, exchanges: [] } },
    { kind: "side-question-request.changed", view: { current: null } },
  ])
  // `/btw` asks the host through the command path, not through a mutation.
  await first.ask("question")
  await first.settled()
  expect(patches.at(-1)?.payload).toMatchObject({ kind: "side-question-request.changed", view: { current: { question: "question", state: "done" } } })
  const replacement = sideHost()
  store.attach("parent", { chatModuleHosts: composeModuleRuntimes([["side-question", replacement]]) })
  expect(patches.slice(-2).map((patch) => patch.payload)).toEqual([
    { kind: "side-question.changed", view: { revision: 0, exchanges: [] } },
    { kind: "side-question-request.changed", view: { current: null } },
  ])
  const published = patches.length
  await first.ask("stale")
  await first.settled()
  expect(patches).toHaveLength(published)
  store.attach("parent", null)
  expect(patches.slice(-2).map((patch) => patch.payload)).toEqual([
    { kind: "side-question.changed", view: null },
    { kind: "side-question-request.changed", view: null },
  ])
  await replacement.ask("detached")
  await replacement.settled()
  expect(patches).toHaveLength(published + 2)
  runtime.dispose()
  await Promise.all([first.dispose(), replacement.dispose()])
})

test("a store change for one session reads only that session, however many chats are resident", async () => {
  for (const residents of [3, 30]) {
    const ids = Array.from({ length: residents }, (_, index) => `chat-${index}`)
    const store = residentStore(Object.fromEntries(ids.map((id) => [id, "chat"])))
    let gets = 0
    const patches: RuntimeUiPatchInput[] = []
    const runtime = createSideQuestionProtocol({
      enabled: () => true,
      sessionStore: { ...store, get: (sessionId) => { gets++; return store.get(sessionId) } },
      publish: (patch) => { patches.push(patch); return undefined },
      snapshotPosition: () => 0,
      manager: { read: async () => null, createChatFromContext: async () => "unused" },
    })
    const hosts = ids.map((id) => { const host = sideHost(); store.attach(id, { chatModuleHosts: composeModuleRuntimes([["side-question", host]]) }); return host })
    gets = 0
    patches.length = 0
    const replacement = sideHost()
    store.attach("chat-1", { chatModuleHosts: composeModuleRuntimes([["side-question", replacement]]) })
    expect(gets).toBe(1)
    expect(patches.map((patch) => patch.cursor)).toEqual([sideQuestionCursor("chat-1"), sideQuestionRequestCursor("chat-1")])
    runtime.dispose()
    await Promise.all([...hosts, replacement].map((host) => host.dispose()))
  }
})

test("session snapshot and whole patches share history, keep captured context, and reset when disabled", async () => {
  let enabled = true
  const completed = Promise.withResolvers<void>()
  let answer: (text: string) => void = () => {}
  const constructed: SideQuestionHost[] = []
  const disposed: SideQuestionHost[] = []
  const contribution: ChatModuleHostContribution = { handle: sideQuestionHost, create: () => {
    const created = createSideQuestionHost({
      signal: new AbortController().signal,
      capture: async () => [{ kind: "user", content: "captured parent" }],
      run: async ({ onAnswer }) => { answer = onAnswer; await completed.promise; return { servedRequests: 0, durationMs: 0, terminal: { kind: "completed" } } },
    })
    const dispose = created.dispose
    created.dispose = () => { disposed.push(created); return dispose() }
    constructed.push(created)
    return created
  } }
  const module = {
    id: "side-question", dependencies: [], availability: { kind: "available" },
    contributions: [{ domain: "chatHosts", id: "side-question", value: contribution }],
    observers: [], transformers: [], gates: [],
  } as const satisfies FirstPartyModule
  // The real chat lifecycle owns the hosts and retires one whose module the selection no longer includes.
  const { lifecycle } = makeLifecycle({ moduleSelection: () => composeModules([module], { disabledModuleIds: enabled ? [] : ["side-question"] }) })
  const { chatModuleHosts } = lifecycle
  const host = constructed[0]!
  const patches: RuntimeUiPatchInput[] = []
  const kept: ConversationMessage[][] = []
  const store = residentStore({ parent: "chat" })
  let opened = 0
  const runtime = createSideQuestionProtocol({
    enabled: () => enabled,
    sessionStore: store,
    openChatRunner: async () => {
      opened++
      if (!store.get("parent")?.runner) store.attach("parent", { chatModuleHosts })
      return store.get("parent")?.runner ?? undefined
    },
    publish: (patch) => { patches.push(patch); return undefined },
    snapshotPosition: (scope) => scope.kind === "cursor" && scope.cursor.domain === "side-question-request" ? 9 : 7,
    manager: {
      read: async () => null,
      createChatFromContext: async (sessionId, messages) => { expect(sessionId).toBe("parent"); kept.push([...messages]); return "destination" },
    },
  })
  expect((await runtime.serve.sideQuestionSnapshot({ type: "sideQuestionSnapshot", sessionId: "parent" })).view).toBeNull()
  expect(opened).toBe(0)
  store.attach("parent", { chatModuleHosts })
  const first = await runtime.serve.sideQuestionSnapshot({ type: "sideQuestionSnapshot", sessionId: "parent" })
  expect(first).toEqual({ snapshotPosition: 7, view: { revision: 0, exchanges: [] } })
  const requestFirst = await runtime.serve.sideQuestionRequestSnapshot({ type: "sideQuestionRequestSnapshot", sessionId: "parent" })
  expect(requestFirst).toEqual({ snapshotPosition: 9, view: { current: null } })
  const asked = await runtime.mutate["side-question.ask"]({ type: "side-question.ask", sessionId: "parent", question: "question" })
  expect(asked.ok).toBe(true)
  expect(opened).toBe(1)
  const controlCount = patches.filter((patch) => patch.payload.kind === "side-question.changed").length
  for (let chunk = 1; chunk <= 128; chunk++) answer(`answer ${chunk}`)
  expect(patches.filter((patch) => patch.payload.kind === "side-question.changed")).toHaveLength(controlCount)
  const runningRequest = await runtime.serve.sideQuestionRequestSnapshot({ type: "sideQuestionRequestSnapshot", sessionId: "parent" })
  expect(runningRequest.snapshotPosition).toBe(9)
  const latest = Schema.decodeUnknownSync(sideQuestionRequestDomain.patch)(patches.at(-1)!.payload)
  expect(sideQuestionRequestDomain.view.patch(latest, undefined)).toEqual(runningRequest.view)
  answer("answer")
  completed.resolve()
  await host.settled()
  const snapshot = await runtime.serve.sideQuestionSnapshot({ type: "sideQuestionSnapshot", sessionId: "parent" })
  expect(snapshot.view?.exchanges).toHaveLength(1)
  const id = snapshot.view!.exchanges[0]!.id
  const controlPatch = patches.findLast((candidate) => candidate.payload.kind === "side-question.changed")!
  const decoded = Schema.decodeUnknownSync(sideQuestionDomain.patch)(controlPatch.payload)
  expect(sideQuestionDomain.view.patch(decoded, undefined)).toEqual(snapshot.view)
  expect(JSON.stringify(decoded)).not.toContain("captured parent")
  const requestSnapshot = await runtime.serve.sideQuestionRequestSnapshot({ type: "sideQuestionRequestSnapshot", sessionId: "parent" })
  expect(readSideQuestionView(moduleDomainReader((domain) =>
    domain.domain === sideQuestionDomain.domain ? snapshot.view : domain.domain === sideQuestionRequestDomain.domain ? requestSnapshot.view : undefined,
  ))).toEqual(host.snapshot())
  expect(readSideQuestionView(moduleDomainReader(() => undefined))).toBeUndefined()
  expect(await runtime.mutate["side-question.keep"]({ type: "side-question.keep", sessionId: "parent", exchangeId: id })).toEqual({ ok: true, destinationSessionId: "destination" })
  expect(opened).toBe(2)
  expect(kept).toEqual([[{ kind: "user", content: "captured parent" }, { kind: "user", origin: "human", content: "question" }, { kind: "assistant", content: "answer" }]])
  enabled = false
  expect((await runtime.serve.sideQuestionSnapshot({ type: "sideQuestionSnapshot", sessionId: "parent" })).view).toBeNull()
  expect(patches.slice(-2).map((patch) => patch.payload)).toEqual([
    { kind: "side-question.changed", view: null },
    { kind: "side-question-request.changed", view: null },
  ])
  expect((await runtime.serve.sideQuestionRequestSnapshot({ type: "sideQuestionRequestSnapshot", sessionId: "parent" })).view).toBeNull()
  expect((await runtime.mutate["side-question.ask"]({ type: "side-question.ask", sessionId: "parent", question: "off" })).ok).toBe(false)
  expect(disposed).toEqual([host])
  enabled = true
  expect((await runtime.serve.sideQuestionSnapshot({ type: "sideQuestionSnapshot", sessionId: "parent" })).view).toEqual({ revision: 0, exchanges: [] })
  expect(constructed).toHaveLength(2)
  await lifecycle.terminateBackgroundWorks()
  runtime.dispose()
})

test("bare /btw opens the resident surface without a parent turn; an argument starts its owned request", async () => {
  let requests = 0
  const host = createSideQuestionHost({
    signal: new AbortController().signal,
    capture: async () => [],
    run: async ({ onAnswer }) => { requests++; onAnswer("answer"); return { servedRequests: 0, durationMs: 0, terminal: { kind: "completed" } } },
  })
  const command = sideQuestionModule.contributions.find((entry) => entry.domain === "commands")
  if (!command || command.domain !== "commands") throw new Error("Missing side command")
  const commandHost: CommandHost = {
    directories: testDirectories("/scratch"),
    authDirectory: () => "/scratch/auth",
    projectionReader: asAsyncEventReadSurface(emptyEventReader()),
    runOwnedCommand: undefined,
    session: {
      id: "parent", executionCwd: "/scratch", host: async (handle) => composeModuleRuntimes([["side-question", host]]).get(handle),
      prompt: async () => { throw new Error("A side command must not send a parent turn") },
      startMethod: async () => { throw new Error("A side command must not start a parent method") },
      capabilities: async () => { throw new Error("A side command must not plan a parent request") },
      systemLine: async () => { throw new Error("A side command must not write parent history") },
      review: async () => false, interrupt: () => { throw new Error("A side command must not interrupt its parent") },
      compact: async () => { throw new Error("A side command must not compact its parent") },
      fork: async () => { throw new Error("A side command must not create a session") },
      runtime: () => undefined, facts: createSessionFactWriter, readInFlight: async () => [],
    },
  }
  const opened = await command.value.execute(commandHost, undefined)
  expect(Schema.decodeUnknownSync(CommandOutcomeSchema)(Schema.encodeSync(CommandOutcomeSchema)(opened))).toEqual({ kind: "open", surface: "side-question", sessionId: "parent" })
  expect(requests).toBe(0)
  expect(await command.value.execute(commandHost, "question")).toEqual({ kind: "open", surface: "side-question", sessionId: "parent" })
  await host.settled()
  expect(requests).toBe(1)
  await host.dispose()
})
