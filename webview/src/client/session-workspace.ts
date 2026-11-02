import type { RuntimeConnection } from "../../../src/protocol/client/connection.js"
import { createReadRetry } from "../../../src/protocol/client/background-reads.js"

/** Reads workspace metadata without replacing retained state after disposal or a failed read.
 * A lost lane is silent because the next lane reads the workspace again. */
export function createWorkspaceReader(options: {
  readonly connection: Pick<RuntimeConnection, "query">
  readonly isDisposed: () => boolean
  readonly changed: () => void
}) {
  const retries = new Map<string, ReturnType<typeof createReadRetry>>()
  async function refresh<T>(label: string, read: () => Promise<T>, apply: (value: T) => void): Promise<void> {
    if (options.isDisposed()) return
    let retry = retries.get(label)
    if (retry === undefined) {
      retry = createReadRetry(options.connection, label, () => { void refresh(label, read, apply) })
      retries.set(label, retry)
    }
    try {
      const value = await read()
      if (options.isDisposed()) return
      apply(value)
      retry.succeeded()
      options.changed()
    } catch (cause) {
      if (!options.isDisposed()) retry.failed(cause)
    }
  }
  return Object.assign(refresh, { dispose() { for (const retry of retries.values()) retry.dispose(); retries.clear() } })
}
