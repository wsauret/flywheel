import { afterEach, describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js"
import type { OwnedProcess, OwnedProcessExit } from "../../src/infra/owned-subprocess.js"
import type { LauncherScope } from "../../src/infra/process-supervisor.js"
import { BunStdioClientTransport } from "../../src/orchestration/agent-runtime/mcp-stdio-client-transport.js"
import { createRealProcessFixture, processAlive, unguardedSpawnOwned, type RealProcessFixture } from "../helpers/real-process-fixture.js"

/** A server that ignores SIGTERM and leaves a SIGTERM-resistant descendant in
 *  its own container, so only a container SIGKILL can remove the tree. */
const RESISTANT_TREE_SOURCE = String.raw`
const child = Bun.spawn([process.execPath, "-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { stdout: "ignore", stderr: "ignore", windowsHide: true });
process.on("SIGTERM", () => {});
process.stdout.write(JSON.stringify({ jsonrpc: "2.0", method: "child", params: { pid: child.pid } }) + "\n");
setInterval(() => {}, 1000);
`

const fixtures: RealProcessFixture[] = []

function fixture(name: string): RealProcessFixture {
  const created = createRealProcessFixture(name)
  fixtures.push(created)
  return created
}

afterEach(() => {
  for (const created of fixtures.splice(0)) created.cleanup()
})

/** Real containers, with cleanup armed at launch so a failed expectation still
 *  ends every process the test started. */
function guardedSpawn(scratch: RealProcessFixture, killGraceMs = 300): LauncherScope["spawnOwned"] {
  const spawnOwned = unguardedSpawnOwned(killGraceMs)
  return async (command, options) => {
    const owned = await spawnOwned(command, options)
    scratch.guard(owned.pid)
    return owned
  }
}

describe("BunStdioClientTransport", () => {
  test("assembles records and joins readers before close", async () => {
    const scratch = fixture("mcp-transport-records")
    const source = String.raw`
const first = JSON.stringify({ jsonrpc: "2.0", method: "one", params: { text: "café" } });
const bytes = new TextEncoder().encode(first);
const split = bytes.indexOf(0xc3) + 1;
process.stdout.write(bytes.slice(0, split));
await Bun.sleep(10);
process.stdout.write(bytes.slice(split));
process.stdout.write("\r\nnot-json\n" + JSON.stringify({ jsonrpc: "2.0", method: "two" }) + "\n");
process.stderr.write("secret-");
await Bun.sleep(10);
process.stderr.write("record\n");
await Bun.sleep(10);
`
    const messages: JSONRPCMessage[] = []
    const errors: Error[] = []
    const stderr: string[] = []
    const events: string[] = []
    const transport = new BunStdioClientTransport({
      command: process.execPath,
      args: ["-e", source],
      cwd: process.cwd(),
      env: definedEnvironment(process.env),
      onStderrRecord: (record) => stderr.push(record),
      spawnOwned: guardedSpawn(scratch),
    })
    // oxlint-disable-next-line unicorn/prefer-add-event-listener -- boundary: MCP Transport exposes assignable callbacks, not EventTarget.
    transport.onmessage = (message) => {
      messages.push(message)
      events.push("message")
    }
    // oxlint-disable-next-line unicorn/prefer-add-event-listener -- boundary: MCP Transport exposes assignable callbacks, not EventTarget.
    transport.onerror = (error) => errors.push(error)
    // oxlint-disable-next-line unicorn/prefer-add-event-listener -- boundary: MCP Transport exposes assignable callbacks, not EventTarget.
    transport.onclose = () => events.push("close")

    await transport.start()
    await waitFor(() => events.at(-1) === "close")

    expect(JSON.stringify(messages)).toContain("café")
    expect(errors.some((error) => error.message.includes("JSON"))).toBe(true)
    expect(stderr).toEqual(["secret-record"])
    expect(events.at(-1)).toBe("close")
  }, 20_000)

  test("drains accepted sends before ending stdin", async () => {
    const scratch = fixture("mcp-transport-drain")
    const output = scratch.file("stdin-records")
    const transport = await startedStdinRecorder(scratch, output)

    const first = transport.send({ jsonrpc: "2.0", method: "one" })
    const second = transport.send({ jsonrpc: "2.0", method: "two" })
    await Promise.all([first, second, transport.close()])

    expect(recordedMethods(output)).toEqual(["one", "two"])
  }, 20_000)

  test("terminates an oversized unterminated frame", async () => {
    const scratch = fixture("mcp-transport-overflow")
    const errors: Error[] = []
    let closed = false
    const transport = new BunStdioClientTransport({
      command: process.execPath,
      args: ["-e", 'process.stdout.write("x".repeat(1_048_577)); setInterval(() => {}, 1000)'],
      cwd: process.cwd(),
      env: definedEnvironment(process.env),
      spawnOwned: guardedSpawn(scratch),
    })
    // oxlint-disable-next-line unicorn/prefer-add-event-listener -- boundary: MCP Transport exposes assignable callbacks, not EventTarget.
    transport.onerror = (error) => errors.push(error)
    // oxlint-disable-next-line unicorn/prefer-add-event-listener -- boundary: MCP Transport exposes assignable callbacks, not EventTarget.
    transport.onclose = () => { closed = true }

    await transport.start()
    await waitFor(() => closed)

    expect(errors.some((error) => error.message.includes("exceeded"))).toBe(true)
  }, 20_000)

  test("rejects a pre-aborted start before it launches a container", async () => {
    const launches: string[] = []
    const controller = new AbortController()
    controller.abort(new Error("attempt retired"))
    const transport = new BunStdioClientTransport({
      command: process.execPath,
      args: ["-e", "setInterval(() => {}, 1000)"],
      cwd: process.cwd(),
      env: definedEnvironment(process.env),
      signal: controller.signal,
      spawnOwned: (command) => {
        launches.push(command.join(" "))
        throw new Error("a pre-aborted start must not launch anything")
      },
    })

    await expect(transport.start()).rejects.toThrow("attempt retired")

    expect(launches).toEqual([])
    expect(transport.pid).toBeNull()
  })

  test("ends the container when the attempt aborts during startup", async () => {
    const scratch = fixture("mcp-transport-abort")
    const controller = new AbortController()
    let descendantPid: number | null = null
    let closed = false
    const transport = new BunStdioClientTransport({
      command: process.execPath,
      args: ["-e", RESISTANT_TREE_SOURCE],
      cwd: process.cwd(),
      env: definedEnvironment(process.env),
      signal: controller.signal,
      spawnOwned: guardedSpawn(scratch),
    })
    // oxlint-disable-next-line unicorn/prefer-add-event-listener -- boundary: MCP Transport exposes assignable callbacks, not EventTarget.
    transport.onmessage = (message) => {
      descendantPid = childPidOf(message)
      if (descendantPid !== null) scratch.guard(descendantPid)
    }
    // oxlint-disable-next-line unicorn/prefer-add-event-listener -- boundary: MCP Transport exposes assignable callbacks, not EventTarget.
    transport.onclose = () => { closed = true }

    await transport.start()
    const serverPid = transport.pid
    await waitFor(() => descendantPid !== null)
    controller.abort(new Error("startup aborted"))
    await waitFor(() => closed)

    expect(serverPid === null || !processAlive(serverPid)).toBe(true)
    expect(descendantPid !== null && processAlive(descendantPid)).toBe(false)
  }, 20_000)

  test("kills SIGTERM-resistant descendants on close", async () => {
    const scratch = fixture("mcp-transport-resistant")
    let descendantPid: number | null = null
    const transport = new BunStdioClientTransport({
      command: process.execPath,
      args: ["-e", RESISTANT_TREE_SOURCE],
      cwd: process.cwd(),
      env: definedEnvironment(process.env),
      spawnOwned: guardedSpawn(scratch),
    })
    // oxlint-disable-next-line unicorn/prefer-add-event-listener -- boundary: MCP Transport exposes assignable callbacks, not EventTarget.
    transport.onmessage = (message) => {
      descendantPid = childPidOf(message)
      if (descendantPid !== null) scratch.guard(descendantPid)
    }

    await transport.start()
    const serverPid = transport.pid
    await waitFor(() => descendantPid !== null)
    await transport.close()

    expect(descendantPid !== null && processAlive(descendantPid)).toBe(false)
    expect(serverPid === null || !processAlive(serverPid)).toBe(true)
  }, 20_000)

  test("rejects sends after close and still settles accepted sends", async () => {
    const scratch = fixture("mcp-transport-accepted")
    const output = scratch.file("accepted-records")
    const transport = await startedStdinRecorder(scratch, output)

    const accepted = [transport.send({ jsonrpc: "2.0", method: "one" }), transport.send({ jsonrpc: "2.0", method: "two" })]
    const closing = transport.close()
    const refused = transport.send({ jsonrpc: "2.0", method: "three" })

    await expect(refused).rejects.toThrow("closing")
    await Promise.all([...accepted, closing])
    expect(recordedMethods(output)).toEqual(["one", "two"])
  }, 20_000)

  test("delivers no message after it settles", async () => {
    const scratch = fixture("mcp-transport-settled")
    const events: string[] = []
    const transport = new BunStdioClientTransport({
      command: process.execPath,
      args: ["-e", 'let tick = 0; setInterval(() => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", method: "tick", params: { tick: tick++ } }) + "\\n"), 5);'],
      cwd: process.cwd(),
      env: definedEnvironment(process.env),
      spawnOwned: guardedSpawn(scratch),
    })
    // oxlint-disable-next-line unicorn/prefer-add-event-listener -- boundary: MCP Transport exposes assignable callbacks, not EventTarget.
    transport.onmessage = () => events.push("message")
    // oxlint-disable-next-line unicorn/prefer-add-event-listener -- boundary: MCP Transport exposes assignable callbacks, not EventTarget.
    transport.onclose = () => events.push("close")

    await transport.start()
    await waitFor(() => events.includes("message"))
    await transport.close()
    const settledLength = events.length
    await Bun.sleep(100)

    expect(events.at(-1)).toBe("close")
    expect(events).toHaveLength(settledLength)
  }, 20_000)

  test("settles once for concurrent close callers and a racing abort", async () => {
    const scratch = fixture("mcp-transport-once")
    let closes = 0
    const controller = new AbortController()
    const transport = new BunStdioClientTransport({
      command: process.execPath,
      args: ["-e", "setInterval(() => {}, 1000)"],
      cwd: process.cwd(),
      env: definedEnvironment(process.env),
      signal: controller.signal,
      spawnOwned: guardedSpawn(scratch),
    })
    // oxlint-disable-next-line unicorn/prefer-add-event-listener -- boundary: MCP Transport exposes assignable callbacks, not EventTarget.
    transport.onclose = () => { closes++ }

    await transport.start()
    const first = transport.close()
    controller.abort(new Error("also aborted"))
    await Promise.all([first, transport.close(), transport.close()])
    await Bun.sleep(50)

    expect(closes).toBe(1)
  }, 20_000)

  test("joins readers and settles once when exit observation and error reporting fail", async () => {
    const errors: Error[] = []
    const readers: ReadableStreamDefaultController<Uint8Array>[] = []
    const controller = new AbortController()
    let closes = 0
    const exited = Promise.reject(new Error("waitpid failed"))
    const blockedStream = (): ReadableStream<Uint8Array> => new ReadableStream({
      start(streamController) { readers.push(streamController) },
    })
    const owned = fakeOwnedProcess({
      stdin: fakeSink({}),
      stdout: blockedStream(),
      stderr: blockedStream(),
      exited,
      terminate: () => exited,
    })
    const transport = new BunStdioClientTransport({
      command: "unused",
      args: [],
      cwd: process.cwd(),
      env: {},
      signal: controller.signal,
      spawnOwned: () => Promise.resolve(owned),
    })
    // oxlint-disable-next-line unicorn/prefer-add-event-listener -- boundary: MCP Transport exposes assignable callbacks, not EventTarget.
    transport.onerror = (error) => {
      errors.push(error)
      throw new Error("error observer failed")
    }
    // oxlint-disable-next-line unicorn/prefer-add-event-listener -- boundary: MCP Transport exposes assignable callbacks, not EventTarget.
    transport.onclose = () => { closes++ }

    await transport.start()
    await waitFor(() => errors.some((error) => error.message === "waitpid failed"))
    expect(closes).toBe(0)

    for (const reader of readers) reader.close()
    await waitFor(() => closes === 1)
    controller.abort(new Error("late abort"))
    await Bun.sleep(10)

    expect(closes).toBe(1)
  }, 20_000)

  test("a failed accepted write decides the terminal outcome without keeping the record", async () => {
    const errors: Error[] = []
    const closedStream = (): ReadableStream<Uint8Array> => new ReadableStream({
      start(streamController) { streamController.close() },
    })
    const owned = fakeOwnedProcess({
      stdin: fakeSink({ write: () => { throw new Error("EPIPE broken pipe") } }),
      stdout: closedStream(),
      stderr: closedStream(),
      // Never settles on its own, so the close path is what ends this container.
      exited: new Promise(() => {}),
    })
    const transport = new BunStdioClientTransport({
      command: "unused",
      args: [],
      cwd: process.cwd(),
      env: {},
      spawnOwned: () => Promise.resolve(owned),
    })
    // oxlint-disable-next-line unicorn/prefer-add-event-listener -- boundary: MCP Transport exposes assignable callbacks, not EventTarget.
    transport.onerror = (error) => errors.push(error)

    await transport.start()
    const refused = transport.send({ jsonrpc: "2.0", method: "tools/call", params: { name: "x", arguments: { token: "quartz-pelican-7731" } } })

    await expect(refused).rejects.toThrow("MCP stdio write #0 failed")
    await transport.close()

    const reported = errors.map((error) => error.message).join("\n")
    expect(reported).toContain("MCP stdio write #0 failed: EPIPE broken pipe")
    expect(reported).not.toContain("quartz-pelican-7731")
  }, 20_000)
})

function fakeOwnedProcess(parts: Partial<OwnedProcess>): OwnedProcess {
  const exit: OwnedProcessExit = { code: 0, signal: null, statusOf: "payload", ownership: "surrendered" }
  return {
    pid: 2_147_483_647,
    token: "owned:transport-test",
    stdin: undefined,
    stdout: undefined,
    stderr: undefined,
    exited: Promise.resolve(exit),
    terminate: () => Promise.resolve(exit),
    ...parts,
  }
}

function fakeSink(parts: Partial<Bun.FileSink>): Bun.FileSink {
  return {
    write: () => 0,
    flush: () => 0,
    end: () => 0,
    start: () => {},
    ref: () => {},
    unref: () => {},
    ...parts,
  }
}

/** A started server that records its stdin to `output` once stdin ends. It
 *  returns after the server reports ready, because a bare `bun -e` child can
 *  take longer to start than the transport's exit grace after stdin ends, and
 *  a server that never ran would record nothing. */
async function startedStdinRecorder(scratch: RealProcessFixture, output: string): Promise<BunStdioClientTransport> {
  const source = `process.stdout.write(JSON.stringify({ jsonrpc: "2.0", method: "ready" }) + "\\n"); const input = await new Response(Bun.stdin.stream()).text(); await Bun.write(${JSON.stringify(output)}, input);`
  const transport = new BunStdioClientTransport({
    command: process.execPath,
    args: ["-e", source],
    cwd: process.cwd(),
    env: definedEnvironment(process.env),
    spawnOwned: guardedSpawn(scratch),
  })
  let ready = false
  // oxlint-disable-next-line unicorn/prefer-add-event-listener -- boundary: MCP Transport exposes assignable callbacks, not EventTarget.
  transport.onmessage = (message) => { if ("method" in message && message.method === "ready") ready = true }
  await transport.start()
  await waitFor(() => ready)
  return transport
}

function recordedMethods(file: string): string[] {
  return readFileSync(file, "utf8").trim().split("\n").map((line) => String(JSON.parse(line).method))
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 10_000
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("condition did not become true")
    await Bun.sleep(10)
  }
}

function definedEnvironment(env: NodeJS.ProcessEnv): { [key: string]: string } {
  return Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined))
}

function childPidOf(message: JSONRPCMessage): number | null {
  const params: unknown = "params" in message ? message.params : undefined
  if (params === null || typeof params !== "object" || !("pid" in params)) return null
  return typeof params.pid === "number" ? params.pid : null
}
