import { describe, expect, test } from "bun:test"
import type { OwnedCommandResult } from "../../../../../src/infra/owned-command.js"
import { createLauncherScope } from "../../../../../src/infra/process-supervisor.js"
import type { McpCallResult } from "../../../../../src/orchestration/agent-runtime/mcp-result.js"
import {
  createIosSimulatorService,
} from "../../../../../src/orchestration/modules/development/ios-simulator-service.js"
import {
  connectOwnedIosSimulatorBackend,
  type IosSimulatorBackendConnectionInput,
} from "../../../../../src/orchestration/modules/development/ios-simulator-backend.js"

function result(overrides: Partial<McpCallResult> = {}): McpCallResult {
  return { content: [{ type: "text", text: "ok" }], isError: false, ...overrides }
}

function commandResult(): OwnedCommandResult {
  const stdout = "tap complete\n"
  return { exitCode: 0, stdout, stdoutBytes: new TextEncoder().encode(stdout), stderr: "", timedOut: false }
}

function unusedLauncher() {
  return createLauncherScope({ spawnOwned: async () => { throw new Error("connect test double owns launch") }, adoptOwned: () => Promise.reject(new Error("no command is adopted here")) })
}

function tools(names: readonly string[]): ReadonlyMap<string, unknown> {
  return new Map(names.map((name) => [name, { type: "object", properties: { simulatorId: { type: "string" } } }]))
}

interface ToolArguments {
  readonly [key: string]: unknown
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
    const starts: IosSimulatorBackendConnectionInput[] = []
    let closes = 0
    const service = createIosSimulatorService({
      launcher: unusedLauncher(),
      executionCwd: "/repo",
      connect: async (input) => {
        starts.push(input)
        return {
          tools: tools(input.requiredTools),
          call: async (name, arguments_) => {
            calls.push({ name, arguments: arguments_ })
            return name === "snapshot_ui"
              ? result({ structuredContent: { capture: { screenHash: "screen-a" } } })
              : result()
          },
          close: async () => { closes += 1 },
          onClose: () => {},
        }
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

    expect(starts).toHaveLength(1)
    expect(starts[0]).toMatchObject({
      command: process.execPath,
      args: [expect.stringContaining("xcodebuildmcp"), "mcp"],
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
    expect(closes).toBe(1)
  })

  test("discovers public schemas and rejects superseded snapshot tokens across callers", async () => {
    const calls: string[] = []
    const service = createIosSimulatorService({
      launcher: unusedLauncher(),
      executionCwd: "/repo",
      connect: async (input) => ({
        tools: tools(input.requiredTools),
        call: async (name) => {
          calls.push(name)
          return result({ structuredContent: { capture: { screenHash: name } } })
        },
        close: async () => {},
        onClose: () => {},
      }),
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
    const service = createIosSimulatorService({
      launcher: unusedLauncher(),
      executionCwd: "/repo",
      connect: async (input) => ({
        tools: tools(input.requiredTools),
        call: async (name) => name === "snapshot_ui"
          ? result({ structuredContent: { capture: { screenHash: "screen" } } })
          : result(),
        close: async () => {},
        onClose: () => {},
      }),
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
    let pointTaps = 0
    const service = createIosSimulatorService({
      launcher: unusedLauncher(),
      executionCwd: "/repo",
      runOwnedCommand: async () => { pointTaps += 1; return commandResult() },
      connect: async (input) => ({
        tools: tools(input.requiredTools),
        call: async (name) => {
          calls.push(name)
          return name === "snapshot_ui"
            ? result({ structuredContent: { capture: { screenHash: "screen" } } })
            : result()
        },
        close: async () => {},
        onClose: () => {},
      }),
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
    expect(pointTaps).toBe(1)
    expect(calls).toEqual(["snapshot_ui"])
    await service.dispose()
  })

  test("pre-aborted and immediately cancelled operations do not start or wedge the service", async () => {
    let starts = 0
    let calls = 0
    const service = createIosSimulatorService({
      launcher: unusedLauncher(),
      executionCwd: "/repo",
      connect: async (input) => {
        starts += 1
        return {
          tools: tools(input.requiredTools),
          call: async () => { calls += 1; return result() },
          close: async () => {},
          onClose: () => {},
        }
      },
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
    expect(starts).toBe(0)

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
    expect(starts).toBe(1)
    expect(calls).toBe(1)
    await service.dispose()
  })

  test("cancellation closes the active backend and a later call starts fresh", async () => {
    const started = Promise.withResolvers<void>()
    const restarted = Promise.withResolvers<void>()
    let starts = 0
    let closes = 0
    const service = createIosSimulatorService({
      launcher: unusedLauncher(),
      executionCwd: "/repo",
      connect: async (input) => {
        starts += 1
        if (starts === 2) restarted.resolve()
        let close = () => {}
        const closed = new Promise<void>((resolve) => { close = resolve })
        return {
          tools: tools(input.requiredTools),
          async call() {
            started.resolve()
            await closed
            throw new Error("backend closed")
          },
          async close() {
            closes += 1
            close()
          },
          onClose: () => {},
        }
      },
    })
    const abort = new AbortController()
    const first = service.execute({ kind: "call", workflow: "ui-automation", action: "snapshot-ui", mcpName: "snapshot_ui", arguments: {} }, abort.signal)
    await started.promise
    abort.abort(new Error("cancelled"))
    await expect(first).rejects.toThrow("cancelled")
    expect(closes).toBe(1)

    const secondAbort = new AbortController()
    const second = service.execute({ kind: "call", workflow: "simulator", action: "list", mcpName: "list_sims", arguments: {} }, secondAbort.signal)
    await restarted.promise
    secondAbort.abort(new Error("second cancelled"))
    await expect(second).rejects.toThrow("second cancelled")
    expect(starts).toBe(2)
    await service.dispose()
  })

  test("queued cancellation never calls the backend and disposal settles active work", async () => {
    const activeStarted = Promise.withResolvers<void>()
    const releaseActive = Promise.withResolvers<void>()
    let calls = 0
    let closes = 0
    const service = createIosSimulatorService({
      launcher: unusedLauncher(),
      executionCwd: "/repo",
      connect: async (input) => ({
        tools: tools(input.requiredTools),
        async call() {
          calls += 1
          activeStarted.resolve()
          await releaseActive.promise
          return result()
        },
        async close() { closes += 1 },
        onClose: () => {},
      }),
    })
    const first = service.execute({ kind: "call", workflow: "simulator", action: "list", mcpName: "list_sims", arguments: {} })
    await activeStarted.promise
    const queuedAbort = new AbortController()
    const queued = service.execute({ kind: "call", workflow: "simulator", action: "list", mcpName: "list_sims", arguments: {} }, queuedAbort.signal)
    queuedAbort.abort(new Error("queued cancelled"))
    await expect(queued).rejects.toThrow("queued cancelled")

    const disposing = service.dispose()
    releaseActive.resolve()
    await first
    await disposing
    expect(calls).toBe(1)
    expect(closes).toBe(1)
  })

  test("immediate disposal prevents an admitted operation from starting", async () => {
    let starts = 0
    const service = createIosSimulatorService({
      launcher: unusedLauncher(),
      executionCwd: "/repo",
      connect: async (input) => {
        starts += 1
        return {
          tools: tools(input.requiredTools),
          call: async () => result(),
          close: async () => {},
          onClose: () => {},
        }
      },
    })
    const operation = service.execute({ kind: "call", workflow: "simulator", action: "list", mcpName: "list_sims", arguments: {} })
    await service.dispose()
    await expect(operation).rejects.toThrow("closing")
    expect(starts).toBe(0)
  })

  test("backend exit clears it so the next operation starts a fresh process", async () => {
    const exits: Array<() => void> = []
    let starts = 0
    const service = createIosSimulatorService({
      launcher: unusedLauncher(),
      executionCwd: "/repo",
      connect: async (input) => {
        starts += 1
        let notify = () => {}
        exits.push(() => notify())
        return {
          tools: tools(input.requiredTools),
          call: async () => result(),
          close: async () => {},
          onClose(callback) { notify = callback },
        }
      },
    })
    const snapshot = await service.execute({ kind: "call", workflow: "ui-automation", action: "snapshot-ui", mcpName: "snapshot_ui", arguments: {} })
    const staleToken = snapshotToken(snapshot)
    exits[0]?.()
    await expect(service.execute({
      kind: "call",
      workflow: "ui-automation",
      action: "tap",
      mcpName: "tap",
      snapshotToken: staleToken,
      arguments: { elementRef: "e1" },
    })).rejects.toThrow("fresh snapshot")
    await service.execute({ kind: "call", workflow: "simulator", action: "list", mcpName: "list_sims", arguments: {} })
    expect(starts).toBe(2)
    await service.dispose()
  })

  test("refuses a backend whose pinned required tools are incomplete", async () => {
    const service = createIosSimulatorService({
      launcher: unusedLauncher(),
      executionCwd: "/repo",
      connect: async () => ({
        tools: tools(["snapshot_ui"]),
        call: async () => result(),
        close: async () => {},
        onClose: () => {},
      }),
    })
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
