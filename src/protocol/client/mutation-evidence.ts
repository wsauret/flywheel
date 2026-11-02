import type { MutationFilesEntry } from "../mutation-evidence-protocol-types.js"
import type { SessionContentManifestReference, SessionContentReference } from "../../infra/session-content.js"
import type { RuntimeConnection } from "./connection.js"
import type { RuntimeQuery, RuntimeQueryResult } from "../app-service-types.js"
import { errorMessage } from "../../infra/error-message.js"

// Callers pass references read from reactive client stores. The protocol encoder rejects store
// proxies, so the reader keeps its own plain copy of every reference it owns.
function plainManifest({ version, root, bytes, entries }: SessionContentManifestReference): SessionContentManifestReference {
  return { version, root, bytes, entries }
}

function plainReference({ version, root, bytes, sha256 }: SessionContentReference): SessionContentReference {
  return { version, root, bytes, sha256 }
}

type EvidenceReadStatus = "idle" | "loading" | "ready" | "unavailable" | "error"
interface PatchSelection {
  view: MutationPatchView
  decoder: TextDecoder
  pending?: Promise<void>
}
interface PatchOwner {
  reference: SessionContentReference
  handle: MutationPatchHandle
  clear: () => void
}
export interface MutationFilesView {
  readonly status: EvidenceReadStatus
  readonly offset: number
  readonly files: readonly MutationFilesEntry[]
  readonly nextOffset: number | null
  readonly message?: string
}
interface MutationEvidenceOpenOptions {
  /** Pages carry each retained file's collapsed preview, for a surface that renders collapsed rows. */
  readonly previews?: boolean
}
export interface MutationPatchView {
  readonly status: EvidenceReadStatus
  readonly reference: SessionContentReference
  readonly text: string
  readonly nextOffset: number | null
  readonly complete: boolean
  readonly message?: string
}
export interface MutationEvidenceHandle {
  readonly files: MutationFilesView
  /** Append the next bounded metadata page. Earlier pages and patch handles stay held.
   * files.nextOffset names the loaded extent; null after a ready page means all files are loaded. */
  loadFiles(): Promise<void>
  /** Acquire a passive file handle by mutation identity and patch reference.
   * Omitted, unavailable and not-applied entries have no readable patch. */
  patch(file: MutationFilesEntry): MutationPatchHandle | undefined
}
export interface MutationPatchHandle {
  readonly view: MutationPatchView
  /** Append enough byte windows for this many additional displayed rows.
   * Partial final lines are visible. Complete means length and SHA-256 were verified. */
  continue(displayRows?: number, columns?: number): Promise<void>
  /** Release this file's prefix. This handle becomes inert; acquire a new handle to reopen. */
  release(): void
}
export interface MutationEvidenceReader {
  /** Whether an owner holds evidence, without measuring its payload. */
  readonly hasOwners: boolean
  /** Estimated resident payload bytes, including decoded UTF-16 patch prefixes. */
  readonly heldBytes: number
  /** Reuse an owner and immutable manifest; replacing its root releases the old handle, and so
   * does asking for previews from a handle without them. A handle with previews serves every opener.
   * Transcript callers use the owning block's id, including a group child's id. */
  open(ownerId: string, manifest: SessionContentManifestReference, options?: MutationEvidenceOpenOptions): MutationEvidenceHandle
  /** Passive display-only patch owner. A derived patch has no mutation or Undo authority. */
  openPatch(ownerId: string, reference: SessionContentReference): MutationPatchHandle
  /** Drop one owner or all owners. Released handles are inert; reopen on disclosure. */
  release(ownerId?: string): void
  retainOwners(ownerIds: ReadonlySet<string>): void
  /** Observe publications. The listener receives the ids of the owners whose evidence changed,
   * or undefined when every owner changed at once. */
  onChange(listener: (owners: ReadonlySet<string> | undefined) => void): () => void
  dispose(): void
}

const WINDOW_BYTES = 65_536
const unavailableMessage = "Change evidence is unavailable"
class CorruptEvidence extends Error {}
const sameManifest = (a: SessionContentManifestReference, b: SessionContentManifestReference): boolean =>
  a.version === b.version && a.root === b.root && a.bytes === b.bytes && a.entries === b.entries
const sameReference = (a: SessionContentReference, b: SessionContentReference): boolean =>
  a.version === b.version && a.root === b.root && a.bytes === b.bytes && a.sha256 === b.sha256

function displayedRows(text: string, columns: number): number {
  return text.split("\n").reduce((rows, line, index, lines) =>
    rows + (index === lines.length - 1 && line.length === 0 ? 0 : Math.max(1, Math.ceil(line.length / columns))), 0)
}

function pendingRead<T>(reads: Map<string, Promise<T>>, key: string, read: () => Promise<T>): Promise<T> {
  const held = reads.get(key)
  if (held) return held
  const request = read().finally(() => { if (reads.get(key) === request) reads.delete(key) })
  reads.set(key, request)
  return request
}

/** Passive session-owned evidence. Opening a handle does not request content.
 * Each owner holds acquired metadata pages and independently releasable file prefixes.
 * Only in-flight transport reads are shared across owners. Release invalidates pending reads. */
export function createMutationEvidenceReader(options: { readonly connection: Pick<RuntimeConnection, "query">; readonly sessionId: string }): MutationEvidenceReader {
  const owners = new Map<string, { manifest: SessionContentManifestReference; previews: boolean; handle: MutationEvidenceHandle; bytes: () => number; clear: () => void }>()
  const patchOwners = new Map<string, PatchOwner>()
  const listeners = new Set<(owners: ReadonlySet<string> | undefined) => void>()
  const fileReads = new Map<string, Promise<RuntimeQueryResult<Extract<RuntimeQuery, { type: "mutationFiles" }>>>>()
  const patchReads = new Map<string, Promise<RuntimeQueryResult<Extract<RuntimeQuery, { type: "mutationPatchWindow" }>>>>()
  let disposed = false
  const emit = (changedOwners: ReadonlySet<string> | undefined): void => { for (const listener of listeners) listener(changedOwners) }
  const changed = (ownerId: string): void => emit(new Set([ownerId]))
  const encoder = new TextEncoder()

  function createPatch(ownerId: string, patchReference: SessionContentReference, current: () => boolean, release: () => void) {
    const initial: MutationPatchView = { status: "idle", reference: patchReference, text: "", nextOffset: 0, complete: false }
    const selection: PatchSelection = {
      view: initial, decoder: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }),
    }
    const handle: MutationPatchHandle = {
      get view() { return selection.view },
      continue(displayRows = 20, columns = 120) {
        if (!current() || selection.view.complete || selection.view.status === "unavailable") return Promise.resolve()
        if (selection.pending) return selection.pending
        const rows = Math.max(1, Math.floor(displayRows))
        const width = Math.max(1, Math.floor(columns))
        const targetRows = displayedRows(selection.view.text, width) + rows
        selection.view = { ...selection.view, status: "loading" }
        const request = (async () => {
          try {
            do {
              const { reference, nextOffset } = selection.view
              const offset = nextOffset ?? reference.bytes
              if (!current()) return
              const result = await pendingRead(patchReads, JSON.stringify([reference.version, reference.root, reference.bytes, reference.sha256, offset]), () =>
                options.connection.query({ type: "mutationPatchWindow", sessionId: options.sessionId, reference, offset, maxBytes: WINDOW_BYTES }))
              if (!current()) return
              if (result.sessionId !== options.sessionId || !sameReference(result.reference, reference) || result.requestedOffset !== offset) throw new CorruptEvidence()
              if (encoder.encode(JSON.stringify(result)).length > WINDOW_BYTES) throw new CorruptEvidence()
              if (result.kind === "unavailable") throw new CorruptEvidence()
              let bytes: Uint8Array
              try { bytes = Uint8Array.from(atob(result.base64), (char) => char.charCodeAt(0)) } catch { throw new CorruptEvidence() }
              const end = offset + bytes.length
              if (result.offset !== offset || result.totalBytes !== reference.bytes || result.servedBytes !== bytes.length
                || bytes.length > WINDOW_BYTES || end > reference.bytes
                || result.nextOffset !== (end === reference.bytes ? null : end)
                || (bytes.length === 0 && end !== reference.bytes)) throw new CorruptEvidence()
              let suffix: string
              try { suffix = selection.decoder.decode(bytes, { stream: result.nextOffset !== null }) } catch { throw new CorruptEvidence() }
              const text = selection.view.text + suffix
              if (result.nextOffset === null) {
                const completeBytes = encoder.encode(text)
                const digest = await crypto.subtle.digest("SHA-256", completeBytes)
                if (!current()) return
                const hash = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")
                if (completeBytes.length !== reference.bytes || hash !== reference.sha256) throw new CorruptEvidence()
              }
              selection.view = { status: "loading", reference, text, nextOffset: result.nextOffset, complete: result.nextOffset === null }
              changed(ownerId)
            } while (!selection.view.complete && displayedRows(selection.view.text, width) < targetRows)
            selection.view = { ...selection.view, status: "ready" }
          } catch (cause) {
            if (!current()) return
            if (cause instanceof CorruptEvidence) selection.view = { ...selection.view, status: "unavailable", text: "", complete: false, message: unavailableMessage }
            else selection.view = { ...selection.view, status: "error", message: errorMessage(cause) }
          } finally {
            selection.pending = undefined
            if (current()) changed(ownerId)
          }
        })()
        selection.pending = request
        changed(ownerId)
        return request
      },
      release() {
        if (!current()) return
        selection.view = initial
        release()
        changed(ownerId)
      },
    }
    return { handle, clear: () => { selection.view = initial } }
  }

  function open(ownerId: string, storeManifest: SessionContentManifestReference, openOptions: MutationEvidenceOpenOptions = {}): MutationEvidenceHandle {
    const manifest = plainManifest(storeManifest)
    const previews = openOptions.previews === true
    const held = owners.get(ownerId)
    if (held && sameManifest(held.manifest, manifest) && (held.previews || !previews)) return held.handle
    held?.clear()
    let files: MutationFilesView = { status: "idle", offset: 0, files: [], nextOffset: null }
    const patches = new Map<string, { handle: MutationPatchHandle; clear: () => void }>()
    let pageRequest: Promise<void> | undefined
    const alive = (): boolean => !disposed && owners.get(ownerId)?.handle === handle
    const handle: MutationEvidenceHandle = {
      get files() { return files },
      loadFiles() {
        if (!alive()) return Promise.resolve()
        if (pageRequest) return pageRequest
        if (files.status === "ready" && files.nextOffset === null) return Promise.resolve()
        const offset = files.files.length
        files = { ...files, status: "loading" }
        const request = (async () => {
          try {
            const result = await pendingRead(fileReads, JSON.stringify([manifest.version, manifest.root, manifest.bytes, manifest.entries, offset, previews]), () =>
              options.connection.query({ type: "mutationFiles", sessionId: options.sessionId, manifest, offset, maxFiles: 128, maxBytes: WINDOW_BYTES, ...(previews ? { previews } : {}) }))
            if (!alive()) return
            if (result.sessionId !== options.sessionId || !sameManifest(result.manifest, manifest) || result.requestedOffset !== offset) throw new CorruptEvidence()
            if (encoder.encode(JSON.stringify(result)).length > WINDOW_BYTES) throw new CorruptEvidence()
            if (result.kind === "unavailable") throw new CorruptEvidence()
            const end = offset + result.files.length
            if (result.offset !== offset || result.totalFiles !== manifest.entries || result.totalBytes !== manifest.bytes
              || result.files.length > 128 || end > manifest.entries
              || result.nextOffset !== (end === manifest.entries ? null : end)
              || (result.files.length === 0 && result.nextOffset !== null)) throw new CorruptEvidence()
            files = { status: "ready", offset: 0, files: [...files.files, ...result.files], nextOffset: result.nextOffset }
          } catch (cause) {
            if (!alive()) return
            files = { ...files, status: cause instanceof CorruptEvidence ? "unavailable" : "error", message: cause instanceof CorruptEvidence ? unavailableMessage : errorMessage(cause) }
          } finally {
            if (alive()) { pageRequest = undefined; changed(ownerId) }
          }
        })()
        pageRequest = request
        changed(ownerId)
        return request
      },
      patch(entry) {
        if (!alive() || (entry.kind !== "applied" && entry.kind !== "display")) return undefined
        const patch = entry.file.patch
        if (patch.kind !== "retained") return undefined
        const { reference } = patch
        const key = JSON.stringify([entry.file.mutationId, entry.file.path, reference.version, reference.root, reference.bytes, reference.sha256])
        const heldPatch = patches.get(key)
        if (heldPatch) return heldPatch.handle
        const selected = createPatch(ownerId, reference, () => alive() && patches.get(key) === selected, () => { patches.delete(key) })
        patches.set(key, selected)
        changed(ownerId)
        return selected.handle
      },
    }
    if (!disposed) {
      owners.set(ownerId, {
        manifest, previews, handle,
        bytes: () => JSON.stringify(files).length * 2 + Array.from(patches.values()).reduce((sum, patch) => sum + JSON.stringify(patch.handle.view).length * 2, 0),
        clear: () => {
          files = { status: "idle", offset: 0, files: [], nextOffset: null }
          for (const patch of patches.values()) patch.clear()
          patches.clear()
          pageRequest = undefined
        },
      })
      if (held) changed(ownerId)
    }
    return handle
  }

  return {
    get hasOwners() { return owners.size > 0 || patchOwners.size > 0 },
    get heldBytes() {
      return Array.from(owners.values()).reduce((total, owner) => total + owner.bytes(), 0)
        + Array.from(patchOwners.values()).reduce((total, patch) => total + JSON.stringify(patch.handle.view).length * 2, 0)
    },
    open,
    openPatch(ownerId, storeReference) {
      const reference = plainReference(storeReference)
      const held = patchOwners.get(ownerId)
      if (held && sameReference(held.reference, reference)) return held.handle
      held?.clear()
      const selected: PatchOwner = { reference, ...createPatch(ownerId, reference, () => !disposed && patchOwners.get(ownerId) === selected, () => { patchOwners.delete(ownerId) }) }
      if (!disposed) patchOwners.set(ownerId, selected)
      return selected.handle
    },
    release(ownerId) {
      if (ownerId === undefined) {
        if (owners.size === 0 && patchOwners.size === 0) return
        for (const owner of owners.values()) owner.clear()
        for (const patch of patchOwners.values()) patch.clear()
        owners.clear()
        patchOwners.clear()
        emit(undefined)
      } else {
        const owner = owners.get(ownerId)
        const patch = patchOwners.get(ownerId)
        if (!owner && !patch) return
        owner?.clear()
        patch?.clear()
        owners.delete(ownerId)
        patchOwners.delete(ownerId)
        changed(ownerId)
      }
    },
    retainOwners(ownerIds) {
      const dropped = new Set<string>()
      for (const [id, owner] of owners) if (!ownerIds.has(id)) { owner.clear(); owners.delete(id); dropped.add(id) }
      for (const [id, patch] of patchOwners) if (!ownerIds.has(id)) { patch.clear(); patchOwners.delete(id); dropped.add(id) }
      if (dropped.size > 0) emit(dropped)
    },
    onChange(listener) { listeners.add(listener); return () => { listeners.delete(listener) } },
    dispose() {
      disposed = true
      for (const owner of owners.values()) owner.clear()
      for (const patch of patchOwners.values()) patch.clear()
      owners.clear()
      patchOwners.clear()
      fileReads.clear()
      patchReads.clear()
      emit(undefined)
      listeners.clear()
    },
  }
}
