import { describe, expect, test } from "bun:test"
import { resolve as resolvePath } from "node:path"
import { fileURLToPath } from "node:url"
import { runsThroughBun } from "../../../src/infra/cli-subprocess.js"

import { createCliLauncher, guardianCommand } from "../../../src/cli/runtime-launch.js"
import { EXECUTABLE_ROLES, internalExecutableRole } from "../../../src/infra/executable-roles.js"
import type { OwnedProcess } from "../../../src/infra/owned-subprocess.js"


/** A container that records how it ended, so a scope's close is observable
 *  without a real process. */
function fakeOwned(pid: number, ended: string[]): OwnedProcess {
  let settle: () => void = () => {}
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null; statusOf: "payload"; ownership: "surrendered" }>((resolve) => {
    settle = () => resolve({ code: 0, signal: null, statusOf: "payload", ownership: "surrendered" })
  })
  return {
    pid,
    token: `owned:${pid}`,
    stdin: undefined,
    stdout: undefined,
    stderr: undefined,
    exited,
    terminate() {
      ended.push(`terminate:${pid}`)
      settle()
      return exited
    },
  }
}

function fakeSupervisor() {
  const ended: string[] = []
  let pid = 100
  let disposeCount = 0
  let startCount = 0
  return {
    ended,
    disposed: () => disposeCount,
    started: () => startCount,
    supervisor: {
      guardian: {
        openGeneration: async () => { throw new Error("not used") },
        pid: async () => 1,
      },
      start: async () => { startCount += 1 },
      spawnOwned: async () => fakeOwned(pid++, ended),
      adoptOwned: async () => { throw new Error("not used") },
      dispose: async () => {
        disposeCount += 1
      },
    },
  }
}

describe("internal roles", () => {
  test("the guardian role is selected from argv, not from a command", () => {
    expect(internalExecutableRole(["bun", resolvePath("src/cli/index.ts"), EXECUTABLE_ROLES.guardian])).toBe(EXECUTABLE_ROLES.guardian)
    expect(internalExecutableRole(["flywheel", "--internal-role=worker"])).toBeUndefined()
    expect(internalExecutableRole(["flywheel", "auth", "login"])).toBeUndefined()
  })

  test("source and compiled distributions reach the guardian through this same entry", () => {
    const command = guardianCommand()

    expect(command[0]).toBe(process.execPath)
    expect(command.at(-1)).toBe(EXECUTABLE_ROLES.guardian)
    // Running from source needs the module path Bun should execute; a compiled
    // binary is its own entry and takes the role argument alone. Which case this
    // is comes from the same authority the command builder uses, so the
    // expectation holds wherever the executable is named `bun` or `bun.exe`.
    expect(command).toHaveLength(runsThroughBun(process.execPath) ? 3 : 2)
  })

  // Every Flywheel process starts one guardian, and every open project one
  // command supervisor. `effect/Schema` reaches most of Effect, which cost
  // each of them about 14 MB of resident memory before it ran any code.
  test("the guardian and command supervisor roles load no Effect Schema when they start", async () => {
    for (const role of ["process-guardian.ts", "owned-command-supervisor.ts"]) {
      const entry = fileURLToPath(new URL(`../../../src/infra/${role}`, import.meta.url))
      const bundle = await Bun.build({ entrypoints: [entry], target: "bun", metafile: true })
      const inputs = bundle.metafile?.inputs ?? {}
      // A role's own lazy imports load only when it reaches them, so only
      // static edges count toward what the role loads when it starts.
      const loaded = new Set<string>()
      const pending = Object.keys(inputs).filter((path) => path.endsWith(`src/infra/${role}`))
      for (let path = pending.pop(); path !== undefined; path = pending.pop()) {
        if (loaded.has(path)) continue
        loaded.add(path)
        pending.push(...(inputs[path]?.imports ?? []).filter((edge) => edge.kind === "import-statement").map((edge) => edge.path))
      }

      expect(loaded.size).toBeGreaterThan(1)
      expect([...loaded].filter((path) => path.endsWith("effect/dist/Schema.js"))).toEqual([])
    }
  })
})

describe("the CLI launcher context", () => {
  test("opening the context leaves guardian startup to the first owned spawn", async () => {
    const { supervisor, disposed, started } = fakeSupervisor()

    const launcher = await createCliLauncher(supervisor)
    expect(started()).toBe(0)
    await launcher.dispose()

    expect(disposed()).toBe(1)
  })

  test("the context starts the guardian ahead of the first spawn only when asked", async () => {
    const { supervisor, started } = fakeSupervisor()

    const launcher = await createCliLauncher(supervisor)
    await launcher.startGuardian()

    expect(started()).toBe(1)
    await launcher.dispose()
  })

  test("closing the context terminates what every nested scope still holds", async () => {
    const { supervisor, ended } = fakeSupervisor()
    const launcher = await createCliLauncher(supervisor)
    const generation = launcher.scope.open()

    const direct = await launcher.scope.spawnOwned(["sleep", "60"])
    const nested = await generation.spawnOwned(["sleep", "60"])
    await launcher.dispose()

    expect(ended.toSorted()).toEqual([`terminate:${direct.pid}`, `terminate:${nested.pid}`].toSorted())
  })

  test("a closed scope admits nothing and hands out no live replacement", async () => {
    const { supervisor, ended } = fakeSupervisor()
    const launcher = await createCliLauncher(supervisor)
    const generation = launcher.scope.open()

    await generation.close()

    await expect(generation.spawnOwned(["sleep", "60"])).rejects.toThrow("launcher scope is closed")
    const replacement = generation.open()
    await expect(replacement.spawnOwned(["sleep", "60"])).rejects.toThrow("launcher scope is closed")
    expect(ended).toEqual([])
    await launcher.dispose()
  })

  test("a container that starts while its scope is closing is not left behind", async () => {
    const { supervisor, ended } = fakeSupervisor()
    const launcher = await createCliLauncher(supervisor)
    const generation = launcher.scope.open()

    const starting = generation.spawnOwned(["sleep", "60"])
    const closed = generation.close()

    await expect(starting).rejects.toThrow("launcher scope is closed")
    await closed
    expect(ended).toEqual(["terminate:100"])
    await launcher.dispose()
  })

  test("a container that exits on its own is not terminated at close", async () => {
    const { supervisor, ended } = fakeSupervisor()
    const launcher = await createCliLauncher(supervisor)

    const owned = await launcher.scope.spawnOwned(["true"])
    await owned.terminate()
    ended.length = 0
    await launcher.dispose()

    expect(ended).toEqual([])
  })
})
