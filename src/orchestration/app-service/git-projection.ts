import { observeGitDirectory } from "../../infra/env-detection.js"
import { Log } from "../../infra/log.js"
import { gitCursor, type GitDirectoryView, type GitView } from "../../protocol/git-protocol-types.js"
import type { RuntimeUiPatchInput } from "../../protocol/runtime-ui-protocol-types.js"

const log = Log.create({ service: "git-projection" })

export interface GitProjection {
  view(): GitView
  /** Holds or updates the canonical directory of a session shown by held detail. */
  holdSession(sessionId: string, directory: string): void
  releaseSession(sessionId: string): void
  dispose(): void
}

/** Holds the project and client-held sessions' Git directories until their last user releases them.
 * Publishes whole directory views on the workspace git cursor. */
export function createGitProjection(options: {
  readonly projectRoot: string
  readonly publish: (patch: RuntimeUiPatchInput) => void
}): GitProjection {
  let view: GitView = { directories: {} }
  let started = false
  const watchers = new Map<string, () => void>()
  const sessions = new Map<string, string>()
  const publish = () => options.publish({ cursor: gitCursor(), payload: { kind: "git.changed", git: view } })
  const hold = (directory: string) => {
    if (watchers.has(directory)) return
    const stop = observeGitDirectory(directory, (metadata: GitDirectoryView) => {
      view = { directories: { ...view.directories, [directory]: metadata } }
      if (started) publish()
    })
    watchers.set(directory, stop)
    log.debug("git watcher started", { directoryCount: watchers.size })
  }
  const releaseUnused = () => {
    const held = new Set([options.projectRoot, ...sessions.values()])
    let changed = false
    for (const [directory, stop] of watchers) {
      if (held.has(directory)) continue
      stop()
      watchers.delete(directory)
      const { [directory]: _removed, ...directories } = view.directories
      view = { directories }
      changed = true
      log.debug("git watcher stopped", { directoryCount: watchers.size })
    }
    if (changed) publish()
  }
  // The synchronous first observation belongs to the initial snapshot.
  hold(options.projectRoot)
  started = true
  return Object.freeze({
    view: () => view,
    holdSession(sessionId: string, directory: string) {
      if (sessions.get(sessionId) === directory) return
      sessions.set(sessionId, directory)
      hold(directory)
      releaseUnused()
    },
    releaseSession(sessionId: string) {
      sessions.delete(sessionId)
      releaseUnused()
    },
    dispose() {
      sessions.clear()
      for (const [directory, stop] of watchers) {
        stop()
        watchers.delete(directory)
        log.debug("git watcher stopped", { directoryCount: watchers.size })
      }
    },
  })
}
