/**
 * Opens a persisted chat parent whose linked children mix terminal and
 * nonterminal workflows. The scenario measures runner readiness, including child
 * reconciliation and transcript construction, without starting a model turn.
 */
import { cpSync, existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import {
  RECONCILIATION_PARENT_MARKER,
  RECONCILIATION_PARENT_NAME,
} from "../fixtures/generate-store.js"
import { accountServeRecordPath, accountServeSocketPath, accountServeTokenPath } from "../../../src/infra/paths.js"
import { createSocketRuntimeClient } from "../../../src/orchestration/app-service/socket-runtime-client.js"
import { encodeAccountAttach } from "../../../src/protocol/account-attach.js"
import type { RuntimeClient } from "../../../src/protocol/app-service-types.js"
import { readDebugLogRecords, type DebugLogRecord } from "../lib/debug-log-reader.js"
import { runRevisionDriver } from "../lib/revision-driver.js"
import { writeAccountConfig } from "../lib/isolated-serve.js"
import { startWorkflowLoadProvider, WORKFLOW_LOAD_MODEL } from "./workflow-load-provider.js"
import type { MetricValues } from "../lib/metrics.js"
import { launchApp, sleep } from "../../../scripts/uat/tmux-driver.js"
import { dismissFirstRunModals, READY_MARKER, READY_TIMEOUT_MS, type ScenarioContext, type ScenarioResult } from "./scenario-context.js"

const OPEN_TIMEOUT_MS = 45_000
const PARENT_SESSION_ID = "fixture-reconciliation-parent"

export async function runChatRunnerReconciliationScenario(context: ScenarioContext): Promise<ScenarioResult> {
  if (context.measurementRole === "baseline") return runRevisionDriver(context, "runner-reconciliation", true)
  const provider = startWorkflowLoadProvider()
  try {
    await writeAccountConfig(join(context.workDir, ".flywheel"), { baseUrl: provider.baseUrl, models: [WORKFLOW_LOAD_MODEL] })
    return await measureRunnerReconciliation(context)
  } finally { provider.settle(); await provider.stop() }
}

async function measureRunnerReconciliation(context: ScenarioContext): Promise<ScenarioResult> {
  const app = launchApp({
    server: context.tmuxServer,
    sessionName: context.sessionName,
    binaryPath: context.binaryPath,
    workDir: context.workDir,
    stderrFile: join(context.evidenceDir, "stderr.log"),
    env: { ...context.environment, FLYWHEEL_LOG_LEVEL: "DEBUG" },
  })
  const failures: string[] = []
  const metrics: MetricValues = {}
  const { timeline } = context
  let client: RuntimeClient | undefined
  try {
    await timeline.time("ready", () => app.pollPane("ready prompt", (pane) => pane.includes(READY_MARKER), READY_TIMEOUT_MS, 50))
    await timeline.time("dismiss-modals", () => dismissFirstRunModals(app, context.measurementRole))
    await timeline.time("settle", () => sleep(1500))
    const userDataRoot = join(context.workDir, ".flywheel")
    const lane = (["installed", "dev"] as const).find((candidate) => existsSync(accountServeRecordPath(userDataRoot, candidate)))
    if (!lane) throw new Error("the app has no account service record")
    const credential = readFileSync(accountServeTokenPath(userDataRoot, lane), "utf8").trim()
    client = createSocketRuntimeClient({
      socketPath: accountServeSocketPath(userDataRoot, lane),
      ensureRuntime: async () => {},
      connectionPreface: () => new TextEncoder().encode(encodeAccountAttach({ projectRoot: context.workDir, credential, intent: "runtime" })),
    })
    const runtimeClient = client
    await runtimeClient.query({ type: "statusSnapshot", sessionIds: [PARENT_SESSION_ID] })
    app.sendKeys("C-s")
    await timeline.time("modal-rows", () => app.pollPane("modal rows", (pane) => /\d+ results/.test(pane), 15_000, 50))
    app.sendKeys("-l", RECONCILIATION_PARENT_NAME)
    await timeline.time("filter-parent", () => app.pollPane("reconciliation parent", (pane) => pane.includes(RECONCILIATION_PARENT_NAME), 15_000, 50))
    const openStarted = performance.now()
    app.sendKeys("Enter")
    await timeline.time("runner-ready", () => waitForRunnerReady(runtimeClient))
    await timeline.time("open-parent", () => app.pollPane(
      "reconciliation parent opened",
      (capture) => capture.includes(RECONCILIATION_PARENT_MARKER),
      OPEN_TIMEOUT_MS,
      50,
    ))
    const openRecord = await timeline.time("activation-diagnostic", () => waitForActivationRecord(context.workDir))
    metrics["runnerReconciliation.runnerReadyMs"] = performance.now() - openStarted
    const workflowAggregateReads = openRecord.payload?.workflowAggregateReads
    if (context.measurementRole === "candidate" && (typeof workflowAggregateReads !== "number" || !Number.isFinite(workflowAggregateReads))) {
      throw new TypeError("session activated record has no numeric workflowAggregateReads")
    }
    if (typeof workflowAggregateReads === "number" && Number.isFinite(workflowAggregateReads)) {
      metrics["runnerReconciliation.workflowAggregateReads"] = workflowAggregateReads
    }
    writeFileSync(join(context.evidenceDir, "runner-ready-pane.log"), app.capture())
  } catch (error) {
    failures.push(`runner reconciliation: ${String(error)}`)
    writeFileSync(join(context.evidenceDir, "failure-pane.log"), app.capture())
  } finally {
    await client?.close()
    await timeline.time("dispose", () => app.dispose())
  }
  if (failures.length > 0) {
    cpSync(join(context.workDir, ".flywheel", "log"), join(context.evidenceDir, "debug-log"), { recursive: true })
  }
  return { metrics, failures }
}

async function waitForRunnerReady(client: RuntimeClient): Promise<void> {
  const deadline = performance.now() + OPEN_TIMEOUT_MS
  while (performance.now() < deadline) {
    const status = await client.query({ type: "statusSnapshot", sessionIds: [PARENT_SESSION_ID] })
    if (status.views[0]?.view?.activity === "idle") return
    await sleep(50)
  }
  throw new Error(`chat runner did not become ready within ${OPEN_TIMEOUT_MS}ms`)
}

async function waitForActivationRecord(workDir: string): Promise<DebugLogRecord> {
  const deadline = performance.now() + OPEN_TIMEOUT_MS
  while (performance.now() < deadline) {
    const record = readDebugLogRecords(workDir)
      .findLast((entry) => entry.sessionId === PARENT_SESSION_ID && entry.payload?.message === "session activated")
    if (record) return record
    await sleep(50)
  }
  throw new Error(`chat activation diagnostic did not appear within ${OPEN_TIMEOUT_MS}ms`)
}
