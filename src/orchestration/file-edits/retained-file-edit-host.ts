import { randomBytes } from "node:crypto"
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
import {
  ContainedDirectory,
  type ContainedFileMetadata,
  type ContainedFileSnapshot,
  type FileMutationAttemptResult,
} from "../../infra/descriptor-directory.js"
import { sameFileMetadata, sameFileSnapshot } from "../../infra/descriptor-directory-contract.js"
import { canonicalMutationPath } from "../../infra/file-mutation-queue.js"

/** The largest file a text edit admits or encodes. Exact bytes admitted with a larger bound publish at any size. */
export const MAX_FILE_EDIT_BYTES = 16 * 1024 * 1024

const utf8Decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true })
const utf8Encoder = new TextEncoder()

/** Retains one physical parent authority and the target state admitted through it. */
export class RetainedFileEditAuthority {
  readonly path: string
  readonly name: string
  readonly canonicalPath: string
  readonly snapshot: ContainedFileSnapshot | undefined
  readonly text: string | undefined
  readonly mayCreateMissingParents: boolean
  #directory: ContainedDirectory
  readonly #missingDirectories: readonly string[]
  readonly #parentPath: string
  /** The admission bound, which every later read of the target keeps. */
  readonly #maxBytes: number
  #closed = false

  private constructor(path: string, directory: ContainedDirectory, missingDirectories: readonly string[], name: string, snapshot: ContainedFileSnapshot | undefined, text: string | undefined, maxBytes: number) {
    this.path = path
    this.#maxBytes = maxBytes
    this.#directory = directory
    this.#missingDirectories = missingDirectories
    this.#parentPath = directory.canonicalPath()
    this.name = name
    this.canonicalPath = canonicalMutationPath(join(directory.canonicalPath(), ...missingDirectories, name))
    this.snapshot = snapshot
    this.text = text
    this.mayCreateMissingParents = missingDirectories.length > 0
  }

  /** Admits an existing strict UTF-8 regular file within the caller's byte bound. */
  static admit(path: string, maxBytes = MAX_FILE_EDIT_BYTES): RetainedFileEditAuthority {
    const authority = RetainedFileEditAuthority.admitWritable(path, dirname(path), maxBytes)
    if (!authority.snapshot) {
      authority.close()
      throw new Error(`${path} does not exist`)
    }
    if (authority.text === undefined) {
      authority.close()
      throw new Error(`${path} is not valid UTF-8`)
    }
    return authority
  }

  /** Retains the nearest existing directory below a selected ancestor without creating missing descendants.
   * The selected ancestor may be reached through a symlink; no directory below it is, so a symlink or
   * non-directory that holds part of the path below it refuses admission with a `ContainedPathError`. */
  static admitWritable(path: string, selectedAncestor?: string, maxBytes = MAX_FILE_EDIT_BYTES): RetainedFileEditAuthority {
    const target = resolve(path)
    const ancestor = selectedAncestor ?? deepestExistingParent(target)
    const selected = resolve(ancestor)
    const suffix = relative(selected, target)
    if (suffix === "" || isAbsolute(suffix) || suffix === ".." || suffix.startsWith(`..${sep}`)) {
      throw new Error(`${path} is not a file below the selected ancestor ${ancestor}`)
    }
    const components = suffix.split(sep)
    const name = components.pop()
    if (!name) throw new Error(`${path} has no file name`)
    const opened = ContainedDirectory.openExisting(selected, [], { noFollowBase: false })
    if (!opened) throw new Error(`${ancestor} does not exist`)
    let directory: ContainedDirectory = opened
    let existingCount = 0
    try {
      for (const component of components) {
        const child = directory.openExistingChild(component)
        if (!child) break
        directory.close()
        directory = child
        existingCount += 1
      }
      const missingDirectories = components.slice(existingCount)
      const snapshot = missingDirectories.length === 0 ? directory.readFileSnapshot(name, maxBytes) : undefined
      const text = snapshot && snapshot.content.byteLength <= MAX_FILE_EDIT_BYTES ? decodeOptionalUtf8(snapshot.content) : undefined
      return new RetainedFileEditAuthority(path, directory, missingDirectories, name, snapshot, text, maxBytes)
    } catch (error) {
      directory.close()
      throw error
    }
  }


  existingSnapshot(): ContainedFileSnapshot {
    if (!this.snapshot) throw new Error(`${this.path} does not exist`)
    return this.snapshot
  }

  strictText(): string {
    if (this.text === undefined) throw new Error(`${this.path} is not valid UTF-8`)
    return this.text
  }

  encode(content: string): Buffer {
    const bytes = Buffer.from(utf8Encoder.encode(content))
    if (bytes.byteLength > MAX_FILE_EDIT_BYTES) throw new Error(`${this.path} exceeds the ${MAX_FILE_EDIT_BYTES}-byte edit limit`)
    return bytes
  }

  /** Checks the admitted directory identity and exact target snapshot without creating parents.
   * A missing parent must remain absent, not become a new directory supplied by another writer. */
  verifyPrecondition(): void {
    this.#requireOpen()
    this.#directory.requireSamePathAs(this.#parentPath)
    const firstMissing = this.#missingDirectories[0]
    if (firstMissing !== undefined) {
      if (this.#directory.hasEntry(firstMissing)) throw new Error(`${this.path} parent changed after admission`)
      return
    }
    const actual = this.#directory.readFileSnapshot(this.name, this.#maxBytes)
    if (!this.snapshot) {
      if (actual) throw new Error(`${this.path} is no longer absent`)
    } else if (!actual || !sameFileSnapshot(actual, this.snapshot)) {
      throw new Error(`${this.path} changed after admission`)
    }
  }

  /** Publishes bytes through the retained parent. Metadata defaults to the admitted target, or to a new project file's
   *  permissions when there is none, and can be overridden for a move destination. */
  publish(bytes: Uint8Array, publicationMetadata: ContainedFileMetadata | undefined = this.snapshot?.metadata ?? this.#newFileMetadata()): FileMutationAttemptResult {
    this.#requireOpen()
    const parentMaterializationStarted = this.mayCreateMissingParents
    try {
      this.#materializeParent()
      const pending = `.flywheel-edit.${process.pid}.${randomBytes(8).toString("hex")}`
      const result = this.#directory.publishFileBytesThrough(pending, this.name, bytes, this.snapshot, publicationMetadata)
      return result.status === "not_applied" && parentMaterializationStarted ? { ...result, status: "indeterminate" } : result
    } catch (error) {
      return {
        status: parentMaterializationStarted ? "indeterminate" : "not_applied",
        error: error instanceof Error ? error : new Error(String(error)),
      }
    }
  }

  /** Deletes the admitted existing target through the retained parent. */
  delete(): FileMutationAttemptResult {
    this.#requireOpen()
    if (!this.snapshot) return { status: "not_applied", error: new Error(`${this.path} was absent when deletion was admitted`) }
    return this.#directory.removeFileIfSnapshot(this.name, this.snapshot)
  }

  /** Reads through the retained parent and verifies exact bytes and requested access metadata. */
  readBackAndVerify(expectedBytes: Uint8Array, expectedMetadata: ContainedFileMetadata | undefined = this.snapshot?.metadata): ContainedFileSnapshot {
    this.#requireOpen()
    const actual = this.#directory.readFileSnapshot(this.name, Math.max(this.#maxBytes, expectedBytes.byteLength))
    if (!actual) throw new Error(`${this.path} is absent after publication`)
    if (!actual.content.equals(Buffer.from(expectedBytes))) throw new Error(`${this.path} contains different bytes after publication`)
    if (expectedMetadata && !sameFileMetadata(actual.metadata, expectedMetadata)) throw new Error(`${this.path} has different access metadata after publication`)
    return actual
  }

  /** Verifies through the retained parent that no entry occupies the target name. */
  verifyAbsent(): void {
    this.#requireOpen()
    if (this.#missingDirectories.length !== 0) return
    if (this.#directory.hasEntry(this.name)) throw new Error(`${this.path} is not absent after publication`)
  }

  /** Returns the exact access metadata of a new project file when it can be known before an add. */
  defaultPublicationMetadata(): ContainedFileMetadata | undefined {
    this.#requireOpen()
    return this.#newFileMetadata()
  }

  /** A project file is the user's, so a new one gets the permissions the user's own tools would give it, 0666 less
   *  the umask, not the owner-only default the contained directory gives Flywheel's private files. */
  #newFileMetadata(): ContainedFileMetadata | undefined {
    const backend = this.#directory.defaultFileMetadata()
    return backend?.kind === "posix" ? { kind: "posix", mode: 0o666 & ~process.umask() } : backend
  }
  close(): void {
    if (this.#closed) return
    this.#closed = true
    this.#directory.close()
  }

  #materializeParent(): void {
    for (const component of this.#missingDirectories) {
      const child = this.#directory.openChild(component, { defaultPermissions: true })
      this.#directory.close()
      this.#directory = child
    }
  }

  #requireOpen(): void {
    if (this.#closed) throw new Error(`${this.path} file edit authority is closed`)
  }
}


function deepestExistingParent(target: string): string {
  let candidate = dirname(target)
  for (;;) {
    const directory = ContainedDirectory.openExisting(candidate, [], { noFollowBase: false })
    if (directory) {
      directory.close()
      return candidate
    }
    const parent = dirname(candidate)
    if (parent === candidate) throw new Error(`${target} has no existing parent directory`)
    candidate = parent
  }
}

function decodeOptionalUtf8(content: Uint8Array): string | undefined {
  try { return utf8Decoder.decode(content) } catch { return undefined }
}

