import { existsSync, realpathSync, statSync } from "node:fs"
import { homedir } from "node:os"
import path, { dirname, join, resolve } from "node:path"

/** Name of the directory Flywheel keeps its state in, under both an account
 *  home and a project root. */
export const FLYWHEEL_DIR_NAME = ".flywheel"
export const WORKTREE_LIFECYCLE_SKILL_ID = "worktree-lifecycle"

/** The startup directory metadata of one Flywheel process (ARCH-DIRECTORIES-001,
 * ARCH-DIRECTORIES-003). Root
 * authorities do not substitute for each other. Repository identity is optional
 * metadata derived once from `executionCwd`, never a durable-state authority. */
export interface StartupDirectories {
  /** Final account-global data directory: `<account home>/.flywheel`. */
  readonly userDataRoot: string
  /** Account home `userDataRoot` was derived from. Startup input carried
   *  forward, not a fourth authority: the only production paths that read it
   *  are the account paths that live outside `userDataRoot`, which are the
   *  cross-harness `~/.agents` directory, the platform font directories, and
   *  the home prefix the TUI abbreviates. */
  readonly accountHome: string
  /** Canonical directory that owns this project's durable and definitional state. */
  readonly projectRoot: string
  /** Canonical directory a session created by this command executes in. */
  readonly executionCwd: string
  /** Canonical containing Git repository, when execution starts in one. */
  readonly canonicalRepositoryRoot?: string
}

/** The account-global directory inputs one Flywheel process publishes at
 *  startup: the final `userDataRoot` every account-global path derives from,
 *  and the account home the few account paths outside it derive from. A
 *  consumer of account state receives this, so `StartupDirectories` itself is
 *  assignable wherever it is required. */
export type AccountDirectories = Pick<StartupDirectories, "userDataRoot" | "accountHome">

/** The directory authorities a project-scoped consumer receives: the project
 *  root it owns state under, plus the account-global inputs. Startup publishes
 *  every value, so `StartupDirectories` is assignable wherever this is
 *  required and nothing downstream looks a directory up again. */
export type ProjectDirectories = AccountDirectories & Pick<StartupDirectories, "projectRoot">

interface EnvironmentVariables { readonly [name: string]: string | undefined }

export interface StartupDirectorySelection {
  /** Value of the global `--project-root` option, absent when not given. */
  readonly projectRootOption?: string
  readonly env: EnvironmentVariables
  /** Directory the process started in. */
  readonly cwd: string
  /** Account home. Redirected by tests and sandboxed runs through `HOME`. */
  readonly home?: string
  /** Whether the run opens the project it selects, as a terminal, a
   *  headless run, and `flywheel web` do. Such a run refuses the account home
   *  unless an exact selection names it. */
  readonly opensProject?: boolean
}

export type StartupDirectoryFallback = "git-root" | "starting-directory"

export interface StartupDirectoryFallbackCandidate {
  readonly kind: StartupDirectoryFallback
  readonly path: string
}

/** Chooses between the fallback candidates. A chooser may offer one more
 *  answer, `Other`, that names no directory here, such as a project on
 *  another machine; the selection then returns that answer unchanged. */
export type StartupDirectoryChooser<Other extends string = never> = (
  candidates: readonly StartupDirectoryFallbackCandidate[],
) => Promise<StartupDirectoryFallback | Other>

/** A run that opens a project was started in the account home, which is no
 *  project unless an exact selection names it. */
export class AccountHomeRefusal extends Error {
  constructor(readonly accountHome: string) {
    super(`Flywheel can't use your home folder (${accountHome}) as a project, because its ${FLYWHEEL_DIR_NAME} folder holds your global settings. To start a new project, run flywheel in any other folder.`)
    this.name = "AccountHomeRefusal"
  }
}

/** Nearest ancestor of `startDir` holding a `.git` entry. A worktree or
 * submodule marks its root with a `.git` file rather than a directory, so both
 * count. Outside a repository the resolved starting directory is returned. */
export function nearestProjectRoot(startDir: string): string {
  const start = resolve(startDir)
  let current = start
  while (!existsSync(join(current, ".git"))) {
    const parent = dirname(current)
    if (parent === current) return start
    current = parent
  }
  return current
}

interface StartupDirectoryDiscovery {
  readonly selection: StartupDirectorySelection
  readonly accountHome: string
  readonly executionCwd: string
  readonly canonicalRepositoryRoot?: string
  readonly selectedProjectRoot?: string
  readonly fallbackCandidates: readonly StartupDirectoryFallbackCandidate[]
}

/** Discovery never takes the account home as a project by itself: its
 *  `.flywheel` is the account data root, not a project's state directory, and
 *  a home that is a repository is no fallback while the starting directory
 *  is another one. Only a launch at the home itself reaches it, and a run that
 *  opens a project refuses it there. */
function discoverStartupDirectories(selection: StartupDirectorySelection): StartupDirectoryDiscovery {
  const accountHome = selection.home ? canonicalAccountHome(selection.home) : environmentAccountHome(selection.env)
  const executionCwd = canonicalDirectory(selection.cwd, "starting directory")
  const canonicalRepositoryRoot = containingRepositoryRoot(executionCwd)
  const explicit = selection.projectRootOption ?? emptyToUndefined(selection.env.FLYWHEEL_PROJECT_ROOT)
  if (explicit !== undefined) {
    return {
      selection,
      accountHome,
      executionCwd,
      canonicalRepositoryRoot,
      selectedProjectRoot: canonicalDirectory(explicit, "project directory"),
      fallbackCandidates: [],
    }
  }

  const gitRoot = canonicalRepositoryRoot ?? executionCwd
  let current = executionCwd
  while (true) {
    if (current !== accountHome && directoryExists(join(current, FLYWHEEL_DIR_NAME))) {
      return { selection, accountHome, executionCwd, canonicalRepositoryRoot, selectedProjectRoot: current, fallbackCandidates: [] }
    }
    if (current === gitRoot) break
    current = dirname(current)
  }

  const fallbackCandidates: StartupDirectoryFallbackCandidate[] = []
  if (gitRoot !== accountHome || executionCwd === gitRoot) fallbackCandidates.push({ kind: "git-root", path: gitRoot })
  if (executionCwd !== gitRoot) fallbackCandidates.push({ kind: "starting-directory", path: executionCwd })
  if (selection.opensProject === true && fallbackCandidates.length === 1 && fallbackCandidates[0]?.path === accountHome) {
    throw new AccountHomeRefusal(accountHome)
  }
  return { selection, accountHome, executionCwd, canonicalRepositoryRoot, fallbackCandidates }
}

/** The directories an account service opens a project with. Its sessions
 *  start at the project root, so the project root is the execution directory,
 *  and the repository that contains the project root is the repository
 *  identity. The service's own starting directory gives neither. */
export function accountProjectDirectories(account: AccountDirectories, projectRoot: string): StartupDirectories {
  const canonicalRepositoryRoot = containingRepositoryRoot(projectRoot)
  return {
    userDataRoot: account.userDataRoot,
    accountHome: account.accountHome,
    projectRoot,
    executionCwd: projectRoot,
    ...(canonicalRepositoryRoot ? { canonicalRepositoryRoot } : {}),
  }
}

function containingRepositoryRoot(executionCwd: string): string | undefined {
  const candidate = nearestProjectRoot(executionCwd)
  return existsSync(join(candidate, ".git")) ? canonicalDirectory(candidate, "repository directory") : undefined
}

function publishStartupDirectories(discovery: StartupDirectoryDiscovery, projectRoot: string): StartupDirectories {
  const { accountHome, executionCwd, canonicalRepositoryRoot } = discovery
  return {
    userDataRoot: join(accountHome, FLYWHEEL_DIR_NAME),
    accountHome,
    projectRoot,
    executionCwd,
    ...(canonicalRepositoryRoot ? { canonicalRepositoryRoot } : {}),
  }
}

/** Select the directory authorities synchronously without user interaction.
 * Explicit configuration and an established `.flywheel` directory are exact.
 * Otherwise the nearest Git root owns state, or the starting directory when
 * outside a repository. */
export function selectStartupDirectories(selection: StartupDirectorySelection): StartupDirectories {
  const discovery = discoverStartupDirectories(selection)
  const projectRoot = discovery.selectedProjectRoot ?? discovery.fallbackCandidates[0]?.path
  if (projectRoot === undefined) throw new Error("startup directory discovery produced no project root")
  return publishStartupDirectories(discovery, projectRoot)
}

/** Select directory authorities with a semantic chooser for an unestablished
 * project. The chooser runs only when discovery yields two distinct fallback
 * candidates. Its rejection, and an answer that names no directory here, are
 * returned unchanged. */
export async function selectInteractiveStartupDirectories<Other extends string = never>(
  selection: StartupDirectorySelection,
  chooser: StartupDirectoryChooser<NoInfer<Other>>,
): Promise<StartupDirectories | Other> {
  const discovery = discoverStartupDirectories(selection)
  if (discovery.selectedProjectRoot !== undefined) {
    return publishStartupDirectories(discovery, discovery.selectedProjectRoot)
  }

  const onlyCandidate = discovery.fallbackCandidates.length === 1 ? discovery.fallbackCandidates[0] : undefined
  if (onlyCandidate !== undefined) return publishStartupDirectories(discovery, onlyCandidate.path)

  const choice = await chooser(discovery.fallbackCandidates)
  if (choice !== "git-root" && choice !== "starting-directory") return choice
  const candidate = discovery.fallbackCandidates.find(({ kind }) => kind === choice)
  if (candidate === undefined) throw new Error(`Project selection returned unknown choice: ${choice}`)
  return publishStartupDirectories(discovery, candidate.path)
}

/** The account home, canonicalized once so every account path below it is
 *  derived from a path with no symlinked component of its own. A home that is not
 *  there yet is only resolved: the first account write creates it, and every
 *  Flywheel-owned component below it is admitted without following a link when it
 *  is created (see private-path.ts and descriptor-directory.ts). Two processes
 *  that name the same home therefore compare equal in this form. */
export function canonicalAccountHome(home: string): string {
  const absolute = resolve(home)
  return existsSync(absolute) ? canonicalDirectory(absolute, "account home") : absolute
}

/** The account home an environment names when no option selects one: HOME,
 *  or the system's home directory when HOME is empty. */
export function environmentAccountHome(env: EnvironmentVariables): string {
  return canonicalAccountHome(env.HOME || homedir())
}

/** A directory selection is only ever a path: characters a shell would treat as
 *  syntax are ordinary name bytes here. Existence and directory type are the
 *  whole contract. */
export function canonicalDirectory(requested: string, label: string): string {
  const absolute = resolve(requested)
  // A missing path is the whole story, so it names no system error; any
  // other failure keeps the system error that explains it.
  if (!existsSync(absolute)) throw new Error(`${label} does not exist: ${absolute}`)
  let canonical: string
  try {
    canonical = realpathSync(absolute)
  } catch (cause) {
    throw new Error(`${label} cannot be opened: ${absolute}`, { cause })
  }
  if (!statSync(canonical).isDirectory()) throw new Error(`${label} is not a directory: ${absolute}`)
  return canonical
}

export function resolveExecutionDirectoryInput(
  parentExecutionCwd: string,
  requested: string,
  pathApi: Pick<typeof path, "isAbsolute" | "resolve" | "win32"> = path,
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform === "win32") {
    if (/^[A-Za-z]:(?![\\/])/.test(requested)) throw new Error("Windows drive-relative execution directories are not supported")
    if (/^[\\/](?![\\/])/.test(requested)) throw new Error("Windows rooted execution directories must include a drive")
    return pathApi.win32.resolve(parentExecutionCwd, requested)
  }
  return pathApi.isAbsolute(requested) ? pathApi.resolve(requested) : pathApi.resolve(parentExecutionCwd, requested)
}

/** Whether a recorded directory authority still names a usable directory.
 *  Same contract as canonicalDirectory, reported as a boolean for callers that
 *  mark or repair stale recorded values instead of failing. */
export function directoryExists(requested: string): boolean {
  try {
    canonicalDirectory(requested, "directory")
    return true
  } catch {
    return false
  }
}

function emptyToUndefined(value: string | undefined): string | undefined {
  return value === undefined || value === "" ? undefined : value
}
