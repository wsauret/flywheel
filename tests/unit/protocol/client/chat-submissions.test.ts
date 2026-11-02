import { describe, expect, it } from "bun:test"
import type { ChatInputLike } from "../../../../src/infra/chat-input.js"
import { adoptedBlocks, createChatSubmissions, UNCONFIRMED_COMMAND, undeliveredNotice, WAITING_RECALL, type ChatSubmissionResult, type ChatSubmissionsDeps } from "../../../../src/protocol/client/chat-submissions.js"
import { RuntimeLaneLost } from "../../../../src/protocol/client/connection-failures.js"
import { createComposerReturns } from "../../../../src/protocol/client/composer-returns.js"
import type { ClaimComposerReturnsResult } from "../../../../src/protocol/composer-returns.js"

/** A resident window that reaches the session's first block, so it proves
 *  nothing about the messages it does not hold. */
const WHOLE = { startBlockIndex: 0 }

/** A connection whose lanes the test opens. */
function testLanes() {
  const listeners = new Set<(lane: number) => void>()
  let lane = 0
  return {
    onLane(listener: (lane: number) => void) { listeners.add(listener); return () => { listeners.delete(listener) } },
    open() { lane += 1; for (const listener of listeners) listener(lane) },
  }
}

const lostWithItsLane = () => Promise.reject(new RuntimeLaneLost(new Error("the lane the call ran on ended")))

/** The owner with no lane that ever opens, for behavior that never resends. */
function submissionsOf(deps: Omit<ChatSubmissionsDeps, "lanes">) {
  return createChatSubmissions({ lanes: testLanes(), ...deps })
}

/** Lets every settled promise run its continuations. */
const drainMicrotasks = async () => { for (let turn = 0; turn < 10; turn++) await Promise.resolve() }

describe("shared chat submissions", () => {
  it("a parent return notice retires the child's accepted local submission even without winning its claim", async () => {
    const submissions = createChatSubmissions({ lanes: testLanes(), dispatch: async () => ({ ok: true }), now: () => 1 })
    await submissions.send("child", { text: "unread" })
    expect(submissions.pending("child")).toHaveLength(1)
    const id = submissions.pending("child")[0]!.id
    submissions.observe("parent", [{ kind: "system", id: `returned-input:child:person:${id}`, message: "Child finished", timestamp: 2 }], WHOLE)
    expect(submissions.pending("child")).toEqual([])
  })
  for (const claim of ["claimed", "no_match"] as const) it(`only the sender claims after queued delivery and retires ownership when the claim is ${claim}`, async () => {
    const lanes = testLanes()
    const submissions = submissionsOf({ dispatch: async (_sessionId, input) => ({ ok: true, confirmedSubmissionIds: input.submissionIds, inTranscript: true }) })
    await submissions.send("child", { text: "unread" })
    const id = submissions.pending("child")[0]!.id
    submissions.observe("child", [{ kind: "userMessage", id: "queued-child-message", content: "unread", timestamp: 0, pending: true, injected: false, submissionIds: [id] }], WHOLE)
    expect(submissions.pending("child")).toEqual([])
    expect(submissions.ownsSubmission(id)).toBe(true)
    const requests: PromiseWithResolvers<ClaimComposerReturnsResult>[] = []
    const claimedIds: string[][] = []
    const inserted: string[] = []
    const coordinator = createComposerReturns({ client: { ...lanes, dispatch: async (mutation) => { claimedIds.push([...mutation.submissionIds]); const request = Promise.withResolvers<ClaimComposerReturnsResult>(); requests.push(request); return request.promise } }, ownsSubmission: submissions.ownsSubmission, settled: (ids) => submissions.settleReturned(ids), append: (_id, item) => { inserted.push(item.input.text) }, report: () => {} })
    let otherClaims = 0
    const otherInserted: string[] = []
    const otherSubmissions = submissionsOf({ dispatch: async () => ({ ok: true }) })
    const other = createComposerReturns({ client: { ...lanes, dispatch: async () => { otherClaims++; return { ok: true, kind: "empty" } } }, ownsSubmission: otherSubmissions.ownsSubmission, settled: (ids) => otherSubmissions.settleReturned(ids), append: (_id, item) => { otherInserted.push(item.input.text) }, report: () => {} })
    other.own(["parent"])
    coordinator.own(["parent", "other"])
    await drainMicrotasks()
    expect(requests).toHaveLength(0)
    for (let n = 0; n < 40; n++) coordinator.observe(n % 2 ? "parent" : "other", { kind: "deltas", replaced: [], structural: false, streamingChanged: true })
    await drainMicrotasks()
    expect(requests).toHaveLength(0)
    const returned = { kind: "deltas" as const, replaced: [{ localIndex: 0, prior: undefined, next: { kind: "system" as const, id: `returned-input:child:person:${id}`, message: "unread", timestamp: 1 }, appendedText: "" }], structural: true, streamingChanged: false }
    other.observe("parent", returned)
    await drainMicrotasks()
    expect(otherClaims).toBe(0)
    coordinator.observe("parent", returned)
    submissions.observe("parent", adoptedBlocks(returned), WHOLE)
    expect(submissions.pending("child")).toEqual([])
    expect(submissions.ownsSubmission(id)).toBe(true)
    await drainMicrotasks()
    coordinator.observe("parent", returned)
    coordinator.observe("parent", returned)
    expect(requests).toHaveLength(1)
    expect(claimedIds).toEqual([[id]])
    requests[0]!.resolve(claim === "claimed" ? { ok: true, kind: "claimed", items: [{ noticeId: `returned-input:child:person:${id}`, sourceSessionId: "child", sourceName: "Child", input: { text: "unread", submissionIds: [id] } }] } : { ok: true, kind: "no_match" })
    await drainMicrotasks()
    expect(submissions.ownsSubmission(id)).toBe(false)
    expect(inserted).toEqual(claim === "claimed" ? ["unread"] : [])
    expect(otherInserted).toEqual([])
    coordinator.observe("parent", returned)
    coordinator.observe("parent", { kind: "window", reason: "older", adopted: [] })
    coordinator.observe("parent", { kind: "window", reason: "merge", adopted: [] })
    lanes.open()
    await drainMicrotasks()
    expect(requests).toHaveLength(1)
    expect(otherClaims).toBe(0)
    coordinator.dispose()
    other.dispose()
  })
  it("tells its subscribers about each change and replaces only the changed session's array", async () => {
    const request = Promise.withResolvers<{ ok: false; error: string }>()
    const submissions = submissionsOf({ dispatch: () => request.promise })
    let changes = 0
    const stop = submissions.subscribe(() => { changes += 1 })
    const empty = submissions.pending("other")
    const sending = submissions.send("s", { text: "hello" })
    const queued = submissions.pending("s")
    expect(changes).toBe(1)
    expect(queued.map((entry) => entry.input.text)).toEqual(["hello"])
    expect(submissions.pending("s")).toBe(queued)
    expect(submissions.pending("other")).toBe(empty)
    request.resolve({ ok: false, error: "Disconnected" })
    await sending
    expect(changes).toBe(2)
    expect(submissions.pending("s")).not.toBe(queued)
    expect(queued[0]?.delivery).toEqual({ kind: "sending" })
    stop()
    expect(submissions.recallLocal("s")?.kind).toBe("input")
    expect(changes).toBe(2)
    expect(submissions.pending("s")).toHaveLength(0)
  })

  it("confirms identities from blocks a delta wrote or a read delivered, not from a text append", async () => {
    const submissions = submissionsOf({ dispatch: async () => ({ ok: true }) })
    await submissions.send("s", { text: "hello" })
    const id = submissions.pending("s")[0]!.id
    const message = { kind: "userMessage" as const, id: "server", content: "hello", timestamp: 0, pending: false, injected: false, submissionIds: [id] }
    submissions.observe("s", adoptedBlocks({ kind: "deltas", structural: false, streamingChanged: false, replaced: [{ localIndex: 0, prior: undefined, next: message, appendedText: "o" }] }), WHOLE)
    submissions.observe("s", adoptedBlocks({ kind: "status" }), WHOLE)
    expect(submissions.pending("s")).toHaveLength(1)
    submissions.observe("s", [{ ...message, pending: true }], WHOLE)
    expect(submissions.pending("s")).toHaveLength(0)
    expect(submissions.ownsSubmission(id)).toBe(true)
    submissions.observe("s", adoptedBlocks({ kind: "window", reason: "merge", adopted: [message] }), WHOLE)
    expect(submissions.pending("s")).toHaveLength(0)
    expect(submissions.ownsSubmission(id)).toBe(false)
  })

  it("withdraws only the runtime-recalled identities before canonical output adoption", async () => {
    const submissions = submissionsOf({ dispatch: async () => ({ ok: true }) })
    await submissions.send("s", { text: "same" })
    await submissions.send("s", { text: "same" })
    await submissions.send("s", { text: "same" })
    await submissions.send("other", { text: "same" })
    const ids = submissions.pending("s").slice(0, 2).map((entry) => entry.id)
    const retainedId = submissions.pending("s")[2]!.id
    submissions.observe("s", ids.map((id) => ({ kind: "userMessage", id: `queued:${id}`, content: "same", timestamp: 0, pending: true, injected: false, submissionIds: [id] })), WHOLE)
    expect(ids.map(submissions.ownsSubmission)).toEqual([true, true])
    const request = Promise.withResolvers<ChatInputLike | null>()
    const recalling = submissions.recallQueued("s", () => request.promise)
    expect(submissions.pending("s")).toHaveLength(1)
    const recalled = { text: "same", submissionIds: ids, attachments: [{ marker: "[Image #1]", mediaType: "image/png", data: "bytes" }] }
    request.resolve(recalled)
    expect(await recalling).toEqual(recalled)
    expect(submissions.pending("s").map((entry) => entry.id)).toEqual([retainedId])
    expect(ids.map(submissions.ownsSubmission)).toEqual([false, false])
    expect(submissions.ownsSubmission(retainedId)).toBe(true)
    expect(submissions.pending("other")).toHaveLength(1)
  })

  it("confirms a moved submission from its roster delivery receipt without retiring another message", async () => {
    const response = Promise.withResolvers<{ ok: true; confirmedSubmissionIds: readonly string[] }>()
    const submissions = submissionsOf({ dispatch: () => response.promise })
    const first = submissions.send("s", { text: "same" })
    const id = submissions.pending("s")[0]!.id
    submissions.move("s", "destination")
    const second = submissions.send("s", { text: "same" })
    response.resolve({ ok: true, confirmedSubmissionIds: [id] })
    await Promise.all([first, second])
    expect(submissions.pending("destination")).toHaveLength(0)
    expect(submissions.ownsSubmission(id)).toBe(false)
    expect(submissions.pending("s")).toHaveLength(1)
  })

  it("retains local rows when runtime recall has no correlated input or fails", async () => {
    const submissions = submissionsOf({ dispatch: async () => ({ ok: true }) })
    await submissions.send("s", { text: "same" })
    for (const result of [null, "same", { text: "same" }]) {
      expect(await submissions.recallQueued("s", async () => result)).toEqual(result)
      expect(submissions.pending("s")).toHaveLength(1)
    }
    await expect(submissions.recallQueued("s", async () => { throw new Error("Disconnected") })).rejects.toThrow("Disconnected")
    expect(submissions.pending("s")).toHaveLength(1)
  })

  it("does not restore a withdrawn row when the send response fails later", async () => {
    const sendingResponse = Promise.withResolvers<{ ok: false; error: string }>()
    const submissions = submissionsOf({ dispatch: async () => sendingResponse.promise })
    const sending = submissions.send("s", { text: "recalled" })
    const input = submissions.pending("s")[0]!.input
    await submissions.recallQueued("s", async () => input)
    sendingResponse.resolve({ ok: false, error: "Response lost" })
    await sending
    expect(submissions.pending("s")).toHaveLength(0)
    expect(submissions.ownsSubmission(input.submissionIds![0]!)).toBe(false)
  })

  it("keeps invocation-only dividers out of user-message feedback", async () => {
    let dispatched = false
    const submissions = submissionsOf({ dispatch: async () => { dispatched = true; return { ok: true } } })
    await submissions.send("s", { text: "expanded private step instructions", invocation: { label: "Review" } })
    expect(dispatched).toBe(true)
    expect(submissions.pending("s")).toHaveLength(0)
  })
  it("publishes before dispatch and retains queued feedback until canonical output arrives", async () => {
    let settle!: (result: { ok: true }) => void
    const submissions = submissionsOf({
      dispatch: async (_sessionId, input) => {
        expect(submissions.pending("s")[0]?.input).toEqual(input)
        return new Promise((resolve) => { settle = resolve })
      },
    })
    const sending = submissions.send("s", { text: "hello" })
    const id = submissions.pending("s")[0]!.id
    expect(submissions.pending("s")[0]?.input.submissionIds).toEqual([id])
    expect(await submissions.recallQueued("s", async () => ({ text: "hello", submissionIds: [id] }))).toEqual({ text: "hello", submissionIds: [id] })
    expect(submissions.pending("s")).toHaveLength(0)
    settle({ ok: true })
    await sending
    submissions.observe("s", [{ kind: "userMessage", id: "server", content: "hello", timestamp: 0, pending: false, injected: false, submissionIds: [id] }], WHOLE)
    expect(submissions.pending("s")).toHaveLength(0)
  })

  it("uses identities across sessions and merged messages, never equal text", async () => {
    const submissions = submissionsOf({ dispatch: async () => ({ ok: true }), position: () => 0 })
    await submissions.send("s", { text: "same" })
    await submissions.send("s", { text: "same" })
    const ids = submissions.pending("s").map((entry) => entry.id)
    await submissions.send("s", { text: "same" })
    const unrelated = submissions.pending("s")[2]!.id
    await submissions.send("third", { text: "same" })
    const canonical = { kind: "userMessage" as const, id: "server", content: "same", timestamp: 0, pending: false, injected: false }
    submissions.observe("s", [canonical], WHOLE)
    submissions.observe("other", [], { startBlockIndex: 100 })
    expect(submissions.pending("s")).toHaveLength(3)
    submissions.observe("other", [{ ...canonical, submissionIds: ids }], WHOLE)
    expect(submissions.pending("s").map((entry) => entry.id)).toEqual([unrelated])
    expect(submissions.pending("third")).toHaveLength(1)
  })

  it("retains a send whose answer an unknown transport fault lost, with its images, for explicit recall with a new identity", async () => {
    // Only a lane's end makes a message wait for the next lane. Any other
    // lost answer may have reached the runtime, so the entry says that it is
    // not confirmed, in the client's own plain words and never the transport's.
    const submissions = submissionsOf({ dispatch: async () => { throw new Error("RpcClientDefect: Unknown socket error") } })
    const input = { text: "image", attachments: [{ marker: "[Image #1]", mediaType: "image/png", data: "bytes" }] }
    expect(await submissions.send("s", input)).toEqual({ kind: "failed", error: expect.stringContaining("did not confirm") })
    const delivery = submissions.pending("s")[0]!.delivery
    expect(delivery).toEqual({ kind: "unconfirmed" })
    expect(undeliveredNotice(delivery)).toBe("Not confirmed")
    expect(submissions.recallLocal("s")).toEqual({ kind: "input", input })
    expect(submissions.pending("s")).toHaveLength(0)
    expect(submissions.recallLocal("s")).toBeNull()
  })

  it("does not resurrect a confirmed row when the dispatch response fails later", async () => {
    let settle!: (result: { ok: false; error: string }) => void
    const submissions = submissionsOf({ dispatch: async () => new Promise((resolve) => { settle = resolve }) })
    const sending = submissions.send("s", { text: "accepted" })
    const id = submissions.pending("s")[0]!.id
    submissions.observe("s", [{ kind: "userMessage", id: "server", content: "accepted", timestamp: 0, pending: false, injected: false, submissionIds: [id] }], WHOLE)
    settle({ ok: false, error: "Response lost" })
    await sending
    expect(submissions.pending("s")).toHaveLength(0)
  })

  it("moves a destination's entries to the session created for it, and a later failure stays on the moved entry", async () => {
    const request = Promise.withResolvers<{ ok: false; error: string }>()
    const submissions = submissionsOf({ dispatch: () => request.promise })
    const sending = submissions.send("", { text: "first words" })
    const [entry] = submissions.pending("")
    submissions.move("", "created")
    expect(submissions.pending("")).toHaveLength(0)
    expect(submissions.pending("created")).toEqual([entry!])
    request.resolve({ ok: false, error: "Disconnected" })
    await sending
    expect(submissions.pending("created").map((moved) => moved.delivery)).toEqual([{ kind: "failed", error: "Disconnected" }])
  })

  it("says that a message the runtime refused was not delivered, in the runtime's words", async () => {
    const submissions = submissionsOf({ dispatch: async () => ({ ok: false, error: "This session is read-only" }) })
    await submissions.send("s", { text: "refused" })
    const delivery = submissions.pending("s")[0]!.delivery
    expect(undeliveredNotice(delivery)).toBe("Not delivered: This session is read-only")
    expect(undeliveredNotice({ kind: "sending" })).toBeUndefined()
  })
  it("withdraws an expected refusal whose draft stays in its composer", async () => {
    const submissions = submissionsOf({ dispatch: async () => ({ ok: false, kind: "handing_off", error: "This agent has started its handoff and cannot read another message. Your draft was kept." }) })
    const sending = submissions.send("child", { text: "late guidance" })
    const id = submissions.pending("child")[0]!.id
    expect(await sending).toEqual({ kind: "draft_kept", error: "This agent has started its handoff and cannot read another message. Your draft was kept." })
    expect(submissions.pending("child")).toEqual([])
    expect(submissions.ownsSubmission(id)).toBe(false)
    submissions.dispose()
  })

  it("takes back the failed entry the person names, and the newest failed one when none is named", async () => {
    const submissions = submissionsOf({ dispatch: async () => ({ ok: false, error: "Disconnected" }) })
    await submissions.send("s", { text: "first" })
    await submissions.send("s", { text: "second" })
    await submissions.send("s", { text: "third" })
    const [first] = submissions.pending("s")
    expect(submissions.recallLocal("s", first!.id)).toEqual({ kind: "input", input: { text: "first" } })
    expect(submissions.ownsSubmission(first!.id)).toBe(false)
    expect(submissions.pending("s").map((entry) => entry.input.text)).toEqual(["second", "third"])
    expect(submissions.recallLocal("s", "unknown")).toBeNull()
    expect(submissions.recallLocal("s")).toEqual({ kind: "input", input: { text: "third" } })
    expect(submissions.pending("s").map((entry) => entry.input.text)).toEqual(["second"])
  })

  it("retires an accepted entry once a window starts past the runtime position it was accepted at, whatever either clock says", async () => {
    const answers = new Map<string, Promise<{ ok: true } | { ok: false; error: string }>>()
    const running = Promise.withResolvers<{ ok: true }>()
    answers.set("running", running.promise)
    answers.set("refused", Promise.resolve({ ok: false, error: "Disconnected" }))
    // The session's block count this client knows, as the runtime counts blocks.
    let known: number | undefined = 3
    const submissions = submissionsOf({ dispatch: async (_sessionId, input) => answers.get(input.text) ?? { ok: true }, position: () => known })
    const accepted = submissions.send("s", { text: "accepted" })
    void submissions.send("s", { text: "running" })
    await submissions.send("s", { text: "refused" })
    await accepted
    const texts = () => submissions.pending("s").map((entry) => entry.input.text)
    expect(submissions.pending("s").map((entry) => entry.delivery)).toEqual([
      { kind: "accepted", position: 3 }, { kind: "sending" }, { kind: "failed", error: "Disconnected" },
    ])
    // A window that starts at or before that position could still hold the
    // message later, so it retires nothing. Neither clock takes part.
    for (const startBlockIndex of [null, 0, 3]) submissions.observe("s", [], { startBlockIndex })
    expect(texts()).toEqual(["accepted", "running", "refused"])
    submissions.observe("s", [], { startBlockIndex: 4 })
    // Only a dispatch the runtime accepted puts the message in its
    // transcript: a running one may not have arrived, and a refused one never will.
    expect(texts()).toEqual(["running", "refused"])
    known = 10
    running.resolve({ ok: true })
    await Promise.resolve()
    await Promise.resolve()
    submissions.observe("other", [], { startBlockIndex: 11 })
    submissions.observe("s", [], { startBlockIndex: 10 })
    expect(texts()).toEqual(["running", "refused"])
    submissions.observe("s", [], { startBlockIndex: 11 })
    expect(texts()).toEqual(["refused"])
  })

  it("records the position where the entry now is, or the one known at send when that session's count is unknown", async () => {
    const answers = [Promise.withResolvers<{ ok: true }>(), Promise.withResolvers<{ ok: true }>()]
    const known = new Map<string, number>([["s", 7]])
    const submissions = submissionsOf({ dispatch: () => answers.shift()!.promise, position: (sessionId) => known.get(sessionId) })
    const [first, second] = answers
    // The first words of a new chat move to the chat the runtime creates,
    // which is known to be empty.
    const created = submissions.send("", { text: "first words" })
    submissions.move("", "created")
    known.set("created", 0)
    first!.resolve({ ok: true })
    await created
    // A session the client stopped reading keeps the count from the send.
    const away = submissions.send("s", { text: "while away" })
    known.delete("s")
    second!.resolve({ ok: true })
    await away
    expect(submissions.pending("created").map((entry) => entry.delivery)).toEqual([{ kind: "accepted", position: 0 }])
    expect(submissions.pending("s").map((entry) => entry.delivery)).toEqual([{ kind: "accepted", position: 7 }])
  })

})

describe("messages lost with the connection", () => {
  it("keeps them queued with no failure and sends each again once, with its identity, in send order on the next lane", async () => {
    const lanes = testLanes()
    const resent: { text: string; ids: readonly string[] | undefined }[] = []
    const answers: Promise<ChatSubmissionResult>[] = []
    // Both go out on the lane that ends, so both wait for the next one.
    const lost = Promise.withResolvers<ChatSubmissionResult>()
    const submissions = createChatSubmissions({
      lanes,
      dispatch: () => lost.promise,
      resend: (_sessionId, input) => {
        resent.push({ text: input.text, ids: input.submissionIds })
        const answer = Promise.withResolvers<ChatSubmissionResult>()
        answers.push(answer.promise)
        // The first resend answers only once the test lets it, so the
        // second must wait for it.
        if (resent.length === 1) setTimeout(() => answer.resolve({ ok: true }), 5)
        else answer.resolve({ ok: true })
        return answer.promise
      },
    })
    const sends = [submissions.send("s", { text: "first" }), submissions.send("s", { text: "second" })]
    lost.reject(new RuntimeLaneLost(new Error("the lane the call ran on ended")))
    expect(await Promise.all(sends)).toEqual([{ kind: "waiting" }, { kind: "waiting" }])
    const ids = submissions.pending("s").map((entry) => entry.id)
    expect(submissions.pending("s").map((entry) => entry.delivery)).toEqual([{ kind: "waiting" }, { kind: "waiting" }])
    expect(submissions.pending("s").map((entry) => undeliveredNotice(entry.delivery))).toEqual([undefined, undefined])
    lanes.open()
    await drainMicrotasks()
    expect(resent).toEqual([{ text: "first", ids: [ids[0]!] }])
    await answers[0]
    await drainMicrotasks()
    expect(resent).toEqual([{ text: "first", ids: [ids[0]!] }, { text: "second", ids: [ids[1]!] }])
    lanes.open()
    await drainMicrotasks()
    expect(resent).toHaveLength(2)
    expect(submissions.pending("s").map((entry) => entry.delivery.kind)).toEqual(["accepted", "accepted"])
  })

  it("retires a waiting message at once when a workflow answers that it holds it already", async () => {
    const lanes = testLanes()
    const submissions = createChatSubmissions({ lanes, dispatch: lostWithItsLane, resend: async (_sessionId, input) => ({ ok: true, confirmedSubmissionIds: input.submissionIds! }) })
    await submissions.send("s", { text: "recorded before the lane ended" })
    lanes.open()
    await drainMicrotasks()
    expect(submissions.pending("s")).toHaveLength(0)
  })

  it("keeps a message that a session with a transcript holds already queued until its transcript shows it", async () => {
    const lanes = testLanes()
    const submissions = createChatSubmissions({ lanes, dispatch: lostWithItsLane, position: () => 4, resend: async (_sessionId, input) => ({ ok: true, confirmedSubmissionIds: input.submissionIds!, inTranscript: true }) })
    await submissions.send("s", { text: "held for a child at rest" })
    const [entry] = submissions.pending("s")
    lanes.open()
    await drainMicrotasks()
    expect(submissions.pending("s").map((pending) => pending.delivery)).toEqual([{ kind: "accepted", position: 4 }])
    submissions.observe("s", [{ kind: "userMessage", id: "b", content: "held for a child at rest", timestamp: 0, pending: false, injected: false, submissionIds: [entry!.id] }], WHOLE)
    expect(submissions.pending("s")).toHaveLength(0)
  })

  it.each([undefined, "handing_off"] as const)("keeps a replay refused with %s available when its composer already cleared", async (kind) => {
    const lanes = testLanes()
    const answers: (() => Promise<ChatSubmissionResult>)[] = [lostWithItsLane, async () => ({ ok: false, error: "Session s is no longer available", ...(kind === undefined ? {} : { kind }) })]
    const submissions = createChatSubmissions({ lanes, dispatch: lostWithItsLane, resend: () => answers.shift()!() })
    await submissions.send("s", { text: "words" })
    lanes.open()
    await drainMicrotasks()
    expect(submissions.pending("s")[0]?.delivery).toEqual({ kind: "waiting" })
    lanes.open()
    await drainMicrotasks()
    expect(submissions.pending("s")[0]?.delivery).toEqual({ kind: "failed", error: "Session s is no longer available" })
    expect(submissions.pending("s")).toHaveLength(1)
    expect(submissions.recallLocal("s")).toEqual({ kind: "input", input: { text: "words" } })
    expect(submissions.pending("s")).toEqual([])
  })

  it("sends a new message only after the waiting ones, through the client's own admission", async () => {
    const lanes = testLanes()
    const order: string[] = []
    let lost = true
    const submissions = createChatSubmissions({
      lanes,
      dispatch: async (_sessionId, input) => { if (lost) return lostWithItsLane(); order.push(`dispatch ${input.text}`); return { ok: true } },
      resend: async (_sessionId, input) => { order.push(`resend ${input.text}`); return { ok: true } },
    })
    await submissions.send("s", { text: "lost" })
    lost = false
    // Sent while an earlier message waits: it waits behind it, with no
    // failure, and leaves no call for a lane that is not open.
    expect(await submissions.send("s", { text: "later" })).toEqual({ kind: "waiting" })
    expect(await submissions.send("other", { text: "elsewhere" })).toEqual({ kind: "sent" })
    await drainMicrotasks()
    lanes.open()
    await drainMicrotasks()
    expect(order).toEqual(["dispatch elsewhere", "resend lost", "dispatch later"])
  })

  it("sends at once a message whose lane ended after the next lane already opened", async () => {
    const lanes = testLanes()
    const lost = Promise.withResolvers<ChatSubmissionResult>()
    let resends = 0
    const submissions = createChatSubmissions({ lanes, dispatch: () => lost.promise, resend: async () => { resends += 1; return { ok: true } } })
    const sending = submissions.send("s", { text: "words" })
    lanes.open()
    lost.reject(new RuntimeLaneLost(new Error("the lane the call ran on ended")))
    expect(await sending).toEqual({ kind: "waiting" })
    await drainMicrotasks()
    expect(resends).toBe(1)
  })

  it("answers Up or Edit on a waiting message with why it waits, and keeps the message", async () => {
    const submissions = submissionsOf({ dispatch: lostWithItsLane })
    await submissions.send("s", { text: "waiting words" })
    const [entry] = submissions.pending("s")
    expect(submissions.recallLocal("s")).toEqual({ kind: "waiting", notice: WAITING_RECALL })
    expect(submissions.recallLocal("s", entry!.id)).toEqual({ kind: "waiting", notice: WAITING_RECALL })
    expect(submissions.pending("s")).toEqual([entry!])
    expect(WAITING_RECALL).toMatch(/sends it when the connection/)
  })

  it("answers Up or Edit on a message still being sent the same way: it may already be recorded, so it stays", async () => {
    // A silent connection takes many seconds to end, and until then the
    // send is in flight, not yet known lost. Up must not fall through to
    // the runtime's queued recall or to history.
    const answer = Promise.withResolvers<ChatSubmissionResult>()
    const submissions = submissionsOf({ dispatch: () => answer.promise })
    const sending = submissions.send("s", { text: "in flight" })
    const [entry] = submissions.pending("s")
    expect(entry?.delivery).toEqual({ kind: "sending" })
    expect(submissions.recallLocal("s")).toEqual({ kind: "waiting", notice: WAITING_RECALL })
    expect(submissions.recallLocal("s", entry!.id)).toEqual({ kind: "waiting", notice: WAITING_RECALL })
    expect(submissions.pending("s")).toEqual([entry!])
    answer.resolve({ ok: true })
    await sending
    // Once the runtime took it, the runtime's queued recall decides.
    expect(submissions.recallLocal("s")).toBeNull()
  })

  it("takes a refused message back for editing before it answers for a waiting one", async () => {
    const answers: (() => Promise<ChatSubmissionResult>)[] = [async () => ({ ok: false, error: "This session is read-only" }), lostWithItsLane]
    const submissions = submissionsOf({ dispatch: () => answers.shift()!() })
    await submissions.send("s", { text: "refused" })
    await submissions.send("s", { text: "waits" })
    expect(submissions.recallLocal("s")).toEqual({ kind: "input", input: { text: "refused" } })
    expect(submissions.recallLocal("s")).toEqual({ kind: "waiting", notice: WAITING_RECALL })
  })

  it("hands the messages on their way to a successor, which shows them queued and sends them on its first lane", async () => {
    const pending = Promise.withResolvers<ChatSubmissionResult>()
    const predecessor = submissionsOf({ dispatch: async (_sessionId, input) => input.text === "on its way" ? pending.promise : lostWithItsLane() })
    void predecessor.send("s", { text: "on its way" })
    await predecessor.send("s", { text: "waiting" })
    await predecessor.send("t", { text: "also waiting" })
    const handed = predecessor.unsent()
    expect(handed.map((entry) => [entry.sessionId, entry.input.text])).toEqual([["s", "on its way"], ["s", "waiting"], ["t", "also waiting"]])
    const lanes = testLanes()
    const resent: { sessionId: string; ids: readonly string[] | undefined }[] = []
    const successor = createChatSubmissions({ lanes, unsent: handed, dispatch: lostWithItsLane, resend: async (sessionId, input) => { resent.push({ sessionId, ids: input.submissionIds }); return { ok: true } } })
    expect(successor.pending("s").map((entry) => [entry.id, entry.delivery.kind])).toEqual(handed.slice(0, 2).map((entry) => [entry.id, "waiting"]))
    lanes.open()
    await drainMicrotasks()
    // Each session's messages go out in the order they were sent.
    for (const sessionId of ["s", "t"]) {
      expect(resent.filter((sent) => sent.sessionId === sessionId)).toEqual(handed.filter((entry) => entry.sessionId === sessionId).map((entry) => ({ sessionId, ids: [entry.id] })))
    }
  })

  it("says that a bare command lost with its lane may not have arrived, since no entry sends it again", async () => {
    const submissions = submissionsOf({ dispatch: lostWithItsLane })
    expect(await submissions.send("s", { text: "expanded body", invocation: { label: "Review" } })).toEqual({ kind: "failed", error: UNCONFIRMED_COMMAND })
    expect(submissions.pending("s")).toHaveLength(0)
  })
})
