import { describe, expect, test } from "bun:test"

import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve as resolvePath } from "node:path"
import { createLoginShellPath } from "../../../../src/infra/login-shell-path.js"
import type { OwnedCommandOptions, OwnedCommandResult, OwnedCommandRunner } from "../../../../src/infra/owned-command.js"
import { createGitAiAttributionService, GIT_AI_AGENT_NAME } from "../../../../src/orchestration/agent-runtime/git-ai-attribution-service.js"

const ok: OwnedCommandResult = { exitCode: 0, timedOut: false, stdoutBytes: new Uint8Array(), stdout: "", stderr: "" }
const REPOSITORY_ROOT = resolvePath("/repo")
interface Environment { [key: string]: string | undefined }

function request() {
  return {
    requestId: "request-1",
    model: "openai/gpt-5",
    conversationId: "conversation-1",
    transcript: () => ({ messages: [{ type: "user" as const, text: "Change it", timestamp: "2026-01-01T00:00:00.000Z" }] }),
    transcriptBytes: 0,
  }
}

describe("GitAiAttributionService", () => {
  test("emits one exact human and ai_agent pair for a direct job", async () => {
    const calls: Array<{ command: readonly string[]; options?: OwnedCommandOptions }> = []
    const run: OwnedCommandRunner = async (command, options) => { calls.push({ command, options }); return ok }
    const service = createGitAiAttributionService({ canonicalRepositoryRoot: REPOSITORY_ROOT, runOwnedCommand: run, resolveExecutable: () => "git-ai" })
    const identity = service.registerRequest(request())!

    service.direct({ identity, files: [{ path: "src/a.ts", beforeContent: "before\n", afterContent: "after\n" }] })
    await service.dispose()

    expect(calls.map((call) => call.command)).toEqual([
      ["git-ai", "checkpoint", "agent-v1", "--hook-input", "stdin"],
      ["git-ai", "checkpoint", "agent-v1", "--hook-input", "stdin"],
    ])
    expect(JSON.parse(calls[0]!.options!.stdin!)).toEqual({
      type: "human",
      repo_working_dir: REPOSITORY_ROOT,
      will_edit_filepaths: [join(REPOSITORY_ROOT, "src/a.ts")],
      dirty_files: { [join(REPOSITORY_ROOT, "src/a.ts")]: "before\n" },
    })
    expect(JSON.parse(calls[1]!.options!.stdin!)).toEqual({
      type: "ai_agent",
      repo_working_dir: REPOSITORY_ROOT,
      transcript: request().transcript(),
      agent_name: GIT_AI_AGENT_NAME,
      edited_filepaths: [join(REPOSITORY_ROOT, "src/a.ts")],
      dirty_files: { [join(REPOSITORY_ROOT, "src/a.ts")]: "after\n" },
      model: "openai/gpt-5",
      conversation_id: "conversation-1",
    })
    expect(calls.every((call) => call.options?.cwd === REPOSITORY_ROOT && call.options.timeoutMs === 2_000)).toBe(true)
  })

  test("checks availability without launching the executable", async () => {
    const commands: string[][] = []
    const run: OwnedCommandRunner = async (command) => { commands.push([...command]); return ok }
    const service = createGitAiAttributionService({ canonicalRepositoryRoot: REPOSITORY_ROOT, runOwnedCommand: run, resolveExecutable: () => "/bin/git-ai" })

    await expect(service.checkAvailability()).resolves.toEqual({ kind: "available" })
    await service.dispose()
    expect(commands).toEqual([])
  })

  test("finds and runs git-ai on a login shell PATH that arrives after the startup check", async () => {
    const LOGIN_PATH = "/scratch/login/bin:/usr/bin"
    const loginShellPath = createLoginShellPath({ platform: "darwin" })
    const runs: Array<{ command: readonly string[]; path?: string }> = []
    const run: OwnedCommandRunner = async (command, options) => { runs.push({ command, path: options?.env?.PATH }); return ok }
    const service = createGitAiAttributionService({
      canonicalRepositoryRoot: REPOSITORY_ROOT,
      runOwnedCommand: run,
      loginShellPath,
      resolveExecutable: (path) => path === LOGIN_PATH ? "/scratch/login/bin/git-ai" : null,
    })
    const published: unknown[] = []
    service.subscribe((status) => { published.push(status) })

    await expect(service.checkAvailability()).resolves.toEqual({ kind: "unavailable", reason: "command-not-found" })
    loginShellPath.adopt(LOGIN_PATH)
    expect(service.status()).toEqual({ kind: "available" })
    expect(published.at(-1)).toEqual({ kind: "available" })

    service.direct({ identity: service.registerRequest(request())!, files: [{ path: "a.ts", beforeContent: "a", afterContent: "b" }] })
    await service.dispose()
    expect(runs).toHaveLength(2)
    expect(runs.every((entry) => entry.command[0] === "/scratch/login/bin/git-ai" && entry.path === LOGIN_PATH)).toBe(true)
  })

  test("launches checkpoints with an explicit secret-minimized environment", async () => {
    const environments: Array<Environment | undefined> = []
    const run: OwnedCommandRunner = async (_command, options) => { environments.push(options?.env); return ok }
    const service = createGitAiAttributionService({ canonicalRepositoryRoot: REPOSITORY_ROOT, runOwnedCommand: run, resolveExecutable: () => "/bin/git-ai" })
    const identity = service.registerRequest(request())!
    process.env.FLYWHEEL_GIT_AI_TEST_SECRET = "must-not-cross"
    try {
      service.direct({ identity, files: [{ path: "a.ts", beforeContent: "a", afterContent: "b" }] })
      await service.dispose()
    } finally {
      delete process.env.FLYWHEEL_GIT_AI_TEST_SECRET
    }

    expect(environments).toHaveLength(2)
    expect(environments.every((env) => env !== undefined)).toBe(true)
    expect(environments.every((env) => env?.FLYWHEEL_GIT_AI_TEST_SECRET === undefined)).toBe(true)
  })

  test("bounds queued operations while a repository lane is busy", async () => {
    let releaseFirst!: () => void
    const first = new Promise<void>((resolve) => { releaseFirst = resolve })
    let launches = 0
    const run: OwnedCommandRunner = async () => {
      launches += 1
      if (launches === 1) await first
      return ok
    }
    const service = createGitAiAttributionService({ canonicalRepositoryRoot: REPOSITORY_ROOT, runOwnedCommand: run, resolveExecutable: () => "git-ai" })
    const identity = service.registerRequest(request())!

    for (let index = 0; index < 40; index += 1) {
      service.direct({ identity, files: [{ path: `${index}.ts`, beforeContent: "a", afterContent: "b" }] })
    }
    releaseFirst()
    await service.dispose()

    expect(launches).toBe(64)
  })

  test("drops a direct job larger than the queue byte budget", async () => {
    let launches = 0
    const service = createGitAiAttributionService({
      canonicalRepositoryRoot: REPOSITORY_ROOT,
      runOwnedCommand: async () => { launches += 1; return ok },
      resolveExecutable: () => "git-ai",
    })
    const identity = service.registerRequest(request())!

    service.direct({ identity, files: [{ path: "large.ts", beforeContent: "x".repeat(5 * 1_024 * 1_024), afterContent: "" }] })
    await service.dispose()

    expect(launches).toBe(0)
  })

  test("counts lazy transcript work against the repository queue budget", async () => {
    let releaseFirst!: () => void
    const first = new Promise<void>((resolveFirst) => { releaseFirst = resolveFirst })
    let launches = 0
    let transcriptCalls = 0
    const service = createGitAiAttributionService({
      canonicalRepositoryRoot: REPOSITORY_ROOT,
      runOwnedCommand: async () => { launches += 1; if (launches === 1) await first; return ok },
      resolveExecutable: () => "git-ai",
    })
    const identity = service.registerRequest({
      ...request(),
      transcriptBytes: 5 * 1_024 * 1_024,
      transcript: () => { transcriptCalls += 1; return { messages: [] } },
    })!

    service.direct({ identity, files: [{ path: "first.ts", beforeContent: "a", afterContent: "b" }] })
    service.direct({ identity, files: [{ path: "second.ts", beforeContent: "a", afterContent: "b" }] })
    expect(transcriptCalls).toBe(0)
    releaseFirst()
    await service.dispose()

    expect(launches).toBe(2)
    expect(transcriptCalls).toBe(1)
  })

  test("rejects a direct path that escapes through a repository symlink", async () => {
    const root = await mkdtemp(join(tmpdir(), "flywheel-git-ai-repo-"))
    const outside = await mkdtemp(join(tmpdir(), "flywheel-git-ai-outside-"))
    let launches = 0
    try {
      await writeFile(join(outside, "secret.ts"), "secret")
      await symlink(outside, join(root, "linked"))
      const service = createGitAiAttributionService({
        canonicalRepositoryRoot: root,
        runOwnedCommand: async () => { launches += 1; return ok },
        resolveExecutable: () => "git-ai",
      })
      const identity = service.registerRequest(request())!

      service.direct({ identity, files: [{ path: join(root, "linked", "secret.ts"), beforeContent: "secret", afterContent: "changed" }] })
      await service.dispose()

      expect(launches).toBe(0)
    } finally {
      await Promise.all([rm(root, { recursive: true, force: true }), rm(outside, { recursive: true, force: true })])
    }
  })
})
