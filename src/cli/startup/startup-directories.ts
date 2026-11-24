import { join } from "node:path"

import { AccountHomeRefusal, canonicalAccountHome, environmentAccountHome, FLYWHEEL_DIR_NAME, selectInteractiveStartupDirectories, selectStartupDirectories, type AccountDirectories, type StartupDirectories, type StartupDirectoryFallback, type StartupDirectoryFallbackCandidate } from "../../infra/directory-authorities.js"
import type { RootCliAction } from "../root-args.js"

type RunCliAction = Extract<RootCliAction, { kind: "run" }>

/** A terminal launch that opens a project on another machine instead of one
 *  here: asked for with `--remote`, chosen at the project prompt, or started
 *  in the account home of a paired terminal. */
export interface AnotherMachine {
  readonly kind: "another-machine"
  readonly account: AccountDirectories
}

/** Whether the run opens the project its directories select: a terminal or
 *  headless launch, which has no subcommand, and `flywheel web`. Every other
 *  subcommand works on the account or reads a store, so the account home
 *  stays a valid place to run it (PI-INTERACTION-069). */
function opensProject(args: readonly string[]): boolean {
  const first = args[0]
  return first === undefined || first.startsWith("-") || first === "web"
}

/** Whether startup asks the person which project root to open. Only a run
 *  that opens a project on a terminal asks: an account or store command has
 *  no project to choose, and an established `.flywheel` directory is found
 *  without a question. */
export function shouldSelectStartupInteractively(
  args: readonly string[],
  stdinIsTty: boolean,
  stdoutIsTty: boolean,
): boolean {
  return opensProject(args) && !args.includes("--headless") && stdinIsTty && stdoutIsTty
}

/** Whether this run is the terminal on a project: a launch with no
 *  subcommand. `flywheel web` opens a project too, but in the web client, so
 *  only the terminal offers a project on another machine. */
function opensTerminal(args: readonly string[]): boolean {
  const first = args[0]
  return first === undefined || first.startsWith("-")
}

/** What directory selection reads of this process. */
interface DirectorySelectionIo {
  readonly env: { readonly [name: string]: string | undefined }
  readonly cwd: string
  /** Whether this run asks the person (`shouldSelectStartupInteractively`). */
  readonly interactive: boolean
  readonly choose: (candidates: readonly StartupDirectoryFallbackCandidate[], options: { readonly pairedMachines: number }) => Promise<StartupDirectoryFallback | "another-machine">
  /** How many machines this account's terminal is paired with. */
  readonly pairedMachines: (userDataRoot: string) => Promise<number>
}

/** Selects the run's directories, or a project on another machine: asked
 *  for with `--remote`, chosen at the project prompt, or the terminal in the
 *  account home of a terminal paired with a machine, where a local launch is
 *  refused (PI-INTERACTION-069). Only a terminal launch that is about to ask the person,
 *  or to refuse the account home, reads this terminal's device store; an
 *  established project opens without reading it. */
export async function selectRunDirectories(action: RunCliAction, io: DirectorySelectionIo): Promise<StartupDirectories | AnotherMachine> {
  if (action.remote === true) return anotherMachine(environmentAccountHome(io.env))
  const selection = { projectRootOption: action.projectRootOption, env: io.env, cwd: io.cwd, opensProject: opensProject(action.args) }
  if (!io.interactive) return selectStartupDirectories(selection)
  const paired = async (): Promise<number> => opensTerminal(action.args) ? await io.pairedMachines(join(environmentAccountHome(io.env), FLYWHEEL_DIR_NAME)) : 0
  try {
    const selected = await selectInteractiveStartupDirectories<"another-machine">(selection, async (candidates) => await io.choose(candidates, { pairedMachines: await paired() }))
    return selected === "another-machine" ? anotherMachine(environmentAccountHome(io.env)) : selected
  } catch (error) {
    if (error instanceof AccountHomeRefusal && await paired() > 0) return anotherMachine(error.accountHome)
    throw error
  }
}

function anotherMachine(accountHome: string): AnotherMachine {
  const home = canonicalAccountHome(accountHome)
  return { kind: "another-machine", account: { accountHome: home, userDataRoot: join(home, FLYWHEEL_DIR_NAME) } }
}
