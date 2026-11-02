import { readFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"

import { runningSourceSnapshot, runsThroughBun, sourceCheckout, sourceSnapshotHome } from "../../../infra/cli-subprocess.js"
import type { OwnedCommandRunner } from "../../../infra/owned-command.js"
import { isClientIdentity } from "../../../protocol/account-attach.js"

const BUILD_TIMEOUT_MS = 600_000

/** Where the web client's files are and which client they are, or why the
 *  runtime cannot say. The first `prepare` starts at `preparing` and moves to
 *  one of the two settled states. `resolved` is final. `failed` holds until a
 *  person's browser open (`openable`) looks again, so files restored after a
 *  failure serve without a restart. */
export type ControlUiAssetState =
  | { readonly kind: "preparing" }
  | SettledControlUiAssetState

export type SettledControlUiAssetState =
  /** `identity` is the one identity the build wrote as `client.json`: every
   *  page served from `root` states it, and every protocol attach that names
   *  one is checked against it. */
  | { readonly kind: "resolved"; readonly root: string; readonly identity: string }
  | { readonly kind: "failed"; readonly error: string }

export interface ControlUiAssets {
  /** Starts the one resolution if nothing has, and returns the state as it
   *  stands right now. A source run builds its snapshotted client first, and
   *  installed execution only inspects the webview directory beside the
   *  binary. */
  readonly prepare: () => ControlUiAssetState
  /** Starts the same resolution and settles when the current process knows
   *  whether it can serve the web client. */
  readonly settle: () => Promise<SettledControlUiAssetState>
  /** Settles like `settle`, but a failed resolution starts again, and a
   *  client that is still unavailable rejects with the reason. A person's
   *  browser open or Retry calls it, so restored files serve without a
   *  restart and an open never leads to a page that cannot load. Nothing
   *  else repeats a failed resolution, so a source checkout never rebuilds
   *  the client for a read or an attach. */
  readonly openable: () => Promise<void>
}

export interface ControlUiAssetOptions {
  readonly execPath?: string
  readonly sourceRoot?: string
  readonly run: OwnedCommandRunner
}

/** Owns the one process-wide transition from unavailable assets to a fixed
 *  root with one client identity. The identity is read once: the build writes
 *  `client.json` last, so a readable one names a build whose files are all in
 *  place, and the files are immutable for the life of the root. */
export function createControlUiAssets(options: ControlUiAssetOptions): ControlUiAssets {
  const execPath = options.execPath ?? process.execPath
  const snapshot = runningSourceSnapshot()
  const sourceRoot = resolve(options.sourceRoot ?? (snapshot === undefined
    ? sourceCheckout()
    : join(sourceSnapshotHome(snapshot.checkout), snapshot.digest)))
  const source = runsThroughBun(execPath)
  const root = source ? join(sourceRoot, "webview", "dist") : join(dirname(execPath), "webview")
  let state: ControlUiAssetState = { kind: "preparing" }
  let resolution: Promise<SettledControlUiAssetState> | undefined

  const resolveRoot = async (): Promise<SettledControlUiAssetState> => {
    if (source) {
      const result = await options.run(
        [execPath, "run", "--cwd", join(sourceRoot, "webview"), "build"],
        { timeoutMs: BUILD_TIMEOUT_MS },
      )
      if (result.timedOut) return { kind: "failed", error: "the web client build timed out" }
      if (result.exitCode !== 0) return { kind: "failed", error: result.stderr.trim() || `the web client build exited ${result.exitCode}` }
    }
    const path = join(root, "client.json")
    let text: string
    try {
      text = await readFile(path, "utf8")
    } catch {
      return { kind: "failed", error: `the web client is not at ${root}` }
    }
    const identity = readIdentity(text)
    if (identity === undefined) return { kind: "failed", error: `the web client identity at ${path} is malformed` }
    return { kind: "resolved", root, identity }
  }

  const start = (): Promise<SettledControlUiAssetState> => {
    resolution ??= resolveRoot().then(
      (settled) => {
        state = settled
        return settled
      },
      (cause) => {
        const failed = { kind: "failed", error: cause instanceof Error ? cause.message : String(cause) } as const
        state = failed
        return failed
      },
    )
    return resolution
  }

  return {
    prepare: () => {
      void start()
      return state
    },
    settle: start,
    openable: async () => {
      if (state.kind === "failed") {
        resolution = undefined
        state = { kind: "preparing" }
      }
      const client = await start()
      if (client.kind === "failed") throw new Error(`The web client is unavailable: ${client.error}`)
    },
  }
}

/** The identity in a `client.json`, or undefined when the file is not one. */
function readIdentity(text: string): string | undefined {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return undefined
  }
  if (typeof value !== "object" || value === null || !("identity" in value)) return undefined
  return isClientIdentity(value.identity) ? value.identity : undefined
}
