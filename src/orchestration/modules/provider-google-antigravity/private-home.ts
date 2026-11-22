import { Redacted } from "effect"
import { existsSync, mkdirSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { antigravityHomeLayout } from "../../../infra/antigravity-engine.js"
import { writeFileAtomic } from "../../../infra/atomic-write.js"
import type { OwnedCommandRunner } from "../../../infra/owned-command.js"
import type { GateHookHandler } from "./hook-command.js"

// A login directory holds two kinds of engine files (plan P15). The
// login-stable files below have bytes that depend on no chat tree and no
// process, because every engine on the login re-reads the agent and the hooks
// for each new session: a write for one process would change the sessions of
// every other one. The MCP configuration is read at launch only, so it is the
// one per-launch file, which the launching owner writes under the login's
// launch lock.

/** The custom engine agent that every engine of Flywheel runs (`--agent`). */
const AGENT_NAME = "flywheel"
/** The name of Flywheel's MCP server, which prefixes each tool name the model sees. */
const MCP_SERVER_NAME = "runtime"
const HOOK_NAME = "flywheel"

// The agent replaces every default component of the engine with nothing but
// Flywheel's tools, which reach it through the login's MCP configuration
// (`inheritMcp`: a server the agent declares itself starts after the first
// model call). The body is fixed and neutral: each session's whole system
// prompt follows it in the session's append (decision D1), because siblings of
// one tree have different prompts and all read this one file.
const AGENT_TEXT = `---
name: ${AGENT_NAME}
description: Flywheel's agent.
mainAgent: true
excludeDefaultComponents: true
inheritMcp: true
---
The instructions for this session follow.
`

// The engine never spends the person's paid credits once the plan's quota runs
// out (plan P10), the counterpart of the Claude route's included-use-only rule.
const SETTINGS_TEXT = `${JSON.stringify({ useG1Credits: false }, null, 2)}\n`

/** The files and folders of the login directory `loginDir` that Flywheel owns. */
function loginPaths(loginDir: string) {
  const { home, geminiHome, temporary } = antigravityHomeLayout(loginDir)
  const config = join(geminiHome, "config")
  return {
    home,
    temporary,
    settings: join(geminiHome, "antigravity-cli", "settings.json"),
    agent: join(config, "agents", AGENT_NAME, "agent.md"),
    hooks: join(config, "hooks.json"),
    mcpConfig: join(config, "mcp_config.json"),
    workspace: join(loginDir, "workspace"),
    logs: join(loginDir, "logs"),
  }
}

/**
 * Makes the login-stable files of the login directory `loginDir`, which must be absolute: the engine settings, the
 * Flywheel agent, the PreInvocation hook that asks the login's step gate before each model step (`gateHook`, from
 * `gateHookHandler` for the login's gate address and gate id, which do not change across service restarts), and an
 * empty Git workspace, which `git init` through `run` makes so the engine's upward search for customizations stops
 * there. `git init` runs in the workspace with no `GIT_*` variable of this process, which could move the repository it
 * makes elsewhere, such as `GIT_DIR`. Folders are made private (0700) and files are written atomically and private (0600), each only when its
 * bytes differ, so preparing an unchanged login writes nothing. Rejects when a write or `git init` fails.
 */
export async function prepareLoginHome(loginDir: string, options: { readonly gateHook: GateHookHandler; readonly run: OwnedCommandRunner }): Promise<void> {
  const paths = loginPaths(loginDir)
  for (const folder of [paths.home, paths.temporary, paths.workspace, paths.logs]) mkdirSync(folder, { recursive: true, mode: 0o700 })
  const hooks = `${JSON.stringify({ [HOOK_NAME]: { PreInvocation: [options.gateHook] } }, null, 2)}\n`
  for (const [path, text] of [[paths.settings, SETTINGS_TEXT], [paths.agent, AGENT_TEXT], [paths.hooks, hooks]] as const) writePrivateWhenChanged(path, text)
  if (existsSync(join(paths.workspace, ".git"))) return
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.toUpperCase().startsWith("GIT_")))
  const result = await options.run(["git", "init", "--quiet", paths.workspace], { cwd: paths.workspace, env })
  if (result.exitCode !== 0) throw new Error(`git init of the Antigravity workspace ${paths.workspace} exited with code ${String(result.exitCode)}`)
  if (!existsSync(join(paths.workspace, ".git"))) throw new Error(`git init of the Antigravity workspace ${paths.workspace} made no repository there`)
}

/**
 * Writes the MCP configuration of the next engine that launches on the login directory `loginDir`: Flywheel's
 * server at `url`, which only a request with the bearer `token` reaches, with each tool of `toolNames` declared in
 * the first model request (`eager`) and no call deadline (the call waits until Flywheel's dispatch runs the tool).
 * The engine reads this file at launch only, so the caller holds the login's launch lock from this write until the
 * new engine has listed its tools. The file holds the token, so it is private (0600).
 */
export function writeLaunchMcpConfig(loginDir: string, server: { readonly url: string; readonly token: Redacted.Redacted<string>; readonly toolNames: readonly string[] }): void {
  const config = {
    mcpServers: {
      [MCP_SERVER_NAME]: {
        serverUrl: server.url,
        headers: { Authorization: `Bearer ${Redacted.value(server.token)}` },
        timeoutSeconds: -1,
        tools: Object.fromEntries(server.toolNames.map((name) => [name, { eager: true }])),
      },
    },
  }
  writeFileAtomic(loginPaths(loginDir).mcpConfig, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 })
}

/** The arguments and working directory of the ACP engine with the id `processId` on the login directory `loginDir`:
 *  Flywheel's agent, no telemetry, the engine's own log in the login's `logs` folder, which Flywheel reads from
 *  launch, and the login's private workspace, never a project of the person, whose customizations would reach every
 *  session of the engine. */
export function acpLaunch(loginDir: string, processId: string) {
  const paths = loginPaths(loginDir)
  const logFile = join(paths.logs, `${processId}.log`)
  return { args: ["acp", "--agent", AGENT_NAME, "--disable-telemetry", "--log-file", logFile], cwd: paths.workspace, logFile }
}

function writePrivateWhenChanged(path: string, text: string): void {
  if (fileText(path) === text) return
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  writeFileAtomic(path, text, { mode: 0o600 })
}

/** The text of the file at `path`, or nothing when it cannot be read. */
function fileText(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8")
  } catch {
    return undefined
  }
}
