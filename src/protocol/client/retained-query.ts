import { errorMessage } from "../../infra/error-message.js"

export interface QueryReading<T, E = string> {
  readonly key: string
  readonly value: T | undefined
  readonly error: E | undefined
}

/** Runs one validated client query and returns a non-throwing reading. A failed
 * refresh retains the prior value only for the same key, never another scope.
 * The reading's error is the failure's message, or what `describe` makes of
 * the failure. */
export function readRetainedQuery<T>(key: string, query: () => Promise<T>, previous?: QueryReading<T>): Promise<QueryReading<T>>
export function readRetainedQuery<T, E>(key: string, query: () => Promise<T>, previous: QueryReading<T, E> | undefined, describe: (cause: unknown) => E): Promise<QueryReading<T, E>>
export async function readRetainedQuery<T, E>(key: string, query: () => Promise<T>, previous?: QueryReading<T, E | string>, describe: (cause: unknown) => E | string = errorMessage): Promise<QueryReading<T, E | string>> {
  try {
    return { key, value: await query(), error: undefined }
  } catch (cause) {
    return { key, value: previous?.key === key ? previous.value : undefined, error: describe(cause) }
  }
}
