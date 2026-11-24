/** The durable checkpoints of the workspace retirement sequence, observed from
 *  the outside.
 *
 *  Production has no observer seam. This helper installs a contained directory
 *  backend that forwards every call to the platform backend and names the
 *  checkpoint that each durable step reaches after the step returns. An
 *  interruption fixture can then stop a real start at a real checkpoint, so a
 *  resume is proven against the state production wrote. */

import { basename, dirname } from "node:path"
import { Schema } from "effect"
import { setContainedDirectoryBackendForTests } from "../../src/infra/descriptor-directory.js"
import type { ContainedDirectory, ContainedDirectoryBackend } from "../../src/infra/descriptor-directory/descriptor-directory-contract.js"
import { posixContainedDirectoryBackend } from "../../src/infra/descriptor-directory/descriptor-directory-posix.js"
import { win32ContainedDirectoryBackend } from "../../src/infra/descriptor-directory/descriptor-directory-win32.js"

/** One durable point of the sequence, named by what is on disk once it is reached. */
export type RetirementCheckpoint =
  | "manifest-published"
  | "legacy-adopted"
  | `member-staged:${string}`
  | `member-discarded:${string}`
  | `phase-recorded:${string}`

/** The fields of a written retirement manifest that name its checkpoint. */
const decodeManifest = Schema.decodeUnknownSync(Schema.Struct({
  phase: Schema.String,
  location: Schema.Struct({ kind: Schema.String }),
  members: Schema.Array(Schema.String),
}))

const RETIRING_DIR = "retiring"
const RETIREMENT_MANIFEST = "retirement.json"

/** A staging target holds the members of one operation: `retiring/<id>`, or a
 *  quarantine target `quarantine/workspace-state/<name>` that an older release completed. */
function isStagingTarget(directoryPath: string): boolean {
  const parent = dirname(directoryPath)
  return basename(parent) === RETIRING_DIR
    || (basename(parent) === "workspace-state" && basename(dirname(parent)) === "quarantine")
}

function observingBackend(platform: ContainedDirectoryBackend, observe: (checkpoint: RetirementCheckpoint) => void): ContainedDirectoryBackend {
  const unwrapped = new WeakMap<ContainedDirectory, ContainedDirectory>()
  // The members of the last manifest written. Discarding one is a checkpoint;
  // removing the sidecars that an epoch probe recreated beside them is not.
  let members: ReadonlySet<string> = new Set()
  const wrap = (directory: ContainedDirectory): ContainedDirectory => {
    const overrides: Partial<ContainedDirectory> = {
      openChild: (name, options) => wrap(directory.openChild(name, options)),
      openExistingChild: (name) => wrapOptional(directory.openExistingChild(name)),
      openLinkedChild: (name) => wrapOptional(directory.openLinkedChild(name)),
      renameInto: (name, target, targetName) => {
        directory.renameInto(name, unwrapped.get(target) ?? target, targetName)
        if (basename(dirname(target.canonicalPath())) === RETIRING_DIR) observe(`member-staged:${name}`)
      },
      removeTree: (name) => {
        directory.removeTree(name)
        if (members.has(name) && isStagingTarget(directory.canonicalPath())) observe(`member-discarded:${name}`)
      },
      publishFileThrough: (pending, name, content, mode) => {
        const manifest = name === RETIREMENT_MANIFEST && basename(directory.canonicalPath()) === RETIRING_DIR
        const published = manifest && directory.hasEntry(name)
        const failure = directory.publishFileThrough(pending, name, content, mode)
        if (!manifest || failure !== undefined) return failure
        const record = decodeManifest(JSON.parse(content))
        members = new Set(record.members)
        if (published) observe(`phase-recorded:${record.phase}`)
        else observe(record.location.kind === "legacy" ? "legacy-adopted" : "manifest-published")
        return failure
      },
    }
    const proxy = new Proxy(directory, {
      get(target, key) {
        if (key in overrides) return Reflect.get(overrides, key)
        const value: unknown = Reflect.get(target, key, target)
        return typeof value === "function" ? value.bind(target) : value
      },
    })
    unwrapped.set(proxy, directory)
    return proxy
  }
  const wrapOptional = (directory: ContainedDirectory | undefined): ContainedDirectory | undefined => directory && wrap(directory)
  return {
    open: (baseDir, dirs, options) => wrap(platform.open(baseDir, dirs, options)),
    openExisting: (baseDir, dirs, options) => wrapOptional(platform.openExisting(baseDir, dirs, options)),
  }
}

/** Watch the durable checkpoints of every retirement in this process, or stop
 *  watching with `undefined`. */
export function observeRetirementCheckpoints(observe: ((checkpoint: RetirementCheckpoint) => void) | undefined): void {
  const platform = process.platform === "win32" ? win32ContainedDirectoryBackend : posixContainedDirectoryBackend
  setContainedDirectoryBackendForTests(observe && observingBackend(platform, observe))
}
