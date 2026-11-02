import { readFileSync, mkdirSync, realpathSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { expect } from "bun:test"
import { createCliLauncher } from "../../../src/cli/runtime-launch.js"
import { ownedCommandRunner, runOwnedCommand } from "../../../src/infra/owned-command.js"
import { createBackgroundWorkRegistry } from "../../../src/orchestration/agent-runtime/background-work.js"
import { createBashDefinition } from "../../../src/orchestration/agent-runtime/tools/bash.js"
import { probeMutationGuard } from "../../../src/orchestration/agent-runtime/tools/bash-mutation-guard.js"
import { handedOverPrivateCopy, runInPrivateCopy } from "../../../src/orchestration/agent-runtime/tools/bash-project-mutation.js"
import { privateCopyRemovals } from "../../../src/orchestration/agent-runtime/tools/bash-private-copy.js"
import { quotePowerShell } from "../../../src/orchestration/agent-runtime/tools/bash-script.js"
import { createShellRuntime } from "../../../src/orchestration/agent-runtime/tools/shell-runtime.js"
import type { ShellRuntime } from "../../../src/orchestration/agent-runtime/tools/shell-runtime-types.js"
import type { ToolResult } from "../../../src/orchestration/agent-runtime/tools/types.js"
import { temporaryDirectories } from "../../helpers/directories.js"

/** A mutation command against a real Git repository, real clones, and a real
 *  shell, shared by the mutation integration files. */

/** The guard this host applies to a mutating command. */
export const hostGuard = await (async () => {
  const launcher = await createCliLauncher()
  try {
    return await probeMutationGuard(ownedCommandRunner(launcher.scope.open()), process.platform)
  } finally {
    await launcher.dispose()
  }
})()

/** Runs before each process the mutation command's landing launches, with that process's arguments. */
export type BeforeLaunch = (command: readonly string[]) => Promise<void>
export type CopyCommand = (command: string, options?: { readonly beforeLand?: () => Promise<void>; readonly handover?: boolean; readonly legacy?: 2 | 3; readonly interrupted?: boolean }) => Promise<string>
export type GitState = { readonly head: string; readonly headTarget: string; readonly refs: string; readonly index: Buffer; readonly objects: string }
/** One mutating command of a session, with the copy home and working directory it ran in, read from the directory it printed last. */
export type SessionCommand = (command: string) => Promise<{ readonly content: string; readonly home: string; readonly cwd: string }>

/** Returns `inRepository` for one test file. Call it once at the top level of
 *  the file, because the temporary directories it creates belong to that file. */
export function repositoryHarness() {
  const createDirectory = temporaryDirectories()
  /** A committed repository with an ignored node_modules, and one mutation command run in it. */
  async function inRepository(body: (repository: { readonly root: string; readonly realGit: string; readonly mutation: (command: string, beforeLaunch?: BeforeLaunch) => Promise<ToolResult>; readonly copyCommand: CopyCommand; readonly git: (...args: string[]) => Promise<string>; readonly gitState: () => Promise<GitState>; readonly run: (...args: string[]) => ReturnType<typeof runOwnedCommand>; readonly session: () => SessionCommand }) => Promise<void>, format: readonly string[] = []): Promise<void> {
    const root = realpathSync(createDirectory("bash-mutations-"))
    const realGit = Bun.which("git")
    if (!realGit) throw new Error("Git is required for mutation integration tests")
    const launcher = await createCliLauncher()
    const generation = launcher.scope.open()
    const run = (...args: string[]) => runOwnedCommand(generation, ["git", "-c", "user.email=mutations@example.com", "-c", "user.name=Mutations", ...args], { cwd: root })
    const git = async (...args: string[]) => {
      const result = await run(...args)
      expect(result.exitCode).toBe(0)
      return result.stdout
    }
    const gitState = async (): Promise<GitState> => ({
      head: await git("rev-parse", "HEAD"),
      headTarget: await git("symbolic-ref", "HEAD"),
      refs: await git("for-each-ref", "--format=%(refname) %(objectname) %(symref)"),
      index: readFileSync(join(root, ".git", "index")),
      objects: await git("count-objects", "-v"),
    })
    const bashContext = {
      executionCwd: root, userDataRoot: `${root}/.test-account`, projectRoot: root, scratchDir: join(root, ".flywheel", "scratch"),
      availableTools: new Set(["bash", "edit", "write"]), artifactScopeId: "bash-mutation", retrievalSessionId: "bash-mutation", sessionId: "bash-mutation", toolUseId: "bash-mutations-1",
    }
    const mutation = (command: string, beforeLaunch?: BeforeLaunch) => createBashDefinition().execute({ mutates: true, command }, {
      ...bashContext,
      spawnOwned: beforeLaunch ? async (cmd, options) => { await beforeLaunch(cmd); return await generation.spawnOwned(cmd, options) } : generation.spawnOwned,
    })
    // Each session owns one shell runtime, whose real pool and real process table decide reuse.
    const runtimes: ShellRuntime[] = []
    const session = (): SessionCommand => {
      const runtime = createShellRuntime(createBackgroundWorkRegistry({ kind: "chat", enqueueNotification: () => {} }))
      runtimes.push(runtime)
      return async command => {
        const printRoot = process.platform === "win32" ? "\n(Get-Location).Path" : "\npwd"
        const result = await createBashDefinition().execute({ mutates: true, command: command + printRoot }, { ...bashContext, spawnOwned: generation.spawnOwned, shell: runtime.client })
        await privateCopyRemovals()
        const content = String(result.content)
        const printed = [...content.matchAll(/^(.*[\\/]mutations[\\/][0-9a-f-]{36})[\\/]tree[\\/].*$/gm)].at(-1)
        if (!printed?.[1]) throw new Error(`the command did not run in a private copy:\n${content}`)
        return { content, home: printed[1], cwd: printed[0] }
      }
    }
    const copyCommand: CopyCommand = async (command, options = {}) => {
      const scratchDir = join(root, ".flywheel", "scratch")
      const home = join(scratchDir, crypto.randomUUID())
      const context = { executionCwd: root, userDataRoot: `${root}/.test-account`, projectRoot: root, scratchDir, sessionId: "bash-mutation", artifactScopeId: "bash-mutation", retrievalSessionId: "bash-mutation", toolUseId: crypto.randomUUID() }
      const result = await runInPrivateCopy({
        context, spawnOwned: generation.spawnOwned, command, env: process.env, home, scratchDir,
        run: async isolated => {
          expect(isolated).toBeDefined()
          if (!isolated || !("privateCopy" in isolated)) throw new Error("the test requires a private copy")
          expect(isolated.env.GIT_DIR).toBeUndefined()
          expect(isolated.env.GIT_WORK_TREE).toBeUndefined()
          const executed = await ownedCommandRunner({ spawnOwned: isolated.spawnOwned })(["/bin/sh", "-c", isolated.command], { cwd: isolated.context.executionCwd, env: isolated.env })
          await options.beforeLand?.()
          if (options.legacy) {
            const { realRoot, copyRoot, baseRoot, guard, shared, files, links, gitDir, privateGitDir, commonDir, workTrees } = JSON.parse(readFileSync(join(home, "copy.json"), "utf8"))
            // The old shapes contain file observations but no execution-policy baseline.
            const legacy = options.legacy === 2
              ? { version: 2, realRoot, copyRoot, baseRoot, guard, shared, files, links, gitDir }
              : { version: 3, realRoot, copyRoot, baseRoot, guard, shared, files, links, gitDir, privateGitDir, commonDir, workTrees }
            if (options.legacy === 2) writeFileSync(join(home, "index"), readFileSync(join(home, "git", "index")))
            writeFileSync(join(home, "copy.json"), JSON.stringify(legacy))
          }
          const recordBeforeLanding = readFileSync(join(home, "copy.json"))
          const aBeforeLanding = readFileSync(join(isolated.context.executionCwd, "a.txt"))
          const landing = options.handover || options.legacy ? handedOverPrivateCopy({ home, context, spawnOwned: generation.spawnOwned }) : isolated.privateCopy
          const landed = await landing.land({ interrupted: options.interrupted ?? false, signal: undefined, output: executed.stdout + executed.stderr })
          if (landed.report.includes("None of the command's changes were applied")) {
            expect(readFileSync(join(home, "copy.json"))).toEqual(recordBeforeLanding)
            expect(readFileSync(join(isolated.context.executionCwd, "a.txt"))).toEqual(aBeforeLanding)
          }
          return { content: executed.stdout + executed.stderr + "\n" + landed.report, outcome: "ok" }
        },
      })
      expect(result.outcome).not.toBe("error")
      return String(result.content)
    }
    try {
      // `.cache` sorts before `.flywheel`, which holds the copy's home, so a guard must not bind in listing order.
      writeFileSync(join(root, ".gitignore"), "node_modules/\n.flywheel/\n.cache/\n")
      mkdirSync(join(root, ".cache"))
      writeFileSync(join(root, ".cache", "entry"), "cached\n")
      writeFileSync(join(root, "a.txt"), "one\n")
      writeFileSync(join(root, "gone.txt"), "bye\n")
      mkdirSync(join(root, "node_modules", "pkg"), { recursive: true })
      writeFileSync(join(root, "node_modules", "pkg", "index.js"), "dependency\n")
      await git("init", "-q", ...format)
      await git("config", "user.email", "mutations@example.com")
      await git("config", "user.name", "Mutations")
      await git("add", ".")
      await git("commit", "-qm", "init")
      await body({ root, realGit, mutation, copyCommand, git, gitState, run, session })
    } finally {
      for (const runtime of runtimes) await runtime.close()
      await privateCopyRemovals()
      await launcher.dispose()
    }
  }
  return inRepository
}

export function powerShellWrite(filePath: string, content: string): string {
  return `[System.IO.File]::WriteAllText(${quotePowerShell(filePath)}, ${quotePowerShell(content)}, [System.Text.UTF8Encoding]::new($false))`
}
