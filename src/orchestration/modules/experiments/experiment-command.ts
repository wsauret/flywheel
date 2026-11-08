import type { CommandOutcome } from "../../../protocol/command-catalog-protocol-types.js"
import type { CommandMethod, CommandPrompt } from "../../app-service/command-host.js"
import type { ExperimentSnapshot } from "./projection.js"
import { parseExperimentCharter } from "./charter.js"

const USAGE = "Usage: /experiment [design <goal>|start|off|clear [discard]|finalize|dashboard]"
const HELP = [
  USAGE,
  "",
  "design <goal> creates an approved experiment charter.",
  "start validates the committed charter and starts the experiment loop.",
  "off leaves experiment mode.",
  "clear leaves experiment mode and clears its selected working directory.",
  "clear discard also discards an interrupted experiment operation and leaves the worktree as it is.",
  "finalize turns the kept experiments into clean, reviewable branches.",
  "dashboard opens the experiment dashboard.",
].join("\n")

const EXPERIMENT_START_CONTEXT = [
  "Experiment mode active.",
  "Read .experiment/charter.md, then call init_experiment with the charter's values, run the baseline with run_experiment, log it, and loop.",
  "You must call run_experiment exactly once before each log_experiment. Do not run the measure or checks commands yourself.",
].join(" ")

export interface ExperimentCommandDeps {
  readonly executionCwd: string
  readonly projectRoot: string
  readonly snapshot: () => Promise<Pick<ExperimentSnapshot, "mode"> | undefined>
  readonly readCharter: () => Promise<string | null>
  readonly validateWorktree: (workDir: string) => Promise<string>
  readonly trackedFilesAreClean: (workDir: string) => Promise<boolean>
  readonly activate: (workDir: string) => Promise<void>
  /** Leaves experiment mode and retires the hold of a live run; `discard`
   *  also retires the holds of interrupted work. */
  readonly stop: (workDir: string | null, discard: boolean) => Promise<void>
  readonly prompt: (input: CommandPrompt) => Promise<boolean>
  readonly startMethod: (input: CommandMethod) => Promise<CommandOutcome>
  readonly interrupt: () => void
  readonly interruption: () => Promise<string | undefined>
}

const HANDLED: CommandOutcome = { kind: "none" }
const INTERRUPTION_KEPT = "Experiment mode is off. An interrupted experiment operation remains. Run /experiment clear discard to discard it and leave the experiment worktree as it is."
const refused = (message: string): CommandOutcome => ({ kind: "warning", message })

/** Executes one parsed `/experiment` command against its session-owned authorities. */
export async function executeExperimentCommand(argument: string | undefined, deps: ExperimentCommandDeps): Promise<CommandOutcome> {
  const raw = argument?.trim() ?? ""
  if (!raw) return { kind: "message", message: HELP }
  if (raw === "dashboard") return { kind: "open", surface: "experiment-dashboard" }
  if (raw === "off") {
    await deps.stop((await deps.snapshot())?.mode.workDir ?? null, false)
    deps.interrupt()
    return HANDLED
  }
  if (raw === "clear" || raw === "clear discard") {
    const discard = raw === "clear discard"
    await deps.stop(null, discard)
    deps.interrupt()
    if (discard || !(await deps.interruption())) return HANDLED
    return { kind: "message", message: INTERRUPTION_KEPT }
  }
  if (raw === "design" || raw.startsWith("design ")) {
    const goal = raw.slice("design".length).trim()
    if (!goal) return refused("Usage: /experiment design <goal>")
    return deps.startMethod({ skill: "experiment-charter", label: "/experiment design", args: goal })
  }
  if (raw === "finalize") return deps.startMethod({ skill: "experiment-finalize", label: "/experiment finalize" })
  if (raw !== "start") return refused(USAGE)
  const interruption = await deps.interruption()
  if (interruption) return refused(interruption)
  if ((await deps.snapshot())?.mode.active) return refused("Experiment mode is already active.")

  const markdown = await deps.readCharter()
  if (markdown === null) return refused("No committed .experiment/charter.md exists in this session's execution directory.")
  try {
    const charter = parseExperimentCharter(markdown)
    const workDir = await deps.validateWorktree(charter.workDir)
    if (!(await deps.trackedFilesAreClean(workDir))) {
      return refused("The experiment charter, measure script, and checks script must be tracked and the worktree must be clean.")
    }
    await deps.activate(workDir)
    const dispatched = await deps.prompt({ text: EXPERIMENT_START_CONTEXT, label: "/experiment start", context: EXPERIMENT_START_CONTEXT })
    return dispatched ? HANDLED : refused("The experiment was activated, but its start context could not be delivered.")
  } catch (error) {
    return refused(error instanceof Error ? error.message : String(error))
  }
}
