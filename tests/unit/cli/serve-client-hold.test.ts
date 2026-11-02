import { afterEach, describe, expect, spyOn, test } from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

import { runServe } from "../../../src/cli/serve.js"
import { SERVE_EXIT } from "../../../src/cli/serve-contract.js"
import { ServeLifetime } from "../../../src/orchestration/app-service/serve-lifetime.js"
import { createPersistentProcessManager } from "../../../src/infra/persistent-process-manager.js"
import { serveLaneFor } from "../../../src/infra/cli-subprocess.js"
import { accountServeSocketPath, accountServeTokenPath } from "../../../src/infra/paths.js"
import { encodeAccountAttach } from "../../../src/protocol/account-attach.js"
import { unprobedLoginShellPath, unusedLauncher, waitFor } from "./_serve-fixtures.js"

// A serve run in this test process serves the lane of this process's executable.
const lane = serveLaneFor(process.execPath)
let temporaryRoot: string | undefined

afterEach(() => {
  if (temporaryRoot) fs.rmSync(temporaryRoot, { recursive: true, force: true })
  temporaryRoot = undefined
})

describe("flywheel serve: an admitted client holds a dev serve", () => {
  test("a dev serve answers an admitted client whose build outlasts its startup and idle graces, then retires once it closes", async () => {
    const serve = await clientBuildServe("fw-serve-client-")
    const socket = await serve.attachClient()
    try {
      await waitFor(() => serve.connectionCounts.includes(1), 2_000)
      // The admitted client holds the serve while the build runs, so no grace
      // runs that could retire it.
      expect(serve.graceRuns()).toBe(false)
      serve.finishBuild()
      await waitFor(() => serve.received().includes('"flywheel":"account.client"'), 2_000)
      expect(serve.received()).toContain(JSON.stringify(path.join(CLIENT_ROOT, "editor")))
      expect(serve.exitCode()).toBeUndefined()
      socket.end()
      await waitFor(serve.graceRuns, 2_000)
      serve.endGraces()
      await waitFor(() => serve.exitCode() !== undefined, 2_000)
    } finally {
      await serve.stop()
    }
    expect(serve.exitCode()).toBe(SERVE_EXIT.parked)
  }, 15_000)

  test("an admitted client that closes before its answer releases its hold, and the dev serve retires", async () => {
    const serve = await clientBuildServe("fw-serve-client-gone-")
    try {
      const socket = await serve.attachClient()
      await waitFor(() => serve.connectionCounts.includes(1), 2_000)
      socket.end()
      // The build never finishes; only the closed connection could hold the serve.
      await waitFor(serve.graceRuns, 2_000)
      serve.endGraces()
      await waitFor(() => serve.exitCode() !== undefined, 2_000)
      expect(serve.connectionCounts.at(-1)).toBe(0)
    } finally {
      await serve.stop()
    }
    expect(serve.exitCode()).toBe(SERVE_EXIT.parked)
  }, 15_000)
})

const CLIENT_ROOT = "/opt/flywheel/webview"

/** A dev-lane serve whose graces end only when the test ends them and whose
 *  web client build waits for the test, and a client that asks it where the
 *  editor's client bundle is. */
async function clientBuildServe(prefix: string) {
  temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  const accountHome = path.join(temporaryRoot, "home")
  const userDataRoot = path.join(accountHome, ".flywheel")
  fs.mkdirSync(userDataRoot, { recursive: true })
  const output: string[] = []
  const write = spyOn(process.stdout, "write").mockImplementation((chunk) => { output.push(String(chunk)); return true })
  // The startup and idle graces the serve's lifetime runs now.
  const graces = new Set<() => void>()
  const setTimer = (fire: () => void): (() => void) => {
    const grace = (): void => { graces.delete(grace); fire() }
    graces.add(grace)
    return () => { graces.delete(grace) }
  }
  const build = Promise.withResolvers<void>()
  const connectionCounts: number[] = []
  class RecordingLifetime extends ServeLifetime {
    override setConnectionCount(count: number): void {
      connectionCounts.push(count)
      super.setConnectionCount(count)
    }
  }
  const manager = createPersistentProcessManager()
  const serving = runServe([], { executionCwd: temporaryRoot, projectRoot: temporaryRoot, accountHome, userDataRoot }, unusedLauncher(), manager, false, {
    drainWatchdog: () => ({ arm() {}, dispose: async () => {} }),
    loginShellPath: unprobedLoginShellPath(),
    startHub: () => ({ origin: "http://127.0.0.1:41000", held: () => true, stop() {} }),
    serveLifetime: () => new RecordingLifetime({ resident: false, setTimer }),
    installedBuild: () => undefined,
    registrationRefresh: () => ({ atStart: async () => "serve", afterListening: async () => {}, atBuildTick: async () => false, startedByManager: () => false }),
    clientAssets: {
      prepare: () => ({ kind: "preparing" }),
      settle: async () => {
        await build.promise
        return { kind: "resolved", root: CLIENT_ROOT, identity: "c".repeat(64) }
      },
      openable: async () => { await build.promise },
    },
  })
  let exitCode: number | undefined
  void serving.then((code) => { exitCode = code })
  await waitFor(() => output.some((chunk) => chunk.includes('"flywheel":"serve.listening"')))
  const credential = fs.readFileSync(accountServeTokenPath(userDataRoot, lane), "utf8").trim()
  let received = ""
  return {
    connectionCounts,
    exitCode: () => exitCode,
    received: () => received,
    finishBuild: () => build.resolve(),
    /** Whether a startup or idle grace runs now. Only the end of a grace can retire the serve. */
    graceRuns: () => graces.size > 0,
    /** Ends every grace that runs now. A grace that one of them starts as it
     *  ends keeps running. */
    endGraces: () => {
      const running = [...graces]
      for (const grace of running) grace()
    },
    async attachClient() {
      const socket = await Bun.connect({
        unix: accountServeSocketPath(userDataRoot, lane),
        socket: { data(_socket, data) { received += new TextDecoder().decode(data) }, error() {}, close() {} },
      })
      socket.write(encodeAccountAttach({ intent: "client", host: "editor", credential }))
      return socket
    },
    async stop() {
      build.resolve()
      if (exitCode === undefined) process.emit("SIGINT", "SIGINT")
      await serving
      manager.releaseAll()
      write.mockRestore()
    },
  }
}
