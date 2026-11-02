import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createTerminalHandoff, LAUNCH_STATE_ENV, REMOTE_HANDOFF_ENV, type TerminalHandoffOptions } from "../../../src/cli/terminal-handoff.js"
import type { ServingBuild } from "../../../src/cli/serving-build.js"
import { takeLaunchState, type LaunchState } from "../../../src/infra/launch-state.js"
import { accountServeDir } from "../../../src/infra/paths.js"

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

const target: ServingBuild = { version: "2.0.0", command: ["/versions/2.0.0/b/flywheel-bin"], env: { FLYWHEEL_NATIVE_DIR: "/versions/2.0.0/b/native/darwin-arm64" } }

function place(projectRoot: string, foreground: string): LaunchState {
  return { version: 3, projectRoot, foreground, tabs: [foreground], scroll: {}, disclosure: {}, drafts: {}, questionDrafts: {}, modal: { kind: "none" } }
}

function options(overrides: Partial<TerminalHandoffOptions> = {}): TerminalHandoffOptions {
  const userDataRoot = mkdtempSync(join(tmpdir(), "flywheel-handoff-"))
  roots.push(userDataRoot)
  mkdirSync(accountServeDir(userDataRoot, "installed"), { recursive: true })
  return { lane: "installed", userDataRoot, projectRoot: "/work/project", allowPersistentProcesses: true, printLogs: false, incoming: undefined, ...overrides }
}

class Replaced extends Error {}

describe("the terminal handoff", () => {
  test("releases what this image owns, then replaces it with the serving build carrying the captured place", async () => {
    const given = options()
    const events: string[] = []
    const replaced: { command: readonly string[]; env: { readonly [name: string]: string | undefined }; handed: unknown }[] = []
    const handoff = createTerminalHandoff(given, {
      env: { PATH: "/bin" },
      leaveTerminal: async () => {
        events.push("leave")
        return { state: place(given.projectRoot, "session-now"), resume: async () => { events.push("resume") }, destroy: async () => { throw new Error("replacement keeps the renderer resumable") } }
      },
      replace: (command, env) => {
        events.push("replace")
        replaced.push({ command, env, handed: takeLaunchState(env[LAUNCH_STATE_ENV] ?? "", given.projectRoot) })
        throw new Replaced()
      },
      runSuccessor: async () => { throw new Error("no successor child when the image is replaced") },
    })
    handoff.release(() => { events.push("withdraw live build") })
    handoff.release(async () => { events.push("dispose launcher") })

    await expect(handoff.follow(target)).rejects.toBeInstanceOf(Replaced)

    // A replacement that returned at all failed, so the renderer comes back.
    expect(events).toEqual(["leave", "withdraw live build", "dispose launcher", "replace", "resume"])
    const [first] = replaced
    if (first === undefined) throw new Error("the terminal was not replaced")
    const { command, env, handed } = first
    // Arguments every build parses; the place rides the environment, which a
    // build that predates it ignores and starts plain.
    expect(command).toEqual(["/versions/2.0.0/b/flywheel-bin", "--project-root", "/work/project", "--allow-persistent-processes"])
    expect(env).toEqual({ PATH: "/bin", FLYWHEEL_NATIVE_DIR: "/versions/2.0.0/b/native/darwin-arm64", [LAUNCH_STATE_ENV]: expect.stringContaining(accountServeDir(given.userDataRoot, "installed")) })
    expect(handed).toEqual({ kind: "restore", state: place(given.projectRoot, "session-now") })
  })

  test("a terminal attached to a remote machine hands its successor the project there, never a local project root", async () => {
    const given = options({ remote: "machine.project" })
    const replaced: { command: readonly string[]; env: { readonly [name: string]: string | undefined } }[] = []
    const handoff = createTerminalHandoff(given, {
      env: { [REMOTE_HANDOFF_ENV]: "stale.project" },
      leaveTerminal: async () => ({ state: undefined, resume: async () => {}, destroy: async () => {} }),
      replace: (command, env) => {
        replaced.push({ command, env })
        throw new Replaced()
      },
    })
    await expect(handoff.follow(target)).rejects.toBeInstanceOf(Replaced)
    expect(replaced).toEqual([{ command: ["/versions/2.0.0/b/flywheel-bin", "--remote", "--allow-persistent-processes"], env: { FLYWHEEL_NATIVE_DIR: "/versions/2.0.0/b/native/darwin-arm64", [REMOTE_HANDOFF_ENV]: "machine.project" } }])
  })

  test("closes the suspended renderer after its Windows successor ends, then exits with its status", async () => {
    const given = options({ incoming: undefined })
    const events: string[] = []
    let ran: { readonly [name: string]: string | undefined } = {}
    const handoff = createTerminalHandoff(given, {
      env: {},
      leaveTerminal: async () => ({
        state: place(given.projectRoot, "session-now"),
        resume: async () => { events.push("resume") },
        destroy: async () => {
          events.push("destroy")
          await Promise.resolve()
          events.push("closed")
        },
      }),
      platform: "win32",
      runSuccessor: async (_command, env) => {
        events.push("successor ran")
        ran = env
        return 3
      },
      exit: (code) => {
        events.push(`exit ${code}`)
        throw new Replaced()
      },
    })
    handoff.release(() => { events.push("release") })

    await expect(handoff.follow(target)).rejects.toBeInstanceOf(Replaced)

    expect(events).toEqual(["successor ran", "release", "destroy", "closed", "exit 3"])
    expect(ran[LAUNCH_STATE_ENV]).toBeDefined()
  })

  test("passes on the place it was handed when no shell has mounted yet, and nothing when it holds none", async () => {
    const given = options({ incoming: place("/work/project", "session-handed") })
    const envs: { readonly [name: string]: string | undefined }[] = []
    const replace = (_command: readonly string[], env: { readonly [name: string]: string | undefined }): never => {
      envs.push(env)
      throw new Replaced()
    }
    const handed: unknown[] = []
    const keep = (command: readonly string[], env: { readonly [name: string]: string | undefined }): never => {
      handed.push(takeLaunchState(env[LAUNCH_STATE_ENV] ?? "", "/work/project"))
      return replace(command, env)
    }
    await expect(createTerminalHandoff(given, { env: {}, leaveTerminal: async () => ({ state: undefined, resume: async () => {}, destroy: async () => {} }), replace: keep }).follow(target)).rejects.toBeInstanceOf(Replaced)
    expect(handed).toEqual([expect.objectContaining({ kind: "restore", state: expect.objectContaining({ foreground: "session-handed" }) })])

    // A place this process was itself handed and inherited never reaches a successor that gets none.
    await expect(createTerminalHandoff(options(), { env: { [LAUNCH_STATE_ENV]: "/stale.json" }, leaveTerminal: async () => ({ state: undefined, resume: async () => {}, destroy: async () => {} }), replace }).follow(target)).rejects.toBeInstanceOf(Replaced)
    expect(envs[1] !== undefined && LAUNCH_STATE_ENV in envs[1]).toBe(false)
  })

  test("resumes the terminal, removes the state file, and reports the same failure after a successor that cannot start", async () => {
    const given = options()
    const events: string[] = []
    let followed = 0
    const handoff = createTerminalHandoff(given, {
      env: {},
      leaveTerminal: async () => ({ state: place(given.projectRoot, "session-now"), resume: async () => { events.push("resume") }, destroy: async () => { throw new Error("failed handoff keeps the renderer resumable") } }),
      replace: undefined,
      runSuccessor: async (_command, env) => {
        followed += 1
        const path = env[LAUNCH_STATE_ENV] ?? ""
        expect(existsSync(path)).toBe(true)
        events.push(path)
        throw new Error("Executable not found")
      },
      exit: () => { throw new Error("must not exit") },
    })

    await expect(handoff.follow(target)).rejects.toThrow("Executable not found")
    expect(events[1]).toBe("resume")
    expect(existsSync(events[0] ?? "")).toBe(false)
    // A handoff that failed once is a fault, not a loop of suspend and resume.
    await expect(handoff.follow(target)).rejects.toThrow("Executable not found")
    expect(followed).toBe(1)
  })
})
