import { existsSync } from "node:fs"
import { mkdir, rm } from "node:fs/promises"
import { join } from "node:path"

import { errorMessage } from "../../infra/error-message.js"
import { Log } from "../../infra/log.js"
import { durationMs } from "../../infra/operation-log.js"
import type { OwnedCommandResult, OwnedCommandRunner } from "../../infra/owned-command.js"
import { parseRepository, type RepositoryReference } from "../../protocol/repository-reference.js"
import type { AccountProjectRegistry } from "./account-project-registry.js"

const log = Log.create({ service: "account-project-clone" })

/** How long one clone may run before the account service stops it. A large
 *  repository on a slow link takes minutes; a clone still running after this
 *  is waiting on something that will not come, such as a credential prompt. */
const CLONE_TIMEOUT_MS = 30 * 60_000

/** The newest lines of git's own error output that reach the person. */
const REPORTED_ERROR_LINES = 3

/** A project the account service cloned and recorded. */
export interface ClonedProject {
  /** The canonical root, as the account registry names it. */
  readonly projectRoot: string
  readonly label: string
}

/** Why a clone did not produce a project, in words a person can act on. */
export class ProjectCloneFailure extends Error {
  readonly _tag = "ProjectCloneFailure" as const
}

export interface AccountProjectClone {
  /** Clones the repository a paired device named into a new folder of the
   *  account's projects root and records it in the account registry, which
   *  then offers it like any project the machine opened. The folder takes the
   *  repository's name, with `-2`, `-3`, and so on when that name is taken, so
   *  a clone never writes into a folder that already exists. Git runs with the
   *  machine's own credentials (a credential helper such as `gh auth
   *  setup-git`, or SSH keys) and never prompts; Flywheel holds no token.
   *  Rejects with `ProjectCloneFailure`. */
  clone(repository: string): Promise<ClonedProject>
  /** Stops every clone in progress and waits for each to settle. Idempotent. */
  dispose(): Promise<void>
}

export function createAccountProjectClone(options: {
  /** Where new projects go: `accountProjectsDir` of the account home. */
  readonly projectsRoot: string
  readonly registry: Pick<AccountProjectRegistry, "record">
  readonly run: OwnedCommandRunner
  /** The login shell's PATH while it is known, which finds the credential
   *  helper a person installed, such as `gh`. */
  readonly searchPath: () => string | undefined
  readonly environment?: NodeJS.ProcessEnv
  readonly timeoutMs?: number
}): AccountProjectClone {
  const stopping = new AbortController()
  const running = new Set<Promise<unknown>>()
  // Folder names a clone in progress holds, so two clones of one repository
  // never pick the same folder.
  const reserved = new Set<string>()

  function folderFor(name: string): string {
    const base = folderName(name)
    for (let suffix = 1; ; suffix++) {
      const candidate = suffix === 1 ? base : `${base}-${suffix}`
      if (!reserved.has(candidate) && !existsSync(join(options.projectsRoot, candidate))) return candidate
    }
  }

  async function clone(text: string): Promise<ClonedProject> {
    if (stopping.signal.aborted) throw new ProjectCloneFailure("The machine's Flywheel is stopping. Try again once it is back.")
    let reference: RepositoryReference
    try {
      reference = parseRepository(text)
    } catch (error) {
      throw new ProjectCloneFailure(errorMessage(error))
    }
    await mkdir(options.projectsRoot, { recursive: true })
    const folder = folderFor(reference.name)
    reserved.add(folder)
    const destination = join(options.projectsRoot, folder)
    const started = performance.now()
    try {
      let result: OwnedCommandResult
      try {
        result = await options.run([
          "git",
          // Only https and ssh, whatever the repository's own configuration
          // asks for later: a remote helper or a local path never runs here.
          "-c", "protocol.allow=never", "-c", "protocol.https.allow=always", "-c", "protocol.ssh.allow=always",
          "clone", "--", reference.url, destination,
        ], {
          cwd: options.projectsRoot,
          env: cloneEnvironment(options.environment ?? process.env, options.searchPath()),
          timeoutMs: options.timeoutMs ?? CLONE_TIMEOUT_MS,
          outputRetention: "tail",
          signal: stopping.signal,
        })
      } catch (error) {
        log.warn("repository clone could not start git", { error: errorMessage(error) })
        throw new ProjectCloneFailure(`The machine could not run git: ${errorMessage(error)}. Install git on the machine.`)
      }
      if (result.exitCode !== 0 || result.timedOut || stopping.signal.aborted) {
        log.warn("repository clone failed", { exitCode: result.exitCode, timedOut: result.timedOut, stopped: stopping.signal.aborted, durationMs: durationMs(started) })
        // The folder was free when the clone began, so whatever is there now
        // is the clone's own leftover.
        await rm(destination, { recursive: true, force: true }).catch((error: unknown) => {
          log.warn("a failed clone's folder could not be removed", { error: errorMessage(error) })
        })
        throw new ProjectCloneFailure(failureMessage(text.trim(), result, stopping.signal.aborted, options.timeoutMs ?? CLONE_TIMEOUT_MS))
      }
      const project = await options.registry.record({ projectRoot: destination, label: folder })
      log.info("repository cloned into a new project", { projectRoot: project.projectRoot, durationMs: durationMs(started) })
      return { projectRoot: project.projectRoot, label: project.label }
    } finally {
      reserved.delete(folder)
    }
  }

  return {
    clone(text) {
      const work = clone(text)
      const settled = work.then(() => {}, () => {})
      running.add(settled)
      void settled.then(() => running.delete(settled))
      return work
    },
    async dispose() {
      stopping.abort()
      await Promise.all(running)
    },
  }
}

/** Names Windows keeps for devices. A folder whose name before its first dot
 *  is one of them, such as `aux` or `con.js`, cannot be made there. */
const WINDOWS_DEVICE_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i

/** The folder a repository's name becomes: characters a path on every
 *  platform accepts, never hidden, never empty, never a Windows device name. */
function folderName(name: string): string {
  const safe = name.replace(/[^A-Za-z0-9._-]/g, "-").replace(/^[.-]+/, "").replace(/[. ]+$/, "")
  if (safe.length === 0) return "project"
  return WINDOWS_DEVICE_NAME.test(safe) ? safe.replace(/^[^.]*/, "$&-project") : safe
}

/** The environment git runs in: the service's own, with the login shell's
 *  PATH so a credential helper the person installed is found, and prompts off
 *  so a missing credential fails at once instead of waiting for an answer
 *  nobody can type. `GIT_TERMINAL_PROMPT` stops git's own terminal prompts.
 *  `GCM_INTERACTIVE` stops Git Credential Manager, which Git for Windows
 *  installs by default, from opening a sign-in window on a desktop where
 *  nobody is present. */
function cloneEnvironment(environment: NodeJS.ProcessEnv, searchPath: string | undefined): NodeJS.ProcessEnv {
  return { ...environment, ...(searchPath === undefined ? {} : { PATH: searchPath }), GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never" }
}

const CREDENTIAL_FAILURE = /terminal prompts disabled|could not read (?:Username|Password)|Authentication failed|Permission denied \(publickey|Host key verification failed|could not read from remote repository/i
const NOT_FOUND = /repository '.*' not found|Repository not found|does not appear to be a git repository/i

function failureMessage(repository: string, result: OwnedCommandResult, stopped: boolean, timeoutMs: number): string {
  if (stopped) return "The machine's Flywheel stopped before the clone finished. Try again once it is back."
  if (result.timedOut) return `Cloning ${repository} took longer than ${Math.round(timeoutMs / 60_000)} minutes, so the machine stopped it.`
  const lines = result.stderr.split(/\r?\n|\r/).map((line) => line.trim()).filter((line) => line.length > 0 && !/^(Cloning into|remote: (Enumerating|Counting|Compressing|Total))/.test(line))
  const detail = lines.slice(-REPORTED_ERROR_LINES).join(" ")
  if (CREDENTIAL_FAILURE.test(result.stderr) || NOT_FOUND.test(result.stderr)) {
    return `The machine could not read ${repository}. Check the name, and give the machine git access to it: run \`gh auth login\` and \`gh auth setup-git\` on the machine, or set up an SSH key or a git credential helper there.${detail === "" ? "" : ` Git said: ${detail}`}`
  }
  return detail === "" ? `The machine could not clone ${repository}.` : `The machine could not clone ${repository}. Git said: ${detail}`
}
