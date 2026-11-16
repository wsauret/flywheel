import { describe, expect, test } from "bun:test"
import type { FileSink } from "bun"
import type { OwnedProcess, OwnedProcessExit } from "../../../../../src/infra/owned-subprocess.js"
import type { LauncherScope } from "../../../../../src/infra/process-supervisor.js"
import type { McpCallResult } from "../../../../../src/orchestration/agent-runtime/mcp-result.js"
import { createDevelopmentIosSimulatorService } from "../../../../../src/orchestration/modules/development/ios-simulator-service.js"
import { REQUIRED_IOS_SIMULATOR_MCP_TOOLS } from "../../../../../src/orchestration/modules/development/ios-simulator-tool.js"
import { connectOwnedIosSimulatorBackend } from "../../../../../src/orchestration/modules/development/ios-simulator-backend.js"
import { moduleProcessServices } from "../../../../helpers/module-kernel.js"

function result(overrides: Partial<McpCallResult> = {}): McpCallResult {
  return { content: [{ type: "text", text: "ok" }], isError: false, ...overrides }
}

interface ToolArguments {
  readonly [key: string]: unknown
}

/** What the fake XcodeBuildMCP server lists and answers. */
interface FakeServer {
  readonly tools?: readonly string[]
  call(name: string, arguments_: ToolArguments): Promise<McpCallResult>
}

interface Launch {
  readonly command: readonly string[]
  readonly env: { readonly [key: string]: string | undefined } | undefined
}

/** The development service over a launcher whose every MCP launch is an
 *  in-process XcodeBuildMCP server speaking JSON-RPC over the owned pipes, and
 *  whose AXe launch is one successful point tap. */
function simulator(server: FakeServer) {
  const launches: Launch[] = []
  const servers: Array<{ exit(): void }> = []
  let closes = 0
  let pointTaps = 0
  const encoder = new TextEncoder()
  const scope: LauncherScope = {
    open: () => scope,
    adoptOwned: async () => { throw new Error("no command is adopted here") },
    close: async () => ({ settled: true }),
    spawnOwned: async (command, options) => {
      if (command[0]?.endsWith("axe")) {
        pointTaps += 1
        return exitedProcess("tap complete\n")
      }
      launches.push({ command, env: options?.env })
      let stdout!: ReadableStreamDefaultController<Uint8Array>
      const exited = Promise.withResolvers<OwnedProcessExit>()
      let running = true
      const exit = (): void => {
        if (!running) return
        running = false
        stdout.close()
        exited.resolve({ code: 0, signal: null, statusOf: "payload", ownership: "surrendered" })
      }
      const reply = (id: unknown, outcome: { result: unknown } | { error: { code: number; message: string } }): void => {
        if (running) stdout.enqueue(encoder.encode(`${JSON.stringify({ jsonrpc: "2.0", id, ...outcome })}\n`))
      }
      const listed = (server.tools ?? REQUIRED_IOS_SIMULATOR_MCP_TOOLS).map((name) => ({
        name, inputSchema: { type: "object", properties: { simulatorId: { type: "string" } } },
      }))
      const receive = (message: { id?: unknown; method?: string; params?: { protocolVersion?: string; name?: string; arguments?: ToolArguments } }): void => {
        if (message.method === "initialize") {
          reply(message.id, { result: { protocolVersion: message.params?.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "fake-xcodebuildmcp", version: "1" } } })
        } else if (message.method === "tools/list") {
          reply(message.id, { result: { tools: listed } })
        } else if (message.method === "tools/call") {
          server.call(message.params?.name ?? "", message.params?.arguments ?? {}).then(
            ({ content, isError, structuredContent }) => reply(message.id, { result: { content, isError, ...(structuredContent === undefined ? {} : { structuredContent }) } }),
            (error: unknown) => reply(message.id, { error: { code: -32603, message: String(error) } }),
          )
        }
      }
      // Stdin EOF is how the client asks an MCP server to stop.
      const stdin: FileSink = {
        write(chunk) {
          if (typeof chunk !== "string") throw new Error("the MCP client writes JSON-RPC text")
          for (const line of chunk.split("\n").filter(Boolean)) receive(JSON.parse(line))
          return chunk.length
        },
        flush: () => 0,
        end() {
          if (running) closes += 1
          exit()
          return 0
        },
        start: () => {},
        ref: () => {},
        unref: () => {},
      }
      servers.push({ exit })
      return {
        pid: 1, token: `mcp-${launches.length}`, stdin,
        stdout: new ReadableStream<Uint8Array>({ start(controller) { stdout = controller } }),
        stderr: new ReadableStream<Uint8Array>({ start(controller) { controller.close() } }),
        exited: exited.promise,
        terminate: async () => { exit(); return exited.promise },
      }
    },
  }
  return {
    service: createDevelopmentIosSimulatorService(moduleProcessServices({ launcher: scope })),
    launches,
    closes: () => closes,
    pointTaps: () => pointTaps,
    /** The latest MCP server exits on its own, as a crashed backend does, and
     *  the client has observed the exit once this settles. */
    async exitLatest() {
      servers.at(-1)?.exit()
      await Bun.sleep(0)
    },
  }
}

function exitedProcess(output: string): OwnedProcess {
  const exit: OwnedProcessExit = { code: 0, signal: null, statusOf: "payload", ownership: "surrendered" }
  return {
    pid: 2, token: "axe", stdin: undefined,
    stdout: new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode(output)); controller.close() } }),
    stderr: new ReadableStream<Uint8Array>({ start(controller) { controller.close() } }),
    exited: Promise.resolve(exit),
    terminate: async () => exit,
  }
}

function snapshotToken(result_: McpCallResult): string {
  const structured = result_.structuredContent
  if (typeof structured !== "object" || structured === null || !("snapshotToken" in structured)) {
    throw new Error("snapshot result has no structured token")
  }
  if (typeof structured.snapshotToken !== "string") throw new Error("snapshot result has no token")
  return structured.snapshotToken
}

describe("iOS simulator service", () => {
  test("shares one MCP-mode backend across snapshot and token-bound tap with the pinned environment", async () => {
    const calls: Array<{ name: string; arguments: ToolArguments }> = []
    const { service, launches, closes } = simulator({
      call: async (name, arguments_) => {
        calls.push({ name, arguments: arguments_ })
        return name === "snapshot_ui"
          ? result({ structuredContent: { capture: { screenHash: "screen-a" } } })
          : result()
      },
    })

    const snapshot = await service.execute({ kind: "call", workflow: "ui-automation", action: "snapshot-ui", mcpName: "snapshot_ui", arguments: { simulatorId: "device-1" } })
    const token = snapshotToken(snapshot)
    await service.execute({
      kind: "call",
      workflow: "ui-automation",
      action: "tap",
      mcpName: "tap",
      snapshotToken: token,
      arguments: { simulatorId: "device-1", elementRef: "e1" },
    })

    expect(launches).toHaveLength(1)
    expect(launches[0]).toMatchObject({
      command: [process.execPath, expect.stringContaining("xcodebuildmcp"), "mcp"],
      env: expect.objectContaining({
        XCODEBUILDMCP_SENTRY_DISABLED: "true",
        XCODEBUILDMCP_ENABLED_WORKFLOWS: "simulator,simulator-management,ui-automation",
        XCODEBUILDMCP_DISABLE_SESSION_DEFAULTS: "true",
      }),
    })
    expect(calls).toEqual([
      { name: "snapshot_ui", arguments: { simulatorId: "device-1" } },
      { name: "tap", arguments: { simulatorId: "device-1", elementRef: "e1" } },
    ])
    await service.dispose()
    expect(closes()).toBe(1)
  })

  test("discovers public schemas and rejects superseded snapshot tokens across callers", async () => {
    const calls: string[] = []
    const { service } = simulator({
      call: async (name) => {
        calls.push(name)
        return result({ structuredContent: { capture: { screenHash: name } } })
      },
    })

    const contracts = await service.execute({ kind: "schema", workflow: "ui-automation", action: "schema" })
    expect(contracts.structuredContent).toMatchObject({
      workflow: "ui-automation",
      actions: expect.arrayContaining([
        { action: "snapshot-ui", mcpName: "snapshot_ui", inputSchema: expect.any(Object) },
        { action: "tap", mcpName: "tap", inputSchema: expect.any(Object) },
        {
          action: "tap-point",
          mcpName: "flywheel_tap_point",
          inputSchema: expect.objectContaining({ required: ["simulatorId", "x", "y"] }),
        },
      ]),
    })

    const first = await service.execute({ kind: "call", workflow: "ui-automation", action: "snapshot-ui", mcpName: "snapshot_ui", arguments: {} })
    const firstToken = snapshotToken(first)
    const second = await service.execute({ kind: "call", workflow: "ui-automation", action: "snapshot-ui", mcpName: "snapshot_ui", arguments: {} })
    const secondToken = snapshotToken(second)
    expect(secondToken).not.toBe(firstToken)

    await expect(service.execute({
      kind: "call",
      workflow: "ui-automation",
      action: "tap",
      mcpName: "tap",
      snapshotToken: firstToken,
      arguments: { elementRef: "e1" },
    })).rejects.toThrow("snapshot token is stale")
    expect(calls).toEqual(["snapshot_ui", "snapshot_ui"])

    await service.execute({
      kind: "call",
      workflow: "ui-automation",
      action: "tap",
      mcpName: "tap",
      snapshotToken: secondToken,
      arguments: { elementRef: "e1" },
    })
    expect(calls).toEqual(["snapshot_ui", "snapshot_ui", "tap"])
    await expect(service.execute({
      kind: "call",
      workflow: "ui-automation",
      action: "tap",
      mcpName: "tap",
      snapshotToken: secondToken,
      arguments: { elementRef: "e1" },
    })).rejects.toThrow("fresh snapshot")
    await service.dispose()
  })

  test("coordinate, key, and simulator display actions invalidate the current snapshot token", async () => {
    const { service } = simulator({
      call: async (name) => name === "snapshot_ui"
        ? result({ structuredContent: { capture: { screenHash: "screen" } } })
        : result(),
    })
    const snapshot = await service.execute({ kind: "call", workflow: "ui-automation", action: "snapshot-ui", mcpName: "snapshot_ui", arguments: {} })
    const token = snapshotToken(snapshot)
    await service.execute({ kind: "call", workflow: "ui-automation", action: "key-press", mcpName: "key_press", arguments: { key: "HOME" } })
    await expect(service.execute({
      kind: "call",
      workflow: "ui-automation",
      action: "tap",
      mcpName: "tap",
      snapshotToken: token,
      arguments: { elementRef: "e1" },
    })).rejects.toThrow("fresh snapshot")

    const nextSnapshot = await service.execute({ kind: "call", workflow: "ui-automation", action: "snapshot-ui", mcpName: "snapshot_ui", arguments: {} })
    const nextToken = snapshotToken(nextSnapshot)
    await service.execute({
      kind: "call",
      workflow: "simulator-management",
      action: "toggle-software-keyboard",
      mcpName: "toggle_software_keyboard",
      arguments: { simulatorId: "device-1" },
    })
    await expect(service.execute({
      kind: "call",
      workflow: "ui-automation",
      action: "tap",
      mcpName: "tap",
      snapshotToken: nextToken,
      arguments: { elementRef: "e1" },
    })).rejects.toThrow("fresh snapshot")
    await service.dispose()
  })

  test("device-point taps invalidate the current semantic snapshot token", async () => {
    const calls: string[] = []
    const { service, pointTaps } = simulator({
      call: async (name) => {
        calls.push(name)
        return name === "snapshot_ui"
          ? result({ structuredContent: { capture: { screenHash: "screen" } } })
          : result()
      },
    })

    const snapshot = await service.execute({
      kind: "call",
      workflow: "ui-automation",
      action: "snapshot-ui",
      mcpName: "snapshot_ui",
      arguments: {},
    })
    const token = snapshotToken(snapshot)
    await service.execute({
      kind: "call",
      workflow: "ui-automation",
      action: "tap-point",
      mcpName: "flywheel_tap_point",
      arguments: { simulatorId: "F9CD63C0-F6CE-49FD-9434-AC90845999CD", x: 31, y: 88 },
    })
    await expect(service.execute({
      kind: "call",
      workflow: "ui-automation",
      action: "tap",
      mcpName: "tap",
      snapshotToken: token,
      arguments: { elementRef: "e1" },
    })).rejects.toThrow("fresh snapshot")
    expect(pointTaps()).toBe(1)
    expect(calls).toEqual(["snapshot_ui"])
    await service.dispose()
  })

  test("pre-aborted and immediately cancelled operations do not start or wedge the service", async () => {
    let calls = 0
    const { service, launches } = simulator({
      call: async () => { calls += 1; return result() },
    })

    const preAborted = new AbortController()
    preAborted.abort(new Error("already cancelled"))
    await expect(service.execute({
      kind: "call",
      workflow: "simulator",
      action: "list",
      mcpName: "list_sims",
      arguments: {},
    }, preAborted.signal)).rejects.toThrow("already cancelled")
    expect(launches).toHaveLength(0)

    const immediate = new AbortController()
    const cancelled = service.execute({
      kind: "call",
      workflow: "simulator",
      action: "list",
      mcpName: "list_sims",
      arguments: {},
    }, immediate.signal)
    immediate.abort(new Error("immediately cancelled"))
    await expect(cancelled).rejects.toThrow("immediately cancelled")

    await service.execute({
      kind: "call",
      workflow: "simulator",
      action: "list",
      mcpName: "list_sims",
      arguments: {},
    })
    expect(launches).toHaveLength(1)
    expect(calls).toBe(1)
    await service.dispose()
  })

  test("cancellation closes the active backend and a later call starts fresh", async () => {
    const started = Promise.withResolvers<void>()
    const restarted = Promise.withResolvers<void>()
    let calls = 0
    // Every call stays unanswered until its backend ends.
    const { service, launches, closes } = simulator({
      call: () => {
        calls += 1
        if (calls === 1) started.resolve()
        else restarted.resolve()
        return new Promise<McpCallResult>(() => {})
      },
    })
    const abort = new AbortController()
    const first = service.execute({ kind: "call", workflow: "ui-automation", action: "snapshot-ui", mcpName: "snapshot_ui", arguments: {} }, abort.signal)
    await started.promise
    abort.abort(new Error("cancelled"))
    await expect(first).rejects.toThrow("cancelled")
    expect(closes()).toBe(1)

    const secondAbort = new AbortController()
    const second = service.execute({ kind: "call", workflow: "simulator", action: "list", mcpName: "list_sims", arguments: {} }, secondAbort.signal)
    await restarted.promise
    secondAbort.abort(new Error("second cancelled"))
    await expect(second).rejects.toThrow("second cancelled")
    expect(launches).toHaveLength(2)
    await service.dispose()
  })

  test("queued cancellation never calls the backend and disposal settles active work", async () => {
    const activeStarted = Promise.withResolvers<void>()
    const releaseActive = Promise.withResolvers<void>()
    let calls = 0
    const { service, closes } = simulator({
      async call() {
        calls += 1
        activeStarted.resolve()
        await releaseActive.promise
        return result()
      },
    })
    const first = service.execute({ kind: "call", workflow: "simulator", action: "list", mcpName: "list_sims", arguments: {} })
    await activeStarted.promise
    const queuedAbort = new AbortController()
    const queued = service.execute({ kind: "call", workflow: "simulator", action: "list", mcpName: "list_sims", arguments: {} }, queuedAbort.signal)
    queuedAbort.abort(new Error("queued cancelled"))
    await expect(queued).rejects.toThrow("queued cancelled")

    const disposing = service.dispose()
    releaseActive.resolve()
    await expect(first).rejects.toThrow("closing")
    await disposing
    expect(calls).toBe(1)
    expect(closes()).toBe(1)
  })

  test("immediate disposal prevents an admitted operation from starting", async () => {
    const { service, launches } = simulator({ call: async () => result() })
    const operation = service.execute({ kind: "call", workflow: "simulator", action: "list", mcpName: "list_sims", arguments: {} })
    await service.dispose()
    await expect(operation).rejects.toThrow("closing")
    expect(launches).toHaveLength(0)
  })

  test("backend exit clears it so the next operation starts a fresh process", async () => {
    const { service, launches, exitLatest } = simulator({ call: async () => result() })
    const snapshot = await service.execute({ kind: "call", workflow: "ui-automation", action: "snapshot-ui", mcpName: "snapshot_ui", arguments: {} })
    const staleToken = snapshotToken(snapshot)
    await exitLatest()
    await expect(service.execute({
      kind: "call",
      workflow: "ui-automation",
      action: "tap",
      mcpName: "tap",
      snapshotToken: staleToken,
      arguments: { elementRef: "e1" },
    })).rejects.toThrow("fresh snapshot")
    await service.execute({ kind: "call", workflow: "simulator", action: "list", mcpName: "list_sims", arguments: {} })
    expect(launches).toHaveLength(2)
    await service.dispose()
  })

  test("refuses a backend whose pinned required tools are incomplete", async () => {
    const { service } = simulator({ tools: ["snapshot_ui"], call: async () => result() })
    await expect(service.execute({ kind: "call", workflow: "ui-automation", action: "snapshot-ui", mcpName: "snapshot_ui", arguments: {} })).rejects.toThrow("missing required tools")
    await service.dispose()
  })

  test("preserves bounded stderr remediation when startup fails", async () => {
    const discarded = "discarded-prefix"
    const remediation = "r".repeat(16_384)
    const diagnostic = `${discarded}${remediation}`
    const fakeClient = {
      connect: async () => { throw new Error("MCP connection closed") },
      close: async () => {},
    }
    let failure: Error | undefined
    try {
      await connectOwnedIosSimulatorBackend({
        command: process.execPath,
        args: ["unused"],
        cwd: "/repo",
        env: {},
        signal: new AbortController().signal,
        requiredTools: [],
        spawnOwned: async () => { throw new Error("unused") },
        createTransport: (options) => {
          options.onStderrRecord?.(diagnostic)
          return {
            start: async () => {},
            send: async () => {},
            close: async () => {},
          }
        },
        connectProtocol: async () => {
          await fakeClient.connect()
          throw new Error("unreachable")
        },
      })
    } catch (error) {
      failure = error instanceof Error ? error : new Error(String(error))
    }

    expect(failure).toBeDefined()
    const retained = failure!.message.split("XcodeBuildMCP startup diagnostic:\n")[1]
    expect(retained).toBe(remediation)
    expect(failure!.message).not.toContain(discarded)
  })
})
