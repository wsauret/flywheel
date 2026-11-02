import { decodeInputReloadCheckpoint, type InputReloadCheckpoint, type InputReloadStorage } from "./input-reload-checkpoint.js"

/** The payload is not quota-bound sessionStorage. Only this tab's small id is. */
export function browserInputReloadStorage(scope: string | (() => string)): InputReloadStorage {
  const tabKey = "flywheel.client.tab"
  let database: Promise<IDBDatabase> | undefined
  const key = (currentScope: string) => {
    let tab = sessionStorage.getItem(tabKey)
    if (tab === null) { tab = crypto.randomUUID(); sessionStorage.setItem(tabKey, tab) }
    return `${tab}\u0000${currentScope}`
  }
  const open = () => {
    database ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("flywheel.client.input-reload", 1)
    request.addEventListener("upgradeneeded", () => { request.result.createObjectStore("checkpoints") })
    request.addEventListener("success", () => resolve(request.result))
    request.addEventListener("error", () => reject(new Error("Input checkpoint storage is unavailable")))
    })
    return database
  }
  const transaction = async (mode: IDBTransactionMode, operation: (store: IDBObjectStore, key: string) => IDBRequest): Promise<InputReloadCheckpoint | undefined> => {
    const currentScope = typeof scope === "string" ? scope : scope()
    const id = key(currentScope)
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

/** Native editor state stays opaque to the extension and uses the same transfer contract. */
// oxlint-disable-next-line anti-slop/no-unknown-returns -- boundary: native VS Code state is untrusted until decoded below
export function editorInputReloadStorage(api: { getState(): unknown; setState(state: unknown): void }, scope: string): InputReloadStorage {
  return {
    load: async () => decodeInputReloadCheckpoint(api.getState(), scope),
    save: async (checkpoint: InputReloadCheckpoint) => {
      api.setState(checkpoint)
    },
    consume: async () => { api.setState(undefined) },
  }
}
