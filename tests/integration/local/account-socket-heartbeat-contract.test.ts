import { test, expect } from "bun:test"
import { Redacted } from "effect"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { RuntimeLivenessPolicy } from "../../../src/protocol/runtime-liveness.js"
import { createRuntimeConnection } from "../../../src/protocol/client/connection.js"
import { serveLaneFor } from "../../../src/infra/cli-subprocess.js"
import { accountServeSocketPath } from "../../../src/infra/paths.js"
import { readOrCreateAccountAttachToken } from "../../../src/orchestration/app-service/account-attach-token.js"
import { nodeSocketLayer } from "../../../vscode/src/runtime/node-socket.js"
import { createIsolatedAccountRuntimeAttach } from "./_account-service.js"
import { stopProjectRuntime } from "./_project-runtime.js"

// The isolated account service is started through this process's bun, so it serves this process's lane.
const LANE = serveLaneFor(process.execPath)

const TEST_LIVENESS: RuntimeLivenessPolicy = {
  heartbeatIntervalMs: 5_000,
  silenceDeadlineMs: 12_000,
}

async function settlementWithin(operation: Promise<unknown>, milliseconds: number): Promise<"resolved" | "rejected" | "timeout"> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), milliseconds)
  })
  try {
    return await Promise.race([operation.then(() => "resolved" as const, () => "rejected" as const), timeout])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

test("the account socket delivers runtime heartbeats to the VS Code client", async () => {
  const dir = mkdtempSync(join(tmpdir(), "flywheel-account-heartbeat-"))
  const accountHome = join(dir, "home")
  const userDataRoot = join(accountHome, ".flywheel")
  const projectRoot = join(dir, "project")
  mkdirSync(join(projectRoot, ".git"), { recursive: true })
  mkdirSync(userDataRoot, { recursive: true })
  const directories = { accountHome, userDataRoot, projectRoot, executionCwd: projectRoot }
  const attach = createIsolatedAccountRuntimeAttach(directories)
  await attach.ensure(() => {})
  const diagnostics: string[] = []
  const connection = createRuntimeConnection({
    socket: nodeSocketLayer({
      socketPath: accountServeSocketPath(userDataRoot, LANE),
      projectRoot,
      credential: Redacted.value(readOrCreateAccountAttachToken(userDataRoot, LANE)),
    }),
    liveness: TEST_LIVENESS,
    onDiagnostic: (message, detail) => diagnostics.push(`${message}: ${String(detail)}`),
  })
  const connected = Promise.withResolvers<void>()
  const states: string[] = []
  const unsubscribeState = connection.onStateChange((state) => {
    states.push(state)
    if (state === "connected") connected.resolve()
  })
  const unsubscribe = connection.subscribe(() => {})

  try {
    const outcome = await Promise.race([
      connected.promise.then(() => "connected" as const),
      new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), TEST_LIVENESS.silenceDeadlineMs)),
    ])
    expect(outcome).toBe("connected")
    await new Promise<void>((resolve) => { setTimeout(resolve, TEST_LIVENESS.silenceDeadlineMs + TEST_LIVENESS.heartbeatIntervalMs) })
    expect(connection.state).toBe("connected")
    expect(states).toEqual(["connected"])
    expect(diagnostics).toEqual([])
  } finally {
    unsubscribe()
    unsubscribeState()
    const clientClosed = await settlementWithin(connection.close(), 1_500)
    await stopProjectRuntime(directories)
    rmSync(dir, { recursive: true, force: true })
    expect(clientClosed).toBe("resolved")
  }
}, 30_000)
