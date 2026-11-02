/** Shared contract between the runner and the scenarios. */

export interface ScenarioContext {
  /** Whether the suite is driving the current candidate or an older published baseline. */
  measurementRole: "candidate" | "baseline"
  /** Absolute path of the installed flywheel binary or wrapper under test. */
  binaryPath: string
  /** Prepared workspace: the pane's cwd, the binary's HOME, and the project root. */
  workDir: string
  /** Directory that receives this run's evidence (stderr, pane captures). */
  evidenceDir: string
  /** Socket of the suite's private tmux server, in the work directory. */
  tmuxServer: string
  /** Unique tmux session name for this run. */
  sessionName: string
  /** Test-only variables owned by the release runner and inherited by candidate processes. */
  environment: { readonly [name: string]: string }
  /** Wall-clock accounting scoped to this run; scenarios time their steps through it. */
  timeline: Timeline
}

export interface ScenarioResult {
  metrics: MetricValues
  /** Human-readable integrity failures; any entry fails the gate. */
  failures: string[]
}

import type { MetricValues } from "../lib/metrics.js"
import { median } from "../lib/metrics.js"
import type { ReleaseMemoryEvidence } from "../../../src/infra/startup-trace.js"
import type { Timeline } from "../lib/timeline.js"
import { sleep, type TmuxApp } from "../../../scripts/uat/tmux-driver.js"

export interface RetainedHeapSample {
  readonly pid: number
  readonly gcStartedAtMs: number
  readonly timestampMs: number
  readonly heapUsed: number
  readonly rss: number
}

/** Reads the single retained-heap observation, never the uncollected timer samples. */
export function selectRetainedHeap(sample: RetainedHeapSample, plateau: {
  readonly pid: number
  readonly startedAt: number
  readonly endedAt: number
}) {
  if (sample.pid !== plateau.pid || !Object.values(sample).every(Number.isFinite)) throw new Error("retained heap has no finite matching executor sample")
  if (sample.gcStartedAtMs < plateau.startedAt || sample.timestampMs > plateau.endedAt || sample.timestampMs < sample.gcStartedAtMs) {
    throw new Error("retained heap GC and observation must be inside the active plateau")
  }
  return { heapMb: sample.heapUsed / 1024 ** 2, count: 1, midpointOffsetMs: sample.gcStartedAtMs - (plateau.startedAt + plateau.endedAt) / 2 }
}

/** Selects only the verified executor's plateau. Missing or replaced owners invalidate the observation, not the workload. */
export function selectExecutorPlateau(records: readonly ReleaseMemoryEvidence[], plateau: {
  readonly runId: string
  readonly pid: number
  readonly startedAt: number
  readonly endedAt: number
}) {
  const owners = records.filter((record) => record.runId === plateau.runId && record.role === "project-executor")
  const overlapping = owners.filter((owner) => owner.samples.some((sample) => sample.timestampMs >= plateau.startedAt && sample.timestampMs <= plateau.endedAt))
  if (overlapping.length !== 1 || overlapping[0]?.pid !== plateau.pid) throw new Error("active plateau has no unique matching executor")
  const samples = overlapping[0].samples.filter((sample) => sample.timestampMs >= plateau.startedAt && sample.timestampMs <= plateau.endedAt)
  if (samples.some((sample) => !Number.isFinite(sample.timestampMs) || !Number.isFinite(sample.heapUsed) || !Number.isFinite(sample.rss))) {
    throw new Error("active plateau has nonfinite memory observations")
  }
  return {
    rssMb: median(samples.map((sample) => sample.rss)) / 1024 / 1024,
    count: samples.length, firstTimestampMs: samples[0]!.timestampMs, lastTimestampMs: samples.at(-1)!.timestampMs,
  }
}

/** The prompt-bar text that appears only when a chat session is foreground and
 *  idle; the flywheel-uat skill and the e2e harness both treat it as the ready
 *  signal (tests/e2e/lib/e2e-framework.sh wait_for_chat). */
export const READY_MARKER = "for fresh chat"

/** The welcome card's title once the runtime identity is known: `>_ Flywheel (v0.0.10)`. */
export const INTRO_TITLE_MARKER = "Flywheel (v"

export const READY_TIMEOUT_MS = 45_000

function deferredStartupModalOpen(pane: string, role: ScenarioContext["measurementRole"]): boolean {
  if (role === "baseline"
    && pane.includes("Settings › Auth")
    && pane.includes("enter connect")
    && pane.includes("← back  esc close")) return true
  return pane.includes("Usage")
}

/** Dismiss Usage recovery and the baseline's ordinary Auth list, then wait for the existing quiet window. Never answer paid-use questions. */
export async function dismissFirstRunModals(app: Pick<TmuxApp, "capture" | "sendKeys">, role: ScenarioContext["measurementRole"]): Promise<void> {
  let closedStreak = 0
  for (let tick = 0; tick < 20; tick++) {
    const pane = app.capture()
    if (deferredStartupModalOpen(pane, role)) {
      closedStreak = 0
      app.sendKeys("Escape")
    } else {
      closedStreak++
      if (closedStreak >= 4) return
    }
    await sleep(500)
  }
  throw new Error(`deferred startup modal kept reopening; last pane:\n${app.capture()}`)
}

/** Submit one visible draft despite deferred startup recovery. The draft
 *  itself is the authority: disappearance proves chat accepted Enter. */
export async function submitDraftAfterDeferredModals(app: Pick<TmuxApp, "capture" | "sendKeys">, draft: string, role: ScenarioContext["measurementRole"]): Promise<void> {
  const marker = `> ${draft}`
  let sawDraft = false
  for (let tick = 0; tick < 300; tick++) {
    const pane = app.capture()
    if (!pane.includes(marker)) {
      if (sawDraft) return
    } else {
      sawDraft = true
      app.sendKeys(deferredStartupModalOpen(pane, role) ? "Escape" : "Enter")
    }
    await sleep(50)
  }
  throw new Error(`chat did not accept the draft; last pane:\n${app.capture()}`)
}
