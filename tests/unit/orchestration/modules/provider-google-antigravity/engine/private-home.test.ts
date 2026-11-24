import { describe, expect, test } from "bun:test"
import { Redacted } from "effect"
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"

import type { OwnedCommandRunner } from "../../../../../../src/infra/owned-command.js"
import { gateHookHandler } from "../../../../../../src/orchestration/modules/provider-google-antigravity/engine/hook-command.js"
import { acpLaunch, prepareLoginHome, writeLaunchMcpConfig } from "../../../../../../src/orchestration/modules/provider-google-antigravity/engine/private-home.js"
import { temporaryDirectories } from "../../../../../helpers/directories.js"

const temporaryDirectory = temporaryDirectories()
const ENTRY = ["/opt/flywheel/flywheel", "--internal-role=antigravity-gate"]

/** A `git` that makes the repository that `git init` makes, where `GIT_DIR` of its environment names it as real
 *  Git does, and records each call. */
function fakeGit() {
  const calls: (readonly string[])[] = []
  const run: OwnedCommandRunner = async (command, options) => {
    calls.push(command)
    mkdirSync((options?.env ?? process.env).GIT_DIR ?? join(command.at(-1) ?? "", ".git"), { recursive: true })
    return { exitCode: 0, stdout: "", stdoutBytes: new Uint8Array(), stderr: "", timedOut: false }
  }
  return { run, calls }
}

function loginFiles(loginDir: string) {
  const config = join(loginDir, "home", ".gemini", "config")
  return {
    settings: join(loginDir, "home", ".gemini", "antigravity-cli", "settings.json"),
    agent: join(config, "agents", "flywheel", "agent.md"),
    hooks: join(config, "hooks.json"),
    mcpConfig: join(config, "mcp_config.json"),
  }
}

describe("a login's private home", () => {
  test("holds the Flywheel agent, the paid-credit switch, and the gate hook, privately, and the workspace is a Git repository of its own", async () => {
    const loginDir = temporaryDirectory("flywheel-antigravity-login-")
    const git = fakeGit()
    const gateHook = gateHookHandler({ address: "/run/fw-agy-501/gate-login-1", loginGateId: "login-1", entry: ENTRY, platform: "linux" })

    await prepareLoginHome(loginDir, { gateHook, run: git.run })

    const files = loginFiles(loginDir)
    expect(readFileSync(files.agent, "utf8")).toBe("---\nname: flywheel\ndescription: Flywheel's agent.\nmainAgent: true\nexcludeDefaultComponents: true\ninheritMcp: true\n---\nThe instructions for this session follow.\n")
    expect(JSON.parse(readFileSync(files.settings, "utf8"))).toEqual({ useG1Credits: false })
    expect(JSON.parse(readFileSync(files.hooks, "utf8"))).toEqual({ flywheel: { PreInvocation: [gateHook] } })
    expect(git.calls).toEqual([["git", "init", "--quiet", join(loginDir, "workspace")]])
    if (process.platform !== "win32") {
      for (const file of Object.values(files).filter((path) => path !== files.mcpConfig)) expect(statSync(file).mode & 0o777).toBe(0o600)
      for (const folder of ["home", "home/tmp", "workspace", "logs", "home/.gemini/config"]) expect(statSync(join(loginDir, folder)).mode & 0o777).toBe(0o700)
    }
  })

  test("is written once: preparing it again, also for another gate listener of the same login, changes no file", async () => {
    const loginDir = temporaryDirectory("flywheel-antigravity-login-")
    const git = fakeGit()
    // The gate address derives from the login, so each listener of the login
    // after a service restart gives the same handler.
    const handler = () => gateHookHandler({ address: "/run/fw-agy-501/gate-login-1", loginGateId: "login-1", entry: ENTRY, platform: "linux" })
    await prepareLoginHome(loginDir, { gateHook: handler(), run: git.run })
    const files = Object.values(loginFiles(loginDir)).filter((path) => !path.endsWith("mcp_config.json"))
    const before = files.map((file) => ({ bytes: readFileSync(file, "utf8"), mtimeMs: statSync(file).mtimeMs, ino: statSync(file).ino }))

    await prepareLoginHome(loginDir, { gateHook: handler(), run: git.run })

    expect(files.map((file) => ({ bytes: readFileSync(file, "utf8"), mtimeMs: statSync(file).mtimeMs, ino: statSync(file).ino }))).toEqual(before)
    expect(git.calls).toHaveLength(1)
  })

  test("rewrites the gate hook when the gate's command changes", async () => {
    const loginDir = temporaryDirectory("flywheel-antigravity-login-")
    const git = fakeGit()
    await prepareLoginHome(loginDir, { gateHook: gateHookHandler({ address: "/run/a", loginGateId: "login-1", entry: ENTRY, platform: "linux" }), run: git.run })
    const moved = gateHookHandler({ address: "/run/a", loginGateId: "login-1", entry: ["/opt/flywheel-2/flywheel", "--internal-role=antigravity-gate"], platform: "linux" })

    await prepareLoginHome(loginDir, { gateHook: moved, run: git.run })

    expect(JSON.parse(readFileSync(loginFiles(loginDir).hooks, "utf8"))).toEqual({ flywheel: { PreInvocation: [moved] } })
  })

  test("makes the workspace a repository also when this process names another repository in GIT_DIR", async () => {
    const loginDir = temporaryDirectory("flywheel-antigravity-login-")
    const elsewhere = join(temporaryDirectory("flywheel-antigravity-elsewhere-"), "repository")
    const inherited = process.env.GIT_DIR
    process.env.GIT_DIR = elsewhere
    try {
      await prepareLoginHome(loginDir, { gateHook: gateHookHandler({ address: "/run/a", loginGateId: "login-1", entry: ENTRY, platform: "linux" }), run: fakeGit().run })
    } finally {
      if (inherited === undefined) delete process.env.GIT_DIR
      else process.env.GIT_DIR = inherited
    }

    expect(existsSync(join(loginDir, "workspace", ".git"))).toBe(true)
    expect(existsSync(elsewhere)).toBe(false)
  })

  test("fails when git exits without making the workspace a repository", async () => {
    const loginDir = temporaryDirectory("flywheel-antigravity-login-")
    const silent: OwnedCommandRunner = async () => ({ exitCode: 0, stdout: "", stdoutBytes: new Uint8Array(), stderr: "", timedOut: false })

    await expect(prepareLoginHome(loginDir, { gateHook: gateHookHandler({ address: "/run/a", loginGateId: "login-1", entry: ENTRY, platform: "linux" }), run: silent })).rejects.toThrow("made no repository there")
  })

  test("fails when git cannot make the workspace a repository", async () => {
    const loginDir = temporaryDirectory("flywheel-antigravity-login-")
    const failing: OwnedCommandRunner = async () => ({ exitCode: 128, stdout: "", stdoutBytes: new Uint8Array(), stderr: "fatal", timedOut: false })

    await expect(prepareLoginHome(loginDir, { gateHook: gateHookHandler({ address: "/run/a", loginGateId: "login-1", entry: ENTRY, platform: "linux" }), run: failing })).rejects.toThrow("exited with code 128")
  })
})

describe("the MCP configuration of an engine launch", () => {
  test("declares each tool eager on the launch's own path and token, and leaves the login-stable files as they were", async () => {
    const loginDir = temporaryDirectory("flywheel-antigravity-login-")
    await prepareLoginHome(loginDir, { gateHook: gateHookHandler({ address: "/run/a", loginGateId: "login-1", entry: ENTRY, platform: "linux" }), run: fakeGit().run })
    const files = loginFiles(loginDir)
    const stable = [files.settings, files.agent, files.hooks]
    const before = stable.map((file) => readFileSync(file, "utf8"))
    const launches = [
      { url: "http://127.0.0.1:4100/mcp/process-1", token: "token-1", toolNames: ["read", "edit"] },
      { url: "http://127.0.0.1:4100/mcp/process-2", token: "token-2", toolNames: ["read"] },
    ]

    const written = launches.map((launch) => {
      writeLaunchMcpConfig(loginDir, { ...launch, token: Redacted.make(launch.token) })
      return JSON.parse(readFileSync(files.mcpConfig, "utf8"))
    })

    expect(written).toEqual(launches.map(({ url, token, toolNames }) => ({
      mcpServers: { runtime: { serverUrl: url, headers: { Authorization: `Bearer ${token}` }, timeoutSeconds: -1, tools: Object.fromEntries(toolNames.map((name) => [name, { eager: true }])) } },
    })))
    expect(stable.map((file) => readFileSync(file, "utf8"))).toEqual(before)
    if (process.platform !== "win32") expect(statSync(files.mcpConfig).mode & 0o777).toBe(0o600)
  })
})

describe("the ACP launch of an engine", () => {
  test("runs the Flywheel agent without telemetry in the login's workspace, with a log of its own", () => {
    const launch = acpLaunch("/scratch/auth/antigravity/login-1", "process-1")

    expect(launch).toEqual({
      args: ["acp", "--agent", "flywheel", "--disable-telemetry", "--log-file", join("/scratch/auth/antigravity/login-1", "logs", "process-1.log")],
      cwd: join("/scratch/auth/antigravity/login-1", "workspace"),
      logFile: join("/scratch/auth/antigravity/login-1", "logs", "process-1.log"),
    })
  })
})
