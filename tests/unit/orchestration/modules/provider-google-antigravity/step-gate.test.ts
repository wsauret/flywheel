import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { runGateHook } from "../../../../../src/infra/antigravity-gate-hook.js"
import { RouteUnavailableError } from "../../../../../src/orchestration/agent-runtime/llm/errors.js"
import { openStepGate, type StepGate, type StepGateEvent } from "../../../../../src/orchestration/modules/provider-google-antigravity/step-gate.js"
import { socketTemporaryRoot } from "../../../../helpers/directories.js"

const ALLOW = "{}\n"
const TERMINATE = `{"injectSteps":[],"terminationBehavior":"terminate"}\n`
const GATE_ID = "gate-login-1"

const socketDirectories: string[] = []
const gates: StepGate[] = []
afterEach(async () => {
  for (const gate of gates.splice(0)) await gate.dispose()
  for (const dir of socketDirectories.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function gateAddress(): string {
  if (process.platform === "win32") return String.raw`\\.\pipe\fw-agy-test-${crypto.randomUUID()}`
  const dir = mkdtempSync(join(socketTemporaryRoot(), "fw-agy-"))
  socketDirectories.push(dir)
  return join(dir, "gate.sock")
}

async function open(address = gateAddress()): Promise<{ readonly gate: StepGate; readonly address: string; readonly events: StepGateEvent[] }> {
  const gate = await openStepGate({ address, gateId: GATE_ID })
  gates.push(gate)
  const events: StepGateEvent[] = []
  gate.onEvent((event) => events.push(event))
  return { gate, address, events }
}

/** Runs the real hook client for one PreInvocation of `conversationId`, as the
 *  engine's hook command of any process of the login does. */
async function step(address: string, conversationId: string, invocationNum = 0, gateId = GATE_ID): Promise<string> {
  const written: string[] = []
  await runGateHook({
    stdin: new Response(JSON.stringify({ conversationId, invocationNum, initialNumSteps: 1, workspacePaths: [] })).body!,
    write: async (text) => { written.push(text) },
    address,
    loginGateId: gateId,
    deadlineMs: 2_000,
  })
  return written.join("")
}

describe("antigravity step gate", () => {
  test("one grant admits exactly one step of its session", async () => {
    const { gate, address, events } = await open()
    gate.grant("S")
    expect(await step(address, "S", 1)).toBe(ALLOW)
    expect(await step(address, "S", 2)).toBe(TERMINATE)
    expect(events).toEqual([
      { sessionId: "S", invocationNum: 1, kind: "consumed" },
      { sessionId: "S", invocationNum: 2, kind: "refused" },
    ])
  })

  test("a second grant before a step replaces the first, so the session still holds one step", async () => {
    const { gate, address } = await open()
    const first = gate.grant("S")
    gate.grant("S")
    gate.revoke(first)
    expect(await step(address, "S")).toBe(ALLOW)
    expect(await step(address, "S")).toBe(TERMINATE)
  })

  test("a step of a session that holds no admission is refused while another session holds one", async () => {
    const { gate, address, events } = await open()
    gate.grant("S")
    expect(await step(address, "T")).toBe(TERMINATE)
    expect(events).toEqual([{ sessionId: "T", invocationNum: 0, kind: "refused" }])
    expect(await step(address, "S")).toBe(ALLOW)
  })

  test("the primer of a session is refused as the canary, and a grant after the refusal admits the real step", async () => {
    const { gate, address, events } = await open()
    gate.expectCanary("S")
    gate.grant("S")
    expect(await step(address, "S", 0)).toBe(TERMINATE)
    gate.grant("S")
    expect(await step(address, "S", 1)).toBe(ALLOW)
    expect(events.map((event) => event.kind)).toEqual(["canary-refused", "consumed"])
  })

  test("a revoked admission lets no step through, and revoking again raises nothing", async () => {
    const { gate, address, events } = await open()
    const admission = gate.grant("S")
    gate.revoke(admission)
    gate.revoke(admission)
    expect(await step(address, "S")).toBe(TERMINATE)
    expect(events.map((event) => event.kind)).toEqual(["refused"])
  })

  test("a revoked canary is no longer expected, so the next step is refused as uncovered", async () => {
    const { gate, address, events } = await open()
    gate.revoke(gate.expectCanary("S"))
    expect(await step(address, "S")).toBe(TERMINATE)
    expect(events.map((event) => event.kind)).toEqual(["refused"])
  })

  test("revoking a used admission leaves the session's next grant intact", async () => {
    const { gate, address } = await open()
    const used = gate.grant("S")
    expect(await step(address, "S")).toBe(ALLOW)
    gate.grant("S")
    gate.revoke(used)
    expect(await step(address, "S")).toBe(ALLOW)
  })

  test("a query with another login's gate id is refused", async () => {
    const { gate, address, events } = await open()
    gate.grant("S")
    expect(await step(address, "S", 0, "gate-login-2")).toBe(TERMINATE)
    expect(events.map((event) => event.kind)).toEqual(["refused"])
    expect(await step(address, "S")).toBe(ALLOW)
  })

  test("the sessions of two engine processes of one login reach the one gate and are routed by session", async () => {
    const { gate, address } = await open()
    gate.grant("process-1-session")
    gate.grant("process-2-session")
    const answers = await Promise.all([step(address, "process-1-session"), step(address, "process-2-session"), step(address, "process-1-session")])
    expect(answers[1]).toBe(ALLOW)
    expect([answers[0], answers[2]].toSorted()).toEqual([ALLOW, TERMINATE].toSorted())
    expect(await step(address, "process-1-session")).toBe(TERMINATE)
    expect(await step(address, "process-2-session")).toBe(TERMINATE)
  })

  test("after dispose the hook client prints terminate", async () => {
    const { gate, address } = await open()
    gate.grant("S")
    await gate.dispose()
    expect(await step(address, "S")).toBe(TERMINATE)
  })

  test.skipIf(process.platform === "win32")("opens over the socket file that a killed owner left", async () => {
    const address = gateAddress()
    writeFileSync(address, "")
    const { gate } = await open(address)
    gate.grant("S")
    expect(await step(address, "S")).toBe(ALLOW)
  })

  test("refuses an address that another live gate serves", async () => {
    const { gate, address } = await open()
    await expect(openStepGate({ address, gateId: GATE_ID })).rejects.toBeInstanceOf(RouteUnavailableError)
    gate.grant("S")
    expect(await step(address, "S")).toBe(ALLOW)
  })
})
