import { afterEach, describe, expect, spyOn, test } from "bun:test"
import * as fs from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"
import { Redacted } from "effect"

import type { LauncherContext } from "../../../src/infra/process-supervisor.js"
import { createPersistentProcessManager } from "../../../src/infra/persistent-process-manager.js"
import { createAccountProjectRegistry } from "../../../src/orchestration/app-service/account-project-registry.js"
import { createAccountServiceRuntime, type AccountServiceRuntimeOptions } from "../../../src/orchestration/app-service/account-service-runtime.js"
import { createLoginShellPath } from "../../../src/infra/login-shell-path.js"

let temporaryRoot: string | undefined

afterEach(() => {
  if (temporaryRoot) fs.rmSync(temporaryRoot, { recursive: true, force: true })
  temporaryRoot = undefined
})

const launcher: LauncherContext = {
  scope: {
    spawnOwned: async () => { throw new Error("zero-project serve must not launch a process") },
    adoptOwned: async () => { throw new Error("this test adopts no command") },
    open: () => { throw new Error("zero-project serve must not open a launch scope") },
    close: async () => ({ settled: true }),
  },
  guardian: {
    openGeneration: async () => { throw new Error("zero-project serve must not open a guardian generation") },
    pid: async () => 0,
  },
  startGuardian: async () => { throw new Error("zero-project serve must not start a guardian") },
}

/** An account with no project under a fresh temporary root, and the
 *  composition options that no test here varies. */
function zeroProjectAccount(prefix: string) {
  const root = fs.mkdtempSync(path.join(tmpdir(), prefix))
  temporaryRoot = root
  const accountHome = path.join(root, "home")
  const userDataRoot = path.join(accountHome, ".flywheel")
  fs.mkdirSync(userDataRoot, { recursive: true })
  const manager = createPersistentProcessManager()
  const registry = createAccountProjectRegistry({ userDataRoot })
  let registrySubscriptions = 0
  const watchRegistry = registry.watch
  registry.watch = (listener) => {
    registrySubscriptions += 1
    return watchRegistry(listener)
  }
  const options = {
    userDataRoot,
    accountHome,
    lane: "installed",
    version: "test",
    socketPath: path.join(root, "account.sock"),
    credential: Redacted.make("a".repeat(48)),
    launcher,
    persistentProcessManager: manager,
    allowPersistentProcesses: false,
    workerUrl: new URL("../../../src/orchestration/app-service/runtime-worker.ts", import.meta.url).href,
    registry,
    retireIfSuperseded: async () => "busy",
    answerCutover: async () => "busy",
    retire: () => {},
    recordTrustedAttach: async () => {},
    prepareProject: async () => {},
    loginShellPath: createLoginShellPath(),
  } satisfies AccountServiceRuntimeOptions
  return {
    root,
    userDataRoot,
    options,
    registrySubscriptions: () => registrySubscriptions,
    async release() {
      await registry.dispose()
      manager.releaseAll()
    },
  }
}

describe("account service web wake surface", () => {
  test("the account runtime owns its hub for its full lifetime with no projects", async () => {
    const account = zeroProjectAccount("fw-account-hub-")
    const { userDataRoot } = account
    fs.mkdirSync(path.join(account.root, "unopened-project"))
    let hubStopped = false
    // Update work is account-wide: the account runs it with no project open,
    // starting it only once its admission opens after the confirmed listen,
    // and ends it with itself. The account's one config watch is what
    // refreshes its policy, before admission opens as after.
    const composedFor: string[] = []
    const updates = { composedFor, started: 0, refreshed: 0, disposed: 0 }
    // A malformed file at boot degrades to defaults instead of failing the start.
    fs.writeFileSync(path.join(userDataRoot, "flywheel.toml"), "theme = \n")
    const runtime = await createAccountServiceRuntime({
      ...account.options,
      startHub: (options) => {
        void options.listProjects().then((projects) => { expect(projects).toEqual([]) })
        return { origin: "http://127.0.0.1:41000", held: () => true, stop: () => { hubStopped = true } }
      },
      createUpdates: (options) => {
        updates.composedFor.push(options.userDataRoot)
        return {
          status: () => ({ revision: 0, autoInstall: { persisted: true, forcedOff: false, effective: true }, status: { kind: "idle" } }),
          setAutoInstall: async () => ({ ok: true }),
          refreshPolicy: () => { updates.refreshed += 1 },
          subscribe: () => () => {},
          start: () => { updates.started += 1 },
          // A settlement that fails is still joined and observed: disposal
          // reports it and finishes.
          dispose: async () => {
            updates.disposed += 1
            throw new Error("the update Worker did not settle")
          },
        }
      },
    })
    // The Remote module's account relay service subscribes to the account's
    // project registry as it starts, and nothing else in a zero-project
    // account does, so the subscription count shows whether it started.
    try {
      await runtime.ready
      expect(hubStopped).toBe(false)
      await Promise.resolve()
      expect(updates).toEqual({ composedFor: [userDataRoot], started: 0, refreshed: 0, disposed: 0 })
      // A config change before admission opens is read and starts nothing.
      // macOS can miss a write made in the first milliseconds after a
      // directory watch starts, so the edit repeats until the watch hears it.
      for (let waited = 0; updates.refreshed === 0 && waited < 5_000; waited += 20) {
        if (waited % 200 === 0) fs.writeFileSync(path.join(userDataRoot, "flywheel.toml"), "[updates]\nauto_install = false\n")
        await Bun.sleep(20)
      }
      expect(updates.refreshed).toBeGreaterThan(0)
      await Bun.sleep(20)
      expect(account.registrySubscriptions()).toBe(0)
      runtime.openAdmission()
      expect(updates.started).toBe(1)
      for (let waited = 0; account.registrySubscriptions() === 0 && waited < 5_000; waited += 20) await Bun.sleep(20)
      expect(account.registrySubscriptions()).toBe(1)
    } finally {
      await expect(runtime.dispose()).resolves.toBeUndefined()
      await account.release()
    }
    expect(hubStopped).toBe(true)
    expect(updates.disposed).toBe(1)
  }, 15_000)

  test("a composition whose listen fails stops its hub and closes its watch on the account root", async () => {
    const account = zeroProjectAccount("fw-account-fail-")
    // Every watch shares one close, so a spy on it names each watch that
    // closed. Bun exports no FSWatcher class, so a watch of its own shows the
    // shared prototype.
    const probe = fs.watch(account.root, () => {})
    probe.close()
    const close = spyOn(Object.getPrototypeOf(probe), "close")
    const watch = spyOn(fs, "watch")
    let hubStopped = false
    try {
      // No directory holds the socket's path, so the listen throws after the
      // hub started and the account root is watched.
      await expect(createAccountServiceRuntime({
        ...account.options,
        socketPath: path.join(account.root, "missing", "account.sock"),
        startHub: () => ({ origin: "http://127.0.0.1:41000", held: () => true, stop: () => { hubStopped = true } }),
      })).rejects.toThrow()
      expect(hubStopped).toBe(true)
      expect(watch.mock.results).toHaveLength(1)
      expect(close.mock.contexts).toHaveLength(1)
      expect(close.mock.contexts[0]).toBe(watch.mock.results[0]?.value)
    } finally {
      watch.mockRestore()
      close.mockRestore()
      await account.release()
    }
  }, 15_000)
})
