import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { accountServeRecordPath, accountServeSocketPath, accountServeStartLockPath, accountServeTokenPath } from "../../../src/infra/paths.js"
import { encodeAccountAttach } from "../../../src/protocol/account-attach.js"
import { createSocketRuntimeClient } from "../../../src/orchestration/app-service/socket-runtime-client.js"
import { createAccountProjectRegistry } from "../../../src/orchestration/app-service/account-project-registry.js"
import { seedConfigDefaults } from "../../../src/orchestration/config/writer.js"
import { median, type MetricValues } from "../lib/metrics.js"
import { readDebugLogRecords, type DebugLogRecord } from "../lib/debug-log-reader.js"
import { settledSample } from "../lib/process-table.js"
import type { ScenarioContext, ScenarioResult } from "./scenario-context.js"

const READY_TIMEOUT_MS = 60_000

interface RegisteredProject {
  readonly id: string
  readonly projectRoot: string
}

type HeldProjectClient = Pick<ReturnType<typeof createSocketRuntimeClient>, "query" | "close">

function delay(ms: number): Promise<void> {
  return Bun.sleep(ms)
}

async function waitFor<T>(label: string, read: () => T | undefined, timeoutMs = READY_TIMEOUT_MS): Promise<T> {
  const deadline = performance.now() + timeoutMs
  while (performance.now() < deadline) {
    const value = read()
    if (value !== undefined) return value
    await delay(50)
  }
  throw new Error(`${label} did not settle within ${timeoutMs}ms`)
}

function readServePid(userDataRoot: string): number | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(accountServeRecordPath(userDataRoot, "installed"), "utf8"))
    return typeof parsed === "object" && parsed !== null && "pid" in parsed && typeof parsed.pid === "number"
      ? parsed.pid
      : undefined
  } catch {
    return undefined
  }
}

function projectEvents(records: readonly DebugLogRecord[], type: string, projectRoot: string): DebugLogRecord[] {
  return records.filter((record) => record.type === type && record.payload?.projectRoot === projectRoot)
}

async function waitForReady(diagnosticRoot: string, projectRoot: string): Promise<number> {
  return await waitFor(`project ready diagnostic for ${projectRoot}`, () => {
    const records = readDebugLogRecords(diagnosticRoot)
    const accepted = projectEvents(records, "account.project.open.accepted", projectRoot).at(-1)
    const ready = projectEvents(records, "account.project.open.ready", projectRoot).at(-1)
    if (!accepted || !ready || ready.ts < accepted.ts) return undefined
    return ready.ts - accepted.ts
  })
}

async function wakeProject(diagnosticRoot: string, project: RegisteredProject, cookie: string, hubOrigin: string): Promise<number> {
  const response = await fetch(`${hubOrigin}/projects/${project.id}/open`, {
    method: "POST",
    redirect: "manual",
    headers: { Origin: hubOrigin, Cookie: cookie },
  })
  if (response.status !== 303) throw new Error(`wake for ${project.projectRoot} returned ${response.status}`)
  return await waitForReady(diagnosticRoot, project.projectRoot)
}

async function holdProject(userDataRoot: string, projectRoot: string): Promise<HeldProjectClient> {
  const credential = readFileSync(accountServeTokenPath(userDataRoot, "installed"), "utf8").trim()
  const client = createSocketRuntimeClient({
    socketPath: accountServeSocketPath(userDataRoot, "installed"),
    ensureRuntime: async () => {},
    connectionPreface: () => new TextEncoder().encode(encodeAccountAttach({ projectRoot, credential, intent: "runtime" })),
  })
  try {
    await client.query({ type: "workflowViewSnapshot", workflowId: "release-empty-history" })
    return client
  } catch (error) {
    await client.close()
    throw error
  }
}

async function stopServe(child: Bun.Subprocess, userDataRoot: string): Promise<void> {
  if (child.exitCode === null) child.kill("SIGTERM")
  const exited = await Promise.race([
    child.exited.then(() => true),
    delay(10_000).then(() => false),
  ])
  if (!exited && child.exitCode === null) {
    child.kill("SIGKILL")
    await child.exited
  }
  // Windows has no signal that runs the service's graceful path: the kill
  // above terminates it, so it never withdraws its rendezvous. What a gone
  // service left is cleared here, as `flywheel kill` and the next start do.
  if (process.platform === "win32") {
    for (const file of [accountServeRecordPath(userDataRoot, "installed"), accountServeStartLockPath(userDataRoot, "installed")]) rmSync(file, { force: true })
  }
  await waitFor("serve identity removal", () => existsSync(accountServeRecordPath(userDataRoot, "installed")) ? undefined : true, 10_000)
}

/** Measures the candidate account service only. Published baselines predate this placement. */
export async function runAccountServiceScenario(context: ScenarioContext): Promise<ScenarioResult> {
  const failures: string[] = []
  const metrics: MetricValues = {}
  const accountHome = context.workDir
  const userDataRoot = join(accountHome, ".flywheel")
  const projectsRoot = join(context.workDir, "projects")
  mkdirSync(userDataRoot, { recursive: true })
  mkdirSync(projectsRoot, { recursive: true })
  const roots = ["warmup", "measured-1", "measured-2", "measured-3"].map((name) => {
    const root = join(projectsRoot, name)
    mkdirSync(join(root, ".git"), { recursive: true })
    return root
  })
  const seeded = seedConfigDefaults({ userDataRoot })
  if (!seeded.ok) return { metrics, failures: [`account service config seed failed: ${seeded.error.message}`] }

  const registry = createAccountProjectRegistry({ userDataRoot })
  const projects: RegisteredProject[] = []
  try {
    for (const projectRoot of roots) {
      const project = await registry.record({ projectRoot, label: projectRoot.split("/").at(-1) ?? projectRoot })
      projects.push({ id: project.id, projectRoot: project.projectRoot })
    }
  } finally {
    await registry.dispose()
  }

  const stdoutPath = join(context.evidenceDir, "serve.stdout.log")
  const stderrPath = join(context.evidenceDir, "serve.stderr.log")
  const hubRecordPath = join(context.workDir, "hub-origin")
  const child = Bun.spawn([
    context.binaryPath,
    "serve",
  ], {
    cwd: roots[0],
    env: {
      ...process.env,
      ...context.environment,
      HOME: accountHome,
      FLYWHEEL_PROJECT_ROOT: roots[0],
      FLYWHEEL_DISABLE_AUTOUPDATE: "1",
      FLYWHEEL_LOG_LEVEL: "DEBUG",
      FLYWHEEL_INTERNAL_RELEASE_HARNESS: "account-service-isolation-v1",
      FLYWHEEL_INTERNAL_RELEASE_HUB_PORT: "0",
      FLYWHEEL_INTERNAL_RELEASE_HUB_RECORD: hubRecordPath,
      // The scenario measures the resident service with no project open,
      // which an isolated home's service would not stay up for.
      FLYWHEEL_INTERNAL_RESIDENT_SERVICE: "1",
    },
    stdout: Bun.file(stdoutPath),
    stderr: Bun.file(stderrPath),
    windowsHide: true,
  })
  const heldClients: HeldProjectClient[] = []

  try {
    const pid = await waitFor("serve identity", () => {
      if (child.exitCode !== null) throw new Error(`serve exited with code ${child.exitCode}: ${readFileSync(stderrPath, "utf8")}`)
      return readServePid(userDataRoot)
    })
    const { timeline } = context
    const hubOrigin = await timeline.time("hub-ready", () => waitFor("isolated account hub", () => {
      if (!existsSync(hubRecordPath)) return undefined
      const origin = readFileSync(hubRecordPath, "utf8").trim()
      return origin.length > 0 ? origin : undefined
    }))

    const zero = await timeline.time("idle-zero", () => settledSample(pid))
    metrics["accountService.zeroProjectRssMb"] = zero.rssMb
    writeFileSync(join(context.evidenceDir, "processes-zero-project.txt"), zero.evidence)
    const beforeOpen = readDebugLogRecords(context.workDir)
    if (beforeOpen.some((record) => record.type === "runtime.process_resources.acquired")) {
      failures.push("account service acquired project process resources before the first open")
    }
    if (beforeOpen.some((record) => record.type === "runtime.worker.allocated")) {
      failures.push("account service allocated project Workers before the first open")
    }

    const page = await fetch(`${hubOrigin}/`, { redirect: "manual" })
    const cookie = page.headers.get("set-cookie")?.split(";", 1)[0]
    if (page.status !== 200 || !cookie) throw new Error(`fixed page did not issue its mutation cookie (${page.status})`)
    const project = (index: number): RegisteredProject => {
      const value = projects[index]
      if (!value) throw new Error(`account service fixture has no project at index ${index}`)
      return value
    }

    await timeline.time("open-0", () => wakeProject(context.workDir, project(0), cookie, hubOrigin))
    heldClients.push(await timeline.time("hold-0", () => holdProject(userDataRoot, project(0).projectRoot)))
    const one = await timeline.time("idle-one", () => settledSample(pid))
    metrics["accountService.oneProjectRssMb"] = one.rssMb
    writeFileSync(join(context.evidenceDir, "processes-one-project.txt"), one.evidence)

    const openDurations = [await timeline.time("open-1", () => wakeProject(context.workDir, project(1), cookie, hubOrigin))]
    heldClients.push(await timeline.time("hold-1", () => holdProject(userDataRoot, project(1).projectRoot)))
    const two = await timeline.time("idle-two", () => settledSample(pid))
    metrics["accountService.twoProjectRssMb"] = two.rssMb
    metrics["accountService.secondProjectIncrementalRssMb"] = two.rssMb - one.rssMb
    writeFileSync(join(context.evidenceDir, "processes-two-projects.txt"), two.evidence)

    openDurations.push(await timeline.time("open-2", () => wakeProject(context.workDir, project(2), cookie, hubOrigin)))
    openDurations.push(await timeline.time("open-3", () => wakeProject(context.workDir, project(3), cookie, hubOrigin)))
    const [open1Ms, open2Ms, open3Ms] = openDurations
    if (open1Ms === undefined || open2Ms === undefined || open3Ms === undefined) throw new Error("account service did not record three warm opens")
    metrics["accountService.open1Ms"] = open1Ms
    metrics["accountService.open2Ms"] = open2Ms
    metrics["accountService.open3Ms"] = open3Ms
    metrics["accountService.warmOpenMedianMs"] = median(openDurations)

    // ARCH-RUNTIME-010, ARCH-RUNTIME-044: the account constructs no providers, and it owns every open
    // project's startup maintenance: one serialized one-shot Worker per open
    // project, so the jobs of the latest opens may still wait their turn here.
    // Each project's executor runs no maintenance and acquires providers
    // lazily, never more than once, writing those records to that project's log.
    const accountRecords = readDebugLogRecords(context.workDir)
    const accountGenerations = accountRecords.filter((record) => record.type === "runtime.process_resources.acquired").length
    metrics["accountService.processResourceGenerations"] = accountGenerations
    if (accountGenerations !== 0) failures.push(`account service created ${accountGenerations} process-resource generations; the executor owns them`)
    const accountMaintenance = accountRecords
      .filter((record) => record.type === "runtime.worker.allocated" && record.payload?.kind === "maintenance").length
    if (accountMaintenance < 1 || accountMaintenance > projects.length) {
      failures.push(`account service allocated ${accountMaintenance} maintenance Workers for ${projects.length} open projects; expected between 1 and one per open project`)
    }
    // Background work on the second project only: two transcript searches,
    // which only that executor's background Worker answers. They run after
    // the samples, so the RSS metrics above measure no history Worker.
    const searcher = heldClients[1]
    if (!searcher) throw new Error("account service holds no client for the second project")
    await timeline.time("background-searches", async () => {
      for (const query of ["release", "history"]) await searcher.query({ type: "transcriptSearch", request: { query, page: 1 } })
    })

    await timeline.time("close-held", async () => { for (const client of heldClients.splice(0)) await client.close() })
    await timeline.time("projects-closed", () => waitFor("held projects to return to zero", () => {
      const records = readDebugLogRecords(context.workDir)
      return [project(0), project(1)].every((value) =>
        projectEvents(records, "runtime.account_project.lifecycle", value.projectRoot)
          .some((record) => record.payload?.state === "closed")) ? true : undefined
    }))

    // ARCH-RUNTIME-011: an executor starts its background Worker lazily, when its
    // first background read runs, and reuses that one Worker for every later
    // read. These records cover each executor's whole life, its close
    // included. The first project ran no background read, so its executor
    // must allocate no background Worker, not even to answer its close. The
    // second ran two searches, so its executor must allocate exactly one.
    for (const [value, searched] of [[project(0), false], [project(1), true]] as const) {
      const executorRecords = readDebugLogRecords(value.projectRoot)
      const generations = executorRecords.filter((record) => record.type === "runtime.process_resources.acquired").length
      if (generations > 1) failures.push(`executor for ${value.projectRoot} created ${generations} process-resource generations; expected at most one`)
      const workers = (kind: string): number => executorRecords
        .filter((record) => record.type === "runtime.worker.allocated" && record.payload?.kind === kind).length
      const backgroundReads = executorRecords.filter((record) => record.type === "log.debug" && record.payload?.service === "runtime.background"
        && typeof record.payload.message === "string" && record.payload.message.endsWith(" start")).length
      if (searched) {
        if (backgroundReads < 2) failures.push(`executor for ${value.projectRoot} ran ${backgroundReads} background reads; expected the two transcript searches`)
        if (workers("background") !== 1) failures.push(`executor for ${value.projectRoot} allocated ${workers("background")} background Workers for ${backgroundReads} background reads; expected exactly one reusable Worker`)
      } else {
        if (backgroundReads !== 0) failures.push(`executor for ${value.projectRoot} ran ${backgroundReads} background reads with no client asking for history; expected none`)
        if (workers("background") !== 0) failures.push(`executor for ${value.projectRoot} allocated ${workers("background")} background Workers with no client asking for history; expected none`)
      }
      if (workers("maintenance") !== 0) failures.push(`executor for ${value.projectRoot} allocated ${workers("maintenance")} maintenance Workers; the account service owns maintenance`)
    }
    await timeline.time("reopen-0", () => wakeProject(context.workDir, project(0), cookie, hubOrigin))
    heldClients.push(await timeline.time("rehold-0", () => holdProject(userDataRoot, project(0).projectRoot)))
  } catch (error) {
    failures.push(`account service: ${String(error)}`)
  } finally {
    for (const client of heldClients.splice(0)) await client.close()
    try {
      await context.timeline.time("stop-serve", () => stopServe(child, userDataRoot))
    } catch (error) {
      failures.push(`account service cleanup: ${String(error)}`)
    }
  }

  return { metrics, failures }
}
