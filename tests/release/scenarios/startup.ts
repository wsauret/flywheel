/**
 * S1/S2: startup latency. The pane poll proves the binary reached the
 * interactive prompt with the welcome card on screen; the metrics come from
 * the binary's own boot trace, so launch and polling overhead on the driver
 * side never contaminates them. The runner decides whether the workspace is
 * empty (S1) or the generated large store (S2).
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { firstFrameMs, newChatReadyMs, phaseElapsedMs, readBootPhases, SESSION_LIST_READY_PHASE, sessionListReadyMs } from "../lib/boot-trace.js"
import type { MetricValues } from "../lib/metrics.js"
import { launchApp } from "../../../scripts/uat/tmux-driver.js"
import { INTRO_TITLE_MARKER, READY_MARKER, READY_TIMEOUT_MS, type ScenarioContext, type ScenarioResult } from "./scenario-context.js"

const BASELINE_SESSION_LIST_OBSERVATION_MS = 4_000

async function waitForSessionListPhase(stderrFile: string, timeoutMs: number): Promise<void> {
  const deadline = performance.now() + timeoutMs
  while (performance.now() < deadline) {
    if (phaseElapsedMs(readBootPhases(stderrFile), SESSION_LIST_READY_PHASE) !== undefined) return
    await Bun.sleep(50)
  }
}

export async function runStartupScenario(context: ScenarioContext, metricPrefix: string, observationTimeoutMs?: number): Promise<ScenarioResult> {
  const stderrFile = join(context.evidenceDir, "stderr.log")
  const app = launchApp({
    server: context.tmuxServer,
    sessionName: context.sessionName,
    binaryPath: context.binaryPath,
    workDir: context.workDir,
    stderrFile,
    env: { ...context.environment },
  })
  const failures: string[] = []
  const metrics: MetricValues = {}
  try {
    try {
      const ready = await context.timeline.time("ready", () => app.pollPane(
        "ready prompt and welcome card",
        (pane) => {
          if (observationTimeoutMs !== undefined && existsSync(stderrFile) && readFileSync(stderrFile, "utf8").includes("runtime event lane silent past deadline")) throw new Error("runtime event lane failed before chat readiness")
          return pane.includes(READY_MARKER) && pane.includes(INTRO_TITLE_MARKER)
        },
        observationTimeoutMs ?? READY_TIMEOUT_MS,
        50,
      ))
      writeFileSync(join(context.evidenceDir, "ready-pane.log"), ready.capture)
    } catch (error) {
      failures.push(`${metricPrefix}: ${String(error)}`)
    }
    if (metricPrefix === "startup.large") {
      const observationMs = observationTimeoutMs ?? (context.measurementRole === "candidate" ? READY_TIMEOUT_MS : BASELINE_SESSION_LIST_OBSERVATION_MS)
      await context.timeline.time("session-list", () => waitForSessionListPhase(stderrFile, observationMs))
    }
  } finally {
    await context.timeline.time("dispose", () => app.dispose())
  }
  const phases = readBootPhases(stderrFile)
  const firstFrame = firstFrameMs(phases, context.measurementRole)
  const ready = newChatReadyMs(phases, context.measurementRole)
  if (firstFrame.kind === "missing") failures.push(`${metricPrefix}: boot trace has no "${firstFrame.phase}" phase`)
  else metrics[`${metricPrefix}.firstFrameMs`] = firstFrame.elapsedMs
  if (ready.kind === "missing") failures.push(`${metricPrefix}: boot trace has no "${ready.phase}" phase`)
  else metrics[`${metricPrefix}.readyMs`] = ready.elapsedMs
  if (metricPrefix === "startup.large") {
    const sessionList = sessionListReadyMs(phases, context.measurementRole)
    if (sessionList.kind === "missing") failures.push(`${metricPrefix}: boot trace has no "${sessionList.phase}" phase`)
    else if (sessionList.kind === "ready") metrics[`${metricPrefix}.sessionListMs`] = sessionList.elapsedMs
  }
  return { metrics, failures }
}
