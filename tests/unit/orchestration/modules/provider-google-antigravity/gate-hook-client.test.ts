import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"

import { runGateHook } from "../../../../../src/infra/antigravity-gate-hook.js"
import { listenInternalProcessChannel, type InternalProcessChannelServer } from "../../../../../src/infra/internal-process-channel.js"
import { socketTemporaryRoot } from "../../../../helpers/directories.js"

const ALLOW = "{}\n"
const TERMINATE = `{"injectSteps":[],"terminationBehavior":"terminate"}\n`
const GATE_ID = "gate-login-1"
const PAYLOAD = JSON.stringify({
  invocationNum: 2,
  initialNumSteps: 5,
  conversationId: "6a1f0c2e-session",
  workspacePaths: ["/workspace"],
  modelName: "gemini-3.1-pro",
  lastUserInput: "hello",
})

const socketDirectories: string[] = []
afterEach(() => {
  for (const dir of socketDirectories.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function gateAddress(): string {
  if (process.platform === "win32") return String.raw`\\.\pipe\fw-agy-test-${crypto.randomUUID()}`
  const dir = mkdtempSync(join(socketTemporaryRoot(), "fw-agy-"))
  socketDirectories.push(dir)
  return join(dir, "gate.sock")
}

/** A step gate that records each query and sends `answer` back, or never
 *  answers when `answer` is undefined. */
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- the fake gate sends any value, including answers the client must refuse
async function listenGate(answer: unknown): Promise<{ readonly server: InternalProcessChannelServer; readonly address: string; readonly queries: unknown[]; readonly connections: () => number }> {
  const address = gateAddress()
  const queries: unknown[] = []
  let connections = 0
  const server = listenInternalProcessChannel<unknown, unknown>({
    path: address,
    decode: (value) => value,
    onConnection(endpoint) {
      connections += 1
      endpoint.onMessage(async (query) => {
        queries.push(query)
        if (answer !== undefined) await endpoint.send(answer)
      })
    },
  })
  await server.ready
  return { server, address, queries, connections: () => connections }
}

async function hook(options: { readonly stdin: string | ReadableStream<Uint8Array>; readonly address: string | undefined; readonly deadlineMs?: number }): Promise<string> {
  const written: string[] = []
  await runGateHook({
    stdin: typeof options.stdin === "string" ? new Response(options.stdin).body! : options.stdin,
    write: async (text) => { written.push(text) },
    address: options.address,
    loginGateId: GATE_ID,
    deadlineMs: options.deadlineMs ?? 2_000,
  })
  return written.join("")
}

describe("gate hook client", () => {
  test("prints the documented allow output when the gate allows the step", async () => {
    const gate = await listenGate({ decision: "allow" })
    try {
      expect(await hook({ stdin: PAYLOAD, address: gate.address })).toBe(ALLOW)
      expect(gate.queries).toEqual([{ gateId: GATE_ID, conversationId: "6a1f0c2e-session", invocationNum: 2 }])
    } finally {
      await gate.server.dispose()
    }
  })

  test("prints terminate when the gate refuses the step", async () => {
    const gate = await listenGate({ decision: "terminate" })
    try {
      expect(await hook({ stdin: PAYLOAD, address: gate.address })).toBe(TERMINATE)
    } finally {
      await gate.server.dispose()
    }
  })

  test("prints terminate when no gate listens at the address", async () => {
    expect(await hook({ stdin: PAYLOAD, address: gateAddress() })).toBe(TERMINATE)
  })

  test("prints terminate when the command names no gate address", async () => {
    expect(await hook({ stdin: PAYLOAD, address: undefined })).toBe(TERMINATE)
  })

  test("prints terminate at its deadline when the gate does not answer", async () => {
    const gate = await listenGate(undefined)
    try {
      const started = performance.now()
      expect(await hook({ stdin: PAYLOAD, address: gate.address, deadlineMs: 25 })).toBe(TERMINATE)
      expect(performance.now() - started).toBeLessThan(1_000)
      expect(gate.queries).toHaveLength(1)
    } finally {
      await gate.server.dispose()
    }
  })

  test("prints terminate at its deadline when the payload never ends", async () => {
    const gate = await listenGate({ decision: "allow" })
    const stdin = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode("{")) } })
    try {
      expect(await hook({ stdin, address: gate.address, deadlineMs: 25 })).toBe(TERMINATE)
      expect(gate.connections()).toBe(0)
    } finally {
      await gate.server.dispose()
    }
  })

  test("opens no gate connection after its deadline when the payload is complete but stdin stays open", async () => {
    const gate = await listenGate({ decision: "allow" })
    const stdin = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode(PAYLOAD)) } })
    try {
      expect(await hook({ stdin, address: gate.address, deadlineMs: 25 })).toBe(TERMINATE)
      // Cancelling the reader at the deadline hands the buffered payload to
      // the pending read; a connection would open within a few milliseconds.
      await Bun.sleep(25)
      expect(gate.connections()).toBe(0)
    } finally {
      await gate.server.dispose()
    }
  })

  test("prints terminate when the gate answers with no decision", async () => {
    const gate = await listenGate({ decision: "maybe" })
    try {
      expect(await hook({ stdin: PAYLOAD, address: gate.address })).toBe(TERMINATE)
    } finally {
      await gate.server.dispose()
    }
  })

  test.each([
    ["text that is not JSON", "not json"],
    ["a payload without a conversation id", JSON.stringify({ invocationNum: 0 })],
    ["a payload with a fractional invocation number", JSON.stringify({ conversationId: "s", invocationNum: 1.5 })],
    ["an empty payload", ""],
  ])("prints terminate for %s and opens no gate connection", async (_name, stdin) => {
    const gate = await listenGate({ decision: "allow" })
    try {
      expect(await hook({ stdin, address: gate.address })).toBe(TERMINATE)
      expect(gate.connections()).toBe(0)
    } finally {
      await gate.server.dispose()
    }
  })
})
