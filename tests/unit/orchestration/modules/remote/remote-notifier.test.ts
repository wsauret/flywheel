import { describe, expect, test } from "bun:test"
import { Redacted } from "effect"

import type { WebPushMessage, WebPushOutcome } from "../../../../../src/infra/web-push.js"
import type { PushTarget } from "../../../../../src/orchestration/modules/remote/remote-access.js"
import { createRemoteNotifier, type RemoteNotifierOptions } from "../../../../../src/orchestration/modules/remote/remote-notifier.js"
import type { FrontendEvent, SessionCatalogRow } from "../../../../../src/protocol/app-service-types.js"
import type { StatusView } from "../../../../../src/protocol/status-protocol-types.js"

/** The notifier reads the same patches every client reads. These tests feed it
 *  the patch shapes the runtime publishes and check its one rule: a phone hears
 *  only about a chat that waits on the person's answer. */

const status = (activity: StatusView["activity"]): StatusView => ({
  activity,
  activityStartedAt: 0,
  settledOutputPosition: activity === "idle" ? 0 : null,
  connectionState: "connected",
  activeSubagentCount: 0,
  activeBackgroundCommands: [],
  activeForegroundBashToolCallIds: [], processorHeldToolCallIds: [],
  waitingOnBackgroundWork: false,
  startedAt: 0,
  streamingStartedAt: null,
  accumulatedActiveMs: 0,
  compactionStartedAt: null, replyWaits: [],
})

const patch = (sessionId: string, payload: Extract<FrontendEvent, { type: "patch" }>["patch"]["payload"], domain: "status" | "workflow_view" | "session" | "question" = "status"): FrontendEvent => ({
  type: "patch",
  patch: { cursor: domain === "workflow_view" ? { scope: "workflow", domain, workflowId: sessionId } : { scope: "session", domain, sessionId }, position: 1, prevPosition: 0, payload },
})

const question = (id: string) => patch("s1", { kind: "question.updated", question: { kind: "question", toolUseId: id, questions: [], timestamp: 0 } }, "question")

const row = (title: string): SessionCatalogRow => ({ id: "s1", title, kind: "chat", lifecycleState: "active", notices: [], inputMode: { kind: "chat" }, lastUpdated: "2026-09-04T00:00:00Z", executionCwd: "/work", totalsLoading: true })

const target: PushTarget = {
  deviceId: "dev",
  label: "phone",
  subscription: { endpoint: "https://push.example.net/x", expirationTime: null, keys: { p256dh: "k", auth: "a" } },
  vapid: { publicKey: "pub", privateKey: Redacted.make("priv") },
}

describe("remote notifier", () => {
  function harness(overrides: Pick<RemoteNotifierOptions, "send"> & Partial<Pick<RemoteNotifierOptions, "forgetSubscription">> = {}) {
    const listeners = new Set<(event: FrontendEvent) => void>()
    const sent: WebPushMessage[] = []
    const forgotten: string[] = []
    let outcome: WebPushOutcome = { kind: "delivered", status: 201 }
    const notifier = createRemoteNotifier({
      addListener: (listener) => { listeners.add(listener) },
      removeListener: (listener) => { listeners.delete(listener) },
      targets: () => [target],
      forgetSubscription: async (deviceId, subscription) => { forgotten.push(deviceId); expect(subscription).toEqual(target.subscription); await overrides.forgetSubscription?.(deviceId, subscription) },
      appOrigin: "https://remote.example.test",
      address: async () => ({ runtimeId: "machine", placementId: "project", machine: "Laptop", project: "Flywheel" }),
      subject: "https://flywl.sh",
      send: async (input) => { sent.push(input.message); return overrides.send ? overrides.send(input) : outcome },
      coalesceMs: 0,
    })
    const emit = (event: FrontendEvent) => { for (const listener of listeners) listener(event) }
    return { notifier, sent, forgotten, emit, setOutcome: (next: WebPushOutcome) => { outcome = next } }
  }
  const settle = () => new Promise((resolve) => setTimeout(resolve, 20))

  test("pushes a pending question with the session title and an attention link", async () => {
    const h = harness()
    h.emit(patch("s1", { kind: "session.added", row: row("Fix the flaky test") }, "session"))
    h.emit(question("q1"))
    await settle()
    expect(h.sent).toEqual([{ title: "Flywheel has a question · Laptop · Flywheel", body: "Fix the flaky test", url: "https://remote.example.test/#runtime=machine&placement=project&session=s1&attention=question", tag: "s1:q1" }])
    await h.notifier.dispose()
  })

  test("stays silent when a turn ends or a workflow pauses or fails", async () => {
    const h = harness()
    h.emit(patch("s1", { kind: "status.updated", status: status("generating") }))
    h.emit(patch("s1", { kind: "status.updated", status: status("idle") }))
    for (const state of ["paused", "failed", "completed"] as const) {
      h.emit(patch("s1", { kind: "workflow_view.updated", workflowView: { attempts: [], tree: { nodes: [] }, attemptsStatus: "loaded", state } }, "workflow_view"))
    }
    await settle()
    expect(h.sent).toEqual([])
    await h.notifier.dispose()
  })

  test("cancels answered questions, ignores repeated updates, and alerts for each new question", async () => {
    const h = harness()
    h.emit(question("answered"))
    h.emit(patch("s1", { kind: "question.removed" }, "question"))
    await settle()
    expect(h.sent).toEqual([])
    h.emit(question("q1"))
    await settle()
    h.emit(question("q1"))
    await settle()
    expect(h.sent).toHaveLength(1)
    h.emit(question("q2"))
    await settle()
    expect(h.sent.map((message) => message.tag)).toEqual(["s1:q1", "s1:q2"])
    await h.notifier.dispose()
  })

  test("delivers nothing after disposal", async () => {
    const h = harness()
    h.emit(question("q1"))
    await h.notifier.dispose()
    await settle()
    expect(h.sent).toEqual([])
  })

  test("aborts and joins pending delivery without forgetting a late gone subscription", async () => {
    const started = Promise.withResolvers<AbortSignal>()
    const pending = Promise.withResolvers<WebPushOutcome>()
    const h = harness({ send: (input) => { started.resolve(input.signal); return pending.promise } })
    h.emit(question("q1"))
    const signal = await started.promise
    const closing = h.notifier.dispose()
    expect(h.notifier.dispose()).toBe(closing)
    expect(signal.aborted).toBe(true)
    let closed = false
    void closing.then(() => { closed = true })
    await Promise.resolve()
    expect(closed).toBe(false)
    pending.resolve({ kind: "gone", status: 410 })
    await closing
    expect(h.forgotten).toEqual([])
    h.emit(question("q2"))
    await Promise.resolve()
    expect(h.sent).toHaveLength(1)
  })

  test("joins subscription removal already admitted before disposal", async () => {
    const started = Promise.withResolvers<void>()
    const pending = Promise.withResolvers<void>()
    const h = harness({ forgetSubscription: () => { started.resolve(); return pending.promise } })
    h.setOutcome({ kind: "gone", status: 410 })
    h.emit(question("q1"))
    await started.promise
    let closed = false
    const closing = h.notifier.dispose().then(() => { closed = true })
    await Promise.resolve()
    expect(closed).toBe(false)
    pending.resolve()
    await closing
    expect(h.forgotten).toEqual(["dev"])
  })
})
