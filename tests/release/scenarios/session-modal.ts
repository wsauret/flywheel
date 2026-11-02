/**
 * S3: session modal populate latency over the generated large store. Pane
 * polling at 20 Hz gives about 50 ms resolution, which is adequate against
 * human-scale budgets. Two moments are measured separately: the modal chrome
 * appearing (the whole UI hitching would delay this) and the fixture rows
 * being visible (rows streaming in slowly would delay only this).
 */
import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { LIGHT_SESSION_NAME_PREFIX } from "../fixtures/generate-store.js"
import type { MetricValues } from "../lib/metrics.js"
import { launchApp, sleep } from "../../../scripts/uat/tmux-driver.js"
import { dismissFirstRunModals, READY_MARKER, READY_TIMEOUT_MS, type ScenarioContext, type ScenarioResult } from "./scenario-context.js"

const MODAL_TIMEOUT_MS = 15_000
const RESULTS_LINE = /\d+ results/

export async function runSessionModalScenario(context: ScenarioContext): Promise<ScenarioResult> {
  const app = launchApp({
    server: context.tmuxServer,
    sessionName: context.sessionName,
    binaryPath: context.binaryPath,
    workDir: context.workDir,
    stderrFile: join(context.evidenceDir, "stderr.log"),
    env: { ...context.environment },
  })
  const failures: string[] = []
  const metrics: MetricValues = {}
  try {
    const { timeline } = context
    await timeline.time("ready", () => app.pollPane("ready prompt", (pane) => pane.includes(READY_MARKER), READY_TIMEOUT_MS, 50))
    await timeline.time("dismiss-modals", () => dismissFirstRunModals(app, context.measurementRole))
    // Let post-boot background warming settle so the measurement is the
    // modal's own cost, not contention with startup work.
    await timeline.time("settle", () => sleep(1500))
    app.sendKeys("C-s")
    const chrome = await timeline.time("modal-chrome", () => app.pollPane("modal chrome", (pane) => pane.includes("Sessions"), MODAL_TIMEOUT_MS, 50))
    metrics["modal.chromeMs"] = chrome.elapsedMs
    const populated = await timeline.time("modal-rows", () => app.pollPane(
      "modal rows",
      (pane) => RESULTS_LINE.test(pane) && pane.includes(LIGHT_SESSION_NAME_PREFIX),
      MODAL_TIMEOUT_MS,
      50,
    ))
    // Elapsed from the same C-s keypress: the rows poll started after the
    // chrome poll returned, so the sum of both polls is the populate latency.
    metrics["modal.populatedMs"] = chrome.elapsedMs + populated.elapsedMs
    writeFileSync(join(context.evidenceDir, "modal-pane.log"), populated.capture)
  } catch (error) {
    failures.push(`modal: ${String(error)}`)
  } finally {
    await context.timeline.time("dispose", () => app.dispose())
  }
  return { metrics, failures }
}
