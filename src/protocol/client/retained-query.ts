import { errorMessage } from "../../infra/error-message.js"

export interface QueryReading<T> {
  readonly key: string
  readonly value: T | undefined
  readonly error: string | undefined
}

/** Runs one validated client query and returns a non-throwing reading. A failed
 * refresh retains the prior value only for the same key, never another scope. */
export async function readRetainedQuery<T>(key: string, query: () => Promise<T>, previous?: QueryReading<T>): Promise<QueryReading<T>> {
  try {
    return { key, value: await query(), error: undefined }
  } catch (cause) {
    return { key, value: previous?.key === key ? previous.value : undefined, error: errorMessage(cause) }
  }
}
