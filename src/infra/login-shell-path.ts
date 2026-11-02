// Adapted from OpenClaw's src/infra/shell-env.ts: the login-shell probe, the
// trusted-shell rule, the probe environment, and the NUL-framed parse.
import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"

import { errorMessage } from "./error-message.js"
import { Log } from "./log.js"
import type { OwnedCommandRunner } from "./owned-command.js"

/** The PATH a person's login shell builds, as the base of every agent
 *  command's PATH.
 *
 *  A service that a manager starts (launchd, systemd) runs with the manager's
 *  minimal PATH, such as `/usr/bin:/bin:/usr/sbin:/sbin`, and a service that a
 *  terminal starts runs with that terminal's PATH. The login shell's PATH is
 *  the same whatever started the service, so an agent command resolves the
 *  same binaries on every lane. Only PATH is taken from the probe; every other
 *  variable stays the process's own. */

const PROBE_TIMEOUT_MS = 15_000
const PROBE_MAX_OUTPUT_BYTES = 2 * 1024 * 1024
const DEFAULT_SHELL = "/bin/sh"
const LOGIN_SHELL_ENV_COMMAND = "printf '\\0'; env -0"

interface ProbeEnvironment {
  readonly [name: string]: string | undefined
}

type Logger = Pick<ReturnType<typeof Log.create>, "warn" | "info" | "debug">

/** Reads `env -0` output. Startup files may print text, such as a greeting,
 *  before the probe command runs. The leading NUL frames the environment
 *  payload, so that text cannot become part of its first key; output with no
 *  frame yields nothing. */
export function parseLoginShellEnv(stdout: Uint8Array): Map<string, string> {
  const shellEnv = new Map<string, string>()
  const frameEnd = stdout.indexOf(0)
  if (frameEnd < 0) return shellEnv
  const parts = new TextDecoder().decode(stdout.subarray(frameEnd + 1)).split("\0")
  for (const part of parts) {
    const eq = part.indexOf("=")
    if (eq <= 0) continue
    shellEnv.set(part.slice(0, eq), part.slice(eq + 1))
  }
  return shellEnv
}

/** The shell to probe: `$SHELL` only when it is an absolute, normalized path
 *  that `/etc/shells` lists, and `/bin/sh` otherwise. `/etc/shells` is the
 *  trust anchor, so a poisoned `$SHELL` cannot choose the program the service
 *  runs. A null registry means `/etc/shells` could not be read. */
export function resolveLoginShell(shell: string | undefined, registeredShells: ReadonlySet<string> | null): string {
  const candidate = shell?.trim()
  if (!candidate || !path.posix.isAbsolute(candidate) || path.posix.normalize(candidate) !== candidate) return DEFAULT_SHELL
  return registeredShells?.has(candidate) === true ? candidate : DEFAULT_SHELL
}

function readEtcShells(): ReadonlySet<string> | null {
  try {
    const entries = readFileSync("/etc/shells", "utf8")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith("#") && path.posix.isAbsolute(line))
    return new Set(entries)
  } catch {
    return null
  }
}

/** Startup-file resolution stays pinned to the real user home, and ZDOTDIR is
 *  removed so an inherited value cannot redirect zsh to other startup files. */
function probeEnvironment(env: ProbeEnvironment, home: string): ProbeEnvironment {
  const { ZDOTDIR: _redirect, HOME: _inherited, ...rest } = env
  const pinned = home.trim()
  return pinned ? { ...rest, HOME: pinned } : rest
}

type ProbeOutcome =
  | { readonly ok: true; readonly path: string; readonly timedOut: boolean }
  | { readonly ok: false; readonly reason: string }

async function runProbe(run: OwnedCommandRunner, shell: string, env: ProbeEnvironment): Promise<ProbeOutcome> {
  try {
    const result = await run([shell, "-l", "-c", LOGIN_SHELL_ENV_COMMAND], {
      env, timeoutMs: PROBE_TIMEOUT_MS, maxOutputBytes: PROBE_MAX_OUTPUT_BYTES,
    })
    if (result.timedOut) {
      // The owned container settles only when its process group is empty, so
      // a background job that a startup file starts holds the probe open after
      // the shell has printed its environment, and the bound ends that job.
      // `env -0` ends every entry with a NUL, so a PATH entry followed by one
      // is complete and stays usable; a cut entry is discarded.
      const complete = result.stdoutBytes.subarray(0, result.stdoutBytes.lastIndexOf(0) + 1)
      const probed = parseLoginShellEnv(complete).get("PATH")?.trim()
      return probed ? { ok: true, path: probed, timedOut: true } : { ok: false, reason: `the login shell did not finish within ${PROBE_TIMEOUT_MS / 1_000} s` }
    }
    if (result.exitCode !== 0) return { ok: false, reason: result.exitCode === null ? "the login shell was stopped by a signal" : `the login shell exited with code ${result.exitCode}` }
    if (result.stdoutTruncated) return { ok: false, reason: `the login shell printed more than ${PROBE_MAX_OUTPUT_BYTES} bytes` }
    const probed = parseLoginShellEnv(result.stdoutBytes).get("PATH")?.trim()
    return probed ? { ok: true, path: probed, timedOut: false } : { ok: false, reason: "the login shell printed no PATH" }
  } catch (error) {
    return { ok: false, reason: `the login shell could not start: ${errorMessage(error)}` }
  }
}

/** One process's login-shell PATH. It is unknown until a probe in this
 *  process succeeds or the process adopts a PATH that its parent probed. */
export interface LoginShellPath {
  /** The login shell's PATH, or undefined while it is unknown. Unknown means
   *  the probe has not finished, failed, or never runs, as on Windows, and
   *  the caller uses the process's own PATH. */
  current(): string | undefined
  /** Whether the PATH is unknown and a probe or an adopted PATH can still make
   *  it known: on every platform but Windows, until it is known. A failed probe
   *  leaves it pending, because the next probe or request runs the shell again. */
  pending(): boolean
  /** Probes the login shell unless the PATH is known. A call while a probe
   *  runs joins it. A failure is not kept, as in OpenClaw: the PATH stays
   *  unknown and the next probe or request runs the shell again. A failure
   *  records at WARN with the shell and the reason, never the environment,
   *  and a repeat of the reason just recorded records at DEBUG. Never rejects. */
  probe(run: OwnedCommandRunner): Promise<void>
  /** Probes again with the first probe's runner while the PATH is unknown. A
   *  project executor generation asks when it opens, which is the next
   *  lookup at which OpenClaw retries. Before any probe it does nothing. */
  request(): void
  /** Takes the PATH that another process of this service probed. */
  adopt(path: string): void
  /** Tells the listener the PATH now when it is known, and each time it
   *  becomes known later. Returns the unsubscribe. */
  watch(listener: (path: string) => void): () => void
}

export function createLoginShellPath(options: {
  readonly platform?: NodeJS.Platform
  readonly env?: () => ProbeEnvironment
  readonly home?: () => string
  readonly registeredShells?: () => ReadonlySet<string> | null
  readonly log?: Logger
} = {}): LoginShellPath {
  const platform = options.platform ?? process.platform
  let known: string | undefined
  let probing: Promise<void> | undefined
  let runner: OwnedCommandRunner | undefined
  let recordedFailure: string | undefined
  const listeners = new Set<(path: string) => void>()
  const adopt = (value: string): void => {
    known = value
    for (const listener of listeners) listener(value)
  }
  const probe = (run: OwnedCommandRunner): Promise<void> => {
    runner ??= run
    if (known !== undefined || platform === "win32") return Promise.resolve()
    probing ??= (async () => {
      const env = options.env?.() ?? process.env
      const shell = resolveLoginShell(env.SHELL, (options.registeredShells ?? readEtcShells)())
      const startedAt = performance.now()
      const outcome = await runProbe(run, shell, probeEnvironment(env, (options.home ?? homedir)()))
      const log = options.log ?? Log.create({ service: "login-shell-path" })
      if (!outcome.ok) {
        const failure = { shell, reason: outcome.reason }
        if (outcome.reason === recordedFailure) log.debug("the login shell PATH probe failed again", failure)
        else log.warn("agent commands use the service's own PATH because the login shell PATH probe failed", failure)
        recordedFailure = outcome.reason
        return
      }
      log.info("agent commands use the login shell PATH", {
        shell, durationMs: Math.round(performance.now() - startedAt),
        ...(outcome.timedOut ? { timedOut: true, reason: `a process the startup files left running was ended at the ${PROBE_TIMEOUT_MS / 1_000} s bound` } : {}),
      })
      adopt(outcome.path)
    })().finally(() => { probing = undefined })
    return probing
  }
  return {
    current: () => known,
    pending: () => known === undefined && platform !== "win32",
    adopt,
    watch(listener) {
      listeners.add(listener)
      if (known !== undefined) listener(known)
      return () => { listeners.delete(listener) }
    },
    probe,
    request() {
      if (runner !== undefined) void probe(runner)
    },
  }
}

/** This process's login-shell PATH. The account service probes it after it
 *  listens and again when a project opens while it is unknown; each project
 *  executor adopts the account's result. */
export const processLoginShellPath = createLoginShellPath()
