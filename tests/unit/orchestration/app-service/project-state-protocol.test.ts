import { describe, expect, test } from "bun:test"
import { pack } from "msgpackr"
import { decodeProjectStateRequest, decodeProjectStateResponse, decodeProjectStateStartupStep, decodeProjectStateStored, encodeProjectStateResponse, encodeProjectStateStartupStep } from "../../../../src/orchestration/app-service/project-state-protocol.js"

/** A response frame built by hand, for bodies that typed code cannot encode. */
function responseFrame(id: number, body: unknown): Uint8Array {
  return new Uint8Array(Buffer.concat([pack(id), pack(body)]))
}

describe("project state protocol", () => {
  test("carries a startup step id across structured clone and refuses a step the catalog does not hold", () => {
    const reached = { step: "stored-facts", pass: { label: "memory facts", step: 1, total: 2 } } as const
    for (const step of [reached, { step: "sessions" } as const]) expect(decodeProjectStateStartupStep(structuredClone(encodeProjectStateStartupStep(step)))).toEqual(step)
    const refused = [{ flywheel: "state.startup.step", step: "Recovering interrupted sessions" }, { flywheel: "state.startup.step", step: "toString" }, { flywheel: "serve.startup.phase", label: "Upgrading stored facts" }, { flywheel: "state.stored", events: [{ payload: { value: 1n } }] }]
    for (const message of refused) expect(decodeProjectStateStartupStep(message)).toBeUndefined()
  })
  test("validates complete requests, lane membership, and complete responses", () => {
    for (const operation of [
      { kind: "append", item: { sessionId: "s", events: [{ payload: {} }] } },
      { kind: "facts.page", query: {}, upperPosition: 1, maxRows: 0, maxBytes: 32 },
      { kind: "content.page", references: [{ sessionId: "s" }], maxRows: 1, maxBytes: 32 },
      { kind: "position.capture", unexpected: true },
      { kind: "generation.admit", projectId: "p", generation: 1 },
      { kind: "facts.slice", query: {}, maxRows: 256, maxBytes: 1024 },
    ]) {
      expect(decodeProjectStateRequest(pack({ id: 1, lane: "control", operation }), "control")).toBeUndefined()
    }
    for (const result of [
      { kind: "unknown" }, { kind: "position", position: "2" },
      { kind: "stored", settlements: [{ kind: "stored", receipts: ["fact"] }] },
      { kind: "stored", settlements: [{ kind: "stored", receipts: [{ id: "e", position: "2", seq: 0 }] }] },
      { kind: "failed", error: { kind: "seq-conflict", aggregateId: "s" } },
    ]) expect(decodeProjectStateResponse(responseFrame(1, { result }))).toBeUndefined()
    expect(decodeProjectStateResponse({ id: 1, result: { kind: "count", count: 2 } })).toBeUndefined()
    expect(decodeProjectStateRequest(pack({ id: 1, lane: "control", operation: { kind: "position.capture" } }), "control")).toBeDefined()
  })

  test("carries fact bodies to their reader without reading them", () => {
    let reads = 0
    const payload = new Proxy({ value: 1 }, {
      get(target, key) { reads++; return key === "value" ? target.value : undefined },
      ownKeys(target) { reads++; return Reflect.ownKeys(target) },
      getOwnPropertyDescriptor(target, key) { reads++; return Reflect.getOwnPropertyDescriptor(target, key) },
    })
    const fact = { aggregateId: "a", type: "one", version: 1, timestamp: 1, actor: "test", sessionId: "s", payload, position: 2, id: "e", seq: 0 }
    expect(decodeProjectStateStored({ flywheel: "state.stored", events: [fact] })).toBeDefined()
    expect(reads).toBe(0)

    // A response carries a body no family schema accepts, which only its reader judges.
    const opaque = { ...fact, payload: { anything: [1, { nested: "body" }] } }
    for (const result of [
      { kind: "facts", facts: [opaque], contentRows: [], upperPosition: 2, continuationPosition: null, encodedBytes: 1 },
      { kind: "fact-list", facts: [opaque] },
      { kind: "stored", settlements: [{ kind: "stored", receipts: [opaque] }] },
    ] as const) expect(decodeProjectStateResponse(encodeProjectStateResponse({ id: 1, result }))).toEqual({ id: 1, result })
  })

  test("round trips every exact read response codec", () => {
    const responses = [
      { kind: "latest-payload", payload: null },
      { kind: "fact-list", facts: [] },
      { kind: "in-flight", records: [{ kind: "tool", key: "k", payload: {}, raw: "{}" }] },
      { kind: "session-ids", sessionIds: ["s"] },
      { kind: "in-flight.profile", keys: ["attempt"] },
      { kind: "count", count: 0 },
      { kind: "sequence", sequence: -1 },
      { kind: "fact-slice", facts: [], contentRows: [], encodedBytes: 0 },
      { kind: "session-result", result: { kind: "session.read-batch.result", outcomes: [
        { kind: "read", result: { kind: "session.read.result", value: null } },
        { kind: "failed", error: { kind: "error", message: "unreadable" } },
      ] } },
    ] as const
    for (const result of responses) {
      expect(decodeProjectStateResponse(structuredClone(encodeProjectStateResponse({ id: 1, result })))).toEqual({ id: 1, result })
    }
  })

  test("carries an optional head beside any result", () => {
    const result = { kind: "count", count: 2 } as const
    expect(decodeProjectStateResponse(structuredClone(encodeProjectStateResponse({ id: 1, head: 7, result })))).toStrictEqual({ id: 1, head: 7, result })
    expect(decodeProjectStateResponse(structuredClone(encodeProjectStateResponse({ id: 1, result })))).toStrictEqual({ id: 1, result })
    for (const head of [-1, 1.5, "7"]) expect(decodeProjectStateResponse(responseFrame(1, { head, result }))).toBeUndefined()
  })

})
