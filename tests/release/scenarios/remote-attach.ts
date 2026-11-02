/**
 * The remote first attach (PI-REMOTE-016). A terminal on a laptop opens a
 * project on a paired machine through the relay, and this scenario measures
 * how long that launch takes to its first frame and to an interactive prompt,
 * so the startup rule (absolute ceilings, and no regression above 20 percent)
 * covers it as it covers a local launch.
 *
 * One machine plays both sides. The run's workspace is the machine's HOME:
 * its own terminal opens the project, which starts the machine's account
 * service and keeps the project open. A second HOME below it is the laptop.
 * Between them runs the real relay Worker under workerd on loopback
 * (`relay/worker/test/local-relay.ts`, in a host process of its own), the
 * code `wrangler dev` runs, so the laptop's terminal takes the path it takes
 * through the hosted relay (presence, the sealed device channel, and the
 * runtime protocol over it) with no network and no Cloudflare account. The
 * relay is the candidate's in both variants: it is the environment, not the
 * binary under test.
 *
 * Both sides pair through the commands a person runs: `flywheel remote pair`
 * on the machine and `flywheel remote machines add <link>` on the laptop.
 * Once the laptop lists the project as open, it launches `flywheel --remote`,
 * the driver answers the project picker, and the chat opens. The metrics come
 * from the laptop's boot trace less the time the picker waited for that
 * answer, which is the person's time and not the terminal's. The project is
 * open, so the numbers measure the terminal and the relay path; a wake of an
 * asleep project adds the machine's own project start, which the
 * account-service scenario measures.
 *
 * A published baseline that predates the remote terminal refuses
 * `flywheel remote machines` with its usage text, and reports no metrics: the
 * relative rule then has nothing to compare, and binds from the first
 * published release that has the remote terminal. Any other failure of that
 * probe fails the baseline, and a baseline whose probe succeeds must produce
 * every metric.
 */
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { copyActiveBuild } from "../../helpers/placed-build.js"
import { spawnLocalRelay, type LocalRelayProcess } from "../../../relay/worker/test/local-relay.js"
import { launchApp, type TmuxApp } from "../../../scripts/uat/tmux-driver.js"
import { firstFrameMs, newChatReadyMs, readBootPhases, remoteQuestions } from "../lib/boot-trace.js"
import { withTimeout } from "../lib/isolated-serve.js"
import type { MetricValues } from "../lib/metrics.js"
import { INTRO_TITLE_MARKER, READY_MARKER, READY_TIMEOUT_MS, type ScenarioContext, type ScenarioResult } from "./scenario-context.js"

/** The metrics a candidate run must produce. */
export const REMOTE_ATTACH_METRICS = ["remoteAttach.pickerMs", "remoteAttach.firstFrameMs", "remoteAttach.readyMs"] as const

/** The picker's question once it lists a project to choose. */
const PICKER_QUESTION = "Choose a project [1-"
/** How long pairing and the machine's first offer of the project may take. */
const PAIRING_TIMEOUT_MS = 30_000

export async function runRemoteAttachScenario(context: ScenarioContext): Promise<ScenarioResult> {
  const machineHome = context.workDir
  const projectRoot = join(machineHome, "project")
  const laptopHome = join(machineHome, "laptop")
  mkdirSync(projectRoot, { recursive: true })
  copyActiveBuild(machineHome, laptopHome, context.measurementRole === "baseline")
  const laptop = commandsFor(context, laptopHome, laptopHome)
  const probe = await laptop(["remote", "machines"])
  if (context.measurementRole === "baseline" && predatesRemoteTerminal(probe)) {
    writeFileSync(join(context.evidenceDir, "unavailable.txt"), `this baseline has no remote terminal:\n${probe.stderr}`)
    return { metrics: {}, failures: [] }
  }
  if (probe.exitCode !== 0) {
    return { metrics: {}, failures: [`remoteAttach: \`flywheel remote machines\` exited ${probe.exitCode}: ${probe.stderr.trim()}`] }
  }

  let relay: LocalRelayProcess | undefined
  let machineApp: TmuxApp | undefined
  let laptopApp: TmuxApp | undefined
  let pairing: Bun.Subprocess<"ignore", "pipe", "pipe"> | undefined
  const stderrFile = join(context.evidenceDir, "stderr.log")
  const failures: string[] = []
  try {
    machineApp = launchApp({
      server: context.tmuxServer,
      sessionName: `${context.sessionName}-machine`,
      binaryPath: context.binaryPath,
      workDir: projectRoot,
      home: machineHome,
      projectRoot,
      stderrFile: join(context.evidenceDir, "machine-stderr.log"),
      env: { ...context.environment },
    })
    const machine = machineApp
    await context.timeline.time("machine-ready", () => machine.pollPane("machine ready prompt", (pane) => pane.includes(READY_MARKER), READY_TIMEOUT_MS, 50))
    // The relay runs in a host process that names this run, so a killed suite
    // runner cannot leave workerd running past the gate's sweep.
    relay = await context.timeline.time("relay", () => spawnLocalRelay(context.evidenceDir))
    const relayUrl = relay.url
    pairing = Bun.spawn([context.binaryPath, "remote", "pair", "--relay", relayUrl], {
      cwd: projectRoot, env: cliEnvironment(context, machineHome, projectRoot), stdin: "ignore", stdout: "pipe", stderr: "pipe", windowsHide: true,
    })
    const pairCommand = pairing
    await context.timeline.time("pair", async () => {
      const link = await withTimeout("the pairing link", firstLineWith(pairCommand.stdout, "#p="), PAIRING_TIMEOUT_MS)
      const added = await laptop(["remote", "machines", "add", link])
      if (added.exitCode !== 0) throw new Error(`\`flywheel remote machines add\` exited ${added.exitCode}: ${added.stderr.trim()}`)
      const exitCode = await withTimeout("the pair command's exit", pairCommand.exited, PAIRING_TIMEOUT_MS)
      if (exitCode !== 0) throw new Error(`\`flywheel remote pair\` exited ${exitCode}: ${await new Response(pairCommand.stderr).text()}`)
    })
    await context.timeline.time("offer", () => offered(laptop))

    laptopApp = launchApp({
      server: context.tmuxServer,
      sessionName: context.sessionName,
      binaryPath: context.binaryPath,
      workDir: laptopHome,
      home: laptopHome,
      projectRoot: laptopHome,
      stderrFile,
      env: { ...context.environment },
      args: ["--remote"],
    })
    const terminal = laptopApp
    await context.timeline.time("picker", () => terminal.pollPane("remote project picker", (pane) => pane.includes(PICKER_QUESTION), READY_TIMEOUT_MS, 50))
    terminal.sendKeys("1", "Enter")
    const ready = await context.timeline.time("ready", () => terminal.pollPane("ready prompt and welcome card", (pane) => pane.includes(READY_MARKER) && pane.includes(INTRO_TITLE_MARKER), READY_TIMEOUT_MS, 50))
    writeFileSync(join(context.evidenceDir, "ready-pane.log"), ready.capture)
  } catch (error) {
    failures.push(`remoteAttach: ${String(error)}`)
  } finally {
    await context.timeline.time("dispose", async () => {
      laptopApp?.dispose()
      machineApp?.dispose()
      pairing?.kill()
      await relay?.close()
    })
  }
  if (failures.length > 0) return { metrics: {}, failures }
  return remoteAttachMetrics(readBootPhases(stderrFile), context.measurementRole)
}

/** The launch's own time to the picker, its first frame, and an interactive
 *  prompt, less the time the picker waited for the answer. */
function remoteAttachMetrics(phases: ReturnType<typeof readBootPhases>, role: ScenarioContext["measurementRole"]): ScenarioResult {
  const metrics: MetricValues = {}
  const failures: string[] = []
  const questions = remoteQuestions(phases)
  if (questions.kind === "missing") return { metrics, failures: [`remoteAttach: boot trace has no "${questions.phase}" phase`] }
  metrics["remoteAttach.pickerMs"] = questions.firstShownMs
  const firstFrame = firstFrameMs(phases, role)
  if (firstFrame.kind === "missing") failures.push(`remoteAttach: boot trace has no "${firstFrame.phase}" phase`)
  else metrics["remoteAttach.firstFrameMs"] = firstFrame.elapsedMs - questions.answerWaitMs
  const ready = newChatReadyMs(phases, role)
  if (ready.kind === "missing") failures.push(`remoteAttach: boot trace has no "${ready.phase}" phase`)
  else metrics["remoteAttach.readyMs"] = ready.elapsedMs - questions.answerWaitMs
  return { metrics, failures }
}

/** True only for the usage refusal of a binary whose `flywheel remote`
 *  has no `machines` verb: exit 2 and a usage line that does not name it.
 *  Every other failure of the probe is a failure of the baseline, so the
 *  relative rule cannot stop binding without a report. */
export function predatesRemoteTerminal(probe: CommandResult): boolean {
  if (probe.exitCode !== 2) return false
  const usage = probe.stderr.split("\n").find((line) => line.startsWith("Usage: flywheel remote "))
  return usage !== undefined && !usage.includes("machines")
}

interface CommandResult {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
}

function cliEnvironment(context: ScenarioContext, home: string, projectRoot: string) {
  return { ...process.env, ...context.environment, HOME: home, FLYWHEEL_PROJECT_ROOT: projectRoot, FLYWHEEL_DISABLE_AUTOUPDATE: "1" }
}

/** Runs one `flywheel` command as a person in `home` runs it. */
function commandsFor(context: ScenarioContext, home: string, cwd: string): (args: readonly string[]) => Promise<CommandResult> {
  return async (args) => {
    const child = Bun.spawn([context.binaryPath, ...args], { cwd, env: cliEnvironment(context, home, cwd), stdin: "ignore", stdout: "pipe", stderr: "pipe", windowsHide: true })
    const [exitCode, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
    return { exitCode, stdout, stderr }
  }
}

/** The first complete line of `stream` that contains `text`, trimmed; an
 *  unterminated last line counts only once the stream ends. The stream is
 *  read to its end either way, so the command never writes to a closed pipe. */
function firstLineWith(stream: ReadableStream<Uint8Array>, text: string): Promise<string> {
  const { promise, resolve, reject } = Promise.withResolvers<string>()
  void (async () => {
    const decoder = new TextDecoder()
    let buffered = ""
    for await (const chunk of stream) {
      buffered += decoder.decode(chunk, { stream: true })
      const line = buffered.split("\n").slice(0, -1).find((candidate) => candidate.includes(text))
      if (line !== undefined) resolve(line.trim())
    }
    const remainder = (buffered.split("\n").at(-1) ?? "") + decoder.decode()
    if (remainder.includes(text)) resolve(remainder.trim())
    reject(new Error(`the output ended without a line that contains ${text}`))
  })().catch(reject)
  return promise
}

/** Each `remote machines` opens one device socket, and the relay admits at
 *  most 60 a minute from one address, so the poll stays below that over its
 *  whole wait; a faster poll reads the relay's refusal as "checking". */
const OFFER_POLL_MS = 1_500

/** Resolves once the laptop lists the machine's project as open, which it
 *  does once the machine announces the project to the relay after the
 *  pairing. */
async function offered(laptop: (args: readonly string[]) => Promise<CommandResult>): Promise<void> {
  const deadline = performance.now() + PAIRING_TIMEOUT_MS
  let last: CommandResult | undefined
  while (performance.now() < deadline) {
    const started = performance.now()
    last = await laptop(["remote", "machines"])
    if (last.exitCode === 0 && last.stdout.includes("(open)")) return
    await Bun.sleep(Math.max(0, Math.min(OFFER_POLL_MS - (performance.now() - started), deadline - performance.now())))
  }
  throw new Error(`the laptop did not list the project as open within ${PAIRING_TIMEOUT_MS}ms; last listing:\n${last?.stdout ?? ""}${last?.stderr ?? ""}`)
}
