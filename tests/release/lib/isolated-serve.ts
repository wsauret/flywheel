/** One `flywheel serve` that a release scenario starts under its own HOME,
 *  with the account's loopback provider configuration and an ephemeral hub,
 *  so it never collides with the operator's own service on 41000. Scenarios
 *  that measure the runtime through the protocol, not through a terminal,
 *  start it here, open projects through the hub's wake route, and attach the
 *  same socket client a foreground client uses. */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { AuthProfileStore } from "../../../src/infra/auth/auth-profile-store.js"
import type { ServeLane } from "../../../src/infra/cli-subprocess.js"
import { accountServeRecordPath, accountServeSocketPath, accountServeStartLockPath, accountServeTokenPath } from "../../../src/infra/paths.js"
import { createAccountProjectRegistry } from "../../../src/orchestration/app-service/account-project-registry.js"
import { defaultRoleSlots } from "../../../src/orchestration/config/role-selection.js"
import { createSocketRuntimeClient } from "../../../src/orchestration/app-service/socket-runtime-client.js"
import { ROLE_MODEL_DEFAULTS } from "../../../src/orchestration/config/role-model-defaults.js"
import { encodeAccountAttach } from "../../../src/protocol/account-attach.js"
import type { AttachedRuntimeClient } from "../../../src/protocol/app-service-types.js"
import type { ScenarioContext } from "../scenarios/scenario-context.js"

const READY_TIMEOUT_MS = 60_000

export async function waitFor<T>(label: string, read: () => T | undefined, timeoutMs = READY_TIMEOUT_MS, intervalMs = 50): Promise<T> {
  const deadline = performance.now() + timeoutMs
  while (performance.now() < deadline) {
    const value = read()
    if (value !== undefined) return value
    await Bun.sleep(intervalMs)
  }
  throw new Error(`${label} did not settle within ${timeoutMs}ms`)
}

/** Rejects when `work` does not settle within `timeoutMs`, and clears its
 *  own deadline when it does. A raced `Bun.sleep` stays pending after the
 *  race and keeps the release run from exiting for up to the whole timeout. */
export async function withTimeout<T>(label: string, work: Promise<T>, timeoutMs: number): Promise<T> {
  let deadline: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => {
      deadline = setTimeout(() => reject(new Error(`${label} did not happen within ${timeoutMs}ms`)), timeoutMs)
    })])
  } finally {
    clearTimeout(deadline)
  }
}

/** The loopback OpenAI-compatible provider a scenario serves. */
export interface FixtureProvider {
  readonly baseUrl: string
  /** Every model the provider lists. The first serves every role that
   *  `roleModels` does not name. */
  readonly models: readonly [string, ...string[]]
  readonly roleModels?: { readonly [role: string]: string }
  /** The models' context window in tokens, when the provider default is too
   *  small for the conversations the scenario replays. */
  readonly contextLimit?: number
}

/** Writes the account configuration: the fixture provider for every role,
 *  any further sections the scenario needs, and the provider's API key. */
export async function writeAccountConfig(userDataRoot: string, provider: FixtureProvider, sections: readonly string[] = []): Promise<void> {
  const roles = new Set([...defaultRoleSlots().map((slot) => slot.roleId), ...Object.keys(ROLE_MODEL_DEFAULTS)])
  const roleModel = (role: string) => provider.roleModels?.[role] ?? provider.models[0]
  writeFileSync(join(userDataRoot, "flywheel.toml"), [
    "[custom_providers.fixture]",
    `base_url = ${JSON.stringify(provider.baseUrl)}`,
    `models = [${provider.models.map((model) => JSON.stringify(model)).join(", ")}]`,
    ...(provider.contextLimit === undefined ? [] : [`context_limit = ${provider.contextLimit}`]),
    "",
    ...[...roles].flatMap((role) => [`[roles.${JSON.stringify(role)}]`, `model = ${JSON.stringify(roleModel(role))}`, 'effort = "low"', ""]),
    ...sections,
  ].join("\n"))
  const store = new AuthProfileStore(userDataRoot)
  const profile = await store.open("default") ?? await store.create("default")
  try {
    profile.writeFile("auth.json", JSON.stringify({ fixture: { type: "api_key", key: "load-fixture-key" } }))
  } finally {
    profile.close()
  }
}

export interface RegisteredProject {
  readonly id: string
  readonly projectRoot: string
}

/** Records the project in the account registry so the hub can wake it. */
export async function registerProject(userDataRoot: string, projectRoot: string, label: string): Promise<RegisteredProject> {
  const registry = createAccountProjectRegistry({ userDataRoot })
  try {
    return { id: (await registry.record({ projectRoot, label })).id, projectRoot }
  } finally {
    await registry.dispose()
  }
}

export interface IsolatedServe {
  readonly lane: ServeLane
  readonly pid: number
  readonly memoryEvidence: { readonly directory: string; readonly runId: string }
  /** Wakes the project through the hub and attaches a runtime client to it,
   *  once the runtime answers a query. */
  openProject(project: RegisteredProject): Promise<AttachedRuntimeClient>
  /** Stops the serve and waits for its identity record to go. */
  stop(): Promise<void>
}

/** An installed binary serves the installed lane; a source checkout run
 *  through bin/flywheel serves the dev lane. The record that appears says
 *  which one this binary is. */
function serveIdentity(userDataRoot: string): { readonly lane: ServeLane; readonly pid: number } | undefined {
  for (const lane of ["installed", "dev"] as const) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(accountServeRecordPath(userDataRoot, lane), "utf8"))
      if (typeof parsed === "object" && parsed !== null && "pid" in parsed && typeof parsed.pid === "number") return { lane, pid: parsed.pid }
    } catch {
      continue
    }
  }
  return undefined
}

async function wakeProject(projectId: string, projectRoot: string, hubOrigin: string): Promise<void> {
  const page = await fetch(`${hubOrigin}/`, { redirect: "manual" })
  const cookie = page.headers.get("set-cookie")?.split(";", 1)[0]
  if (page.status !== 200 || !cookie) throw new Error(`fixed page did not issue its mutation cookie (${page.status})`)
  const response = await fetch(`${hubOrigin}/projects/${projectId}/open`, { method: "POST", redirect: "manual", headers: { Origin: hubOrigin, Cookie: cookie } })
  if (response.status !== 303) throw new Error(`wake for ${projectRoot} returned ${response.status}`)
}

function attachClient(userDataRoot: string, lane: ServeLane, projectRoot: string): AttachedRuntimeClient {
  const credential = readFileSync(accountServeTokenPath(userDataRoot, lane), "utf8").trim()
  return createSocketRuntimeClient({
    socketPath: accountServeSocketPath(userDataRoot, lane),
    ensureRuntime: async () => {},
    connectionPreface: () => new TextEncoder().encode(encodeAccountAttach({ projectRoot, credential, intent: "runtime" })),
  })
}

async function stopServe(child: Bun.Subprocess, userDataRoot: string, lane: ServeLane): Promise<void> {
  if (child.exitCode === null) child.kill("SIGTERM")
  const exited = await withTimeout("serve exit", child.exited, 10_000).then(() => true, () => false)
  if (!exited && child.exitCode === null) {
    child.kill("SIGKILL")
    await child.exited
  }
  if (process.platform === "win32") {
    for (const file of [accountServeRecordPath(userDataRoot, lane), accountServeStartLockPath(userDataRoot, lane)]) rmSync(file, { force: true })
  }
  await waitFor("serve identity removal", () => existsSync(accountServeRecordPath(userDataRoot, lane)) ? undefined : true, 10_000)
}

/** Starts the serve with HOME at `accountHome` and waits for its hub. Every
 *  stall past 50 ms is DEBUG evidence, so the serve and the executors it
 *  starts log at DEBUG: the default level records only the stalls a person
 *  notices, coalesced, which a fairness measurement cannot sum. */
export async function startIsolatedServe(context: ScenarioContext, options: { readonly accountHome: string; readonly projectRoot: string }): Promise<IsolatedServe> {
  const userDataRoot = join(options.accountHome, ".flywheel")
  const stderrPath = join(context.evidenceDir, "serve.stderr.log")
  const hubRecordPath = join(context.workDir, "hub-origin")
  const memoryEvidence = { directory: join(context.evidenceDir, "memory"), runId: context.sessionName }
  mkdirSync(memoryEvidence.directory, { recursive: true })
  const child = Bun.spawn([context.binaryPath, "serve"], {
    cwd: options.projectRoot,
    env: {
      ...process.env,
      ...context.environment,
      HOME: options.accountHome,
      FLYWHEEL_PROJECT_ROOT: options.projectRoot,
      FLYWHEEL_DISABLE_AUTOUPDATE: "1",
      FLYWHEEL_LOG_LEVEL: "DEBUG",
      FLYWHEEL_INTERNAL_RELEASE_HARNESS: "account-service-isolation-v1",
      FLYWHEEL_INTERNAL_RELEASE_HUB_PORT: "0",
      FLYWHEEL_INTERNAL_RELEASE_HUB_RECORD: hubRecordPath,
      FLYWHEEL_RELEASE_MEMORY_DIRECTORY: memoryEvidence.directory,
      FLYWHEEL_RELEASE_MEMORY_RUN: memoryEvidence.runId,
    },
    stdout: Bun.file(join(context.evidenceDir, "serve.stdout.log")),
    stderr: Bun.file(stderrPath),
    windowsHide: true,
  })
  let lane: ServeLane = "installed"
  try {
    const identity = await waitFor("serve identity", () => {
      if (child.exitCode !== null) throw new Error(`serve exited with code ${child.exitCode}: ${readFileSync(stderrPath, "utf8")}`)
      return serveIdentity(userDataRoot)
    })
    lane = identity.lane
    const hubOrigin = await context.timeline.time("hub-ready", () => waitFor("isolated account hub", () => {
      if (!existsSync(hubRecordPath)) return undefined
      const origin = readFileSync(hubRecordPath, "utf8").trim()
      return origin.length > 0 ? origin : undefined
    }))
    const servedLane = lane
    return {
      lane: servedLane,
      pid: identity.pid,
      memoryEvidence,
      async openProject(project) {
        await context.timeline.time("open-project", () => wakeProject(project.id, project.projectRoot, hubOrigin))
        const client = attachClient(userDataRoot, servedLane, project.projectRoot)
        try {
          await context.timeline.time("runtime-ready", () => client.query({ type: "statusSnapshot", sessionIds: [] }))
        } catch (error) {
          await client.close().catch(() => {})
          throw error
        }
        return client
      },
      stop: () => context.timeline.time("stop-serve", () => stopServe(child, userDataRoot, servedLane)),
    }
  } catch (error) {
    await stopServe(child, userDataRoot, lane)
    throw error
  }
}
