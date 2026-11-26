import { decodeInputReloadCheckpoint, type InputReloadCheckpoint, type InputReloadStorage } from "./input-reload-checkpoint.js"

const tabKey = "flywheel.client.tab"

/** This tab's record for `scope`. */
function checkpointKey(scope: string): string {
  let tab = sessionStorage.getItem(tabKey)
  if (tab === null) { tab = crypto.randomUUID(); sessionStorage.setItem(tabKey, tab) }
  return `${tab}\u0000${scope}`
}

function openCheckpoints(): Promise<IDBDatabase> {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("flywheel.client.input-reload", 1)
    request.addEventListener("upgradeneeded", () => { request.result.createObjectStore("checkpoints") })
    request.addEventListener("success", () => resolve(request.result))
    request.addEventListener("error", () => reject(new Error("Input checkpoint storage is unavailable")))
  })
}

/** The payload is not quota-bound sessionStorage. Only this tab's small id is. */
export function browserInputReloadStorage(scope: string | (() => string)): InputReloadStorage {
  let database: Promise<IDBDatabase> | undefined
  const open = () => {
    database ??= openCheckpoints()
    return database
  }
  const transaction = async (mode: IDBTransactionMode, operation: (store: IDBObjectStore, key: string) => IDBRequest): Promise<InputReloadCheckpoint | undefined> => {
    const currentScope = typeof scope === "string" ? scope : scope()
    const id = checkpointKey(currentScope)
    const db = await open()
    return new Promise((resolve, reject) => {
      const tx = db.transaction("checkpoints", mode)
      const request = operation(tx.objectStore("checkpoints"), id)
      tx.addEventListener("complete", () => {
        let checkpoint: InputReloadCheckpoint | undefined
        try { checkpoint = mode === "readonly" ? decodeInputReloadCheckpoint(request.result, currentScope) : undefined } catch (cause) { reject(cause); return }
        resolve(checkpoint)
      })
      const failed = () => reject(new Error("Input checkpoint storage failed"))
      tx.addEventListener("error", failed)
      tx.addEventListener("abort", failed)
    })
  }
  return {
    load: () => transaction("readonly", (store, id) => store.get(id)),
    save: async (value) => { await transaction("readwrite", (store, id) => store.put(value, id)) },
    consume: async () => { await transaction("readwrite", (store, id) => store.delete(id)) },
  }
}

/** Moves this tab's checkpoint from one scope to another, as its scope
 *  names the same place by a new id, unless the new scope holds one already.
 *  The phone names a project by an id that releases before 2026-11-25 gave
 *  it; remove after 2027-05-25, with `resolveLegacyPlacement`. */
export async function moveBrowserInputReload(from: string, to: string): Promise<void> {
  const db = await openCheckpoints()
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("checkpoints", "readwrite")
      const checkpoints = tx.objectStore("checkpoints")
      const source = checkpoints.get(checkpointKey(from))
      const target = checkpoints.get(checkpointKey(to))
      // Requests of one transaction succeed in order, so both have read here.
      target.addEventListener("success", () => {
        const checkpoint = decodeInputReloadCheckpoint(source.result, from)
        if (checkpoint === undefined) return
        if (target.result === undefined) checkpoints.put({ ...checkpoint, scope: to }, checkpointKey(to))
        checkpoints.delete(checkpointKey(from))
      })
      tx.addEventListener("complete", () => resolve())
      const failed = () => reject(new Error("Input checkpoint storage failed"))
      tx.addEventListener("error", failed)
      tx.addEventListener("abort", failed)
    })
  } finally {
    db.close()
  }
}

/** Native editor state stays opaque to the extension and uses the same transfer contract. */
// oxlint-disable-next-line anti-slop/no-unknown-returns -- boundary: native VS Code state is untrusted until decoded below
export function editorInputReloadStorage(api: { getState(): unknown; setState(state: InputReloadCheckpoint | undefined): void }, scope: string): InputReloadStorage {
  return {
    load: async () => decodeInputReloadCheckpoint(api.getState(), scope),
    save: async (checkpoint: InputReloadCheckpoint) => {
      api.setState(checkpoint)
    },
    consume: async () => { api.setState(undefined) },
  }
}
