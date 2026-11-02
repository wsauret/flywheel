import type { SessionCatalogError } from "../../protocol/app-service-types.js"

function errorKey(error: SessionCatalogError): string {
  return JSON.stringify([error.sessionId, error.scope, error.reason])
}

function sameErrors(left: readonly SessionCatalogError[], right: readonly SessionCatalogError[]): boolean {
  if (left.length !== right.length) return false
  const leftKeys = left.map(errorKey).toSorted()
  const rightKeys = right.map(errorKey).toSorted()
  return leftKeys.every((key, index) => key === rightKeys[index])
}

/** Restates the errors that one owner reports for `sessionIds` in its scopes,
 *  keeping every other error. Returns the new list and the first of those
 *  sessions whose own errors changed, or undefined when the list is unchanged. */
export function replaceOwnedCatalogErrors(
  current: readonly SessionCatalogError[],
  sessionIds: readonly string[],
  refreshed: readonly SessionCatalogError[],
  scopes: ReadonlySet<SessionCatalogError["scope"]>,
): { readonly errors: readonly SessionCatalogError[]; readonly changedId: string | undefined } | undefined {
  const requested = new Set(sessionIds)
  const isOwned = (error: SessionCatalogError) => requested.has(error.sessionId) && scopes.has(error.scope)
  const next = [
    ...current.filter((error) => !isOwned(error)),
    ...refreshed.filter(isOwned),
  ]
  if (sameErrors(current, next)) return undefined
  const changedId = sessionIds.find((sessionId) => {
    const prior = current.filter((error) => error.sessionId === sessionId && isOwned(error))
    const replacement = next.filter((error) => error.sessionId === sessionId && isOwned(error))
    return !sameErrors(prior, replacement)
  })
  return { errors: next, changedId }
}
