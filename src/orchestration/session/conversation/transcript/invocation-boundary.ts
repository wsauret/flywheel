const INVOCATION_BOUNDARY_SUFFIX = ":boundary"

/** The id of the divider that shows the skill or step invocation of the
 *  conversation entry `entryId` in the transcript. A live display gives the
 *  divider of a saved message the same id, so that a display refresh can
 *  tell the divider of a queued message from a stored one. */
export function invocationBoundaryId(entryId: string): string {
  return `${entryId}${INVOCATION_BOUNDARY_SUFFIX}`
}

/** Whether `id` names the divider of an invocation, as `invocationBoundaryId` makes it. */
export function isInvocationBoundaryId(id: string): boolean {
  return id.endsWith(INVOCATION_BOUNDARY_SUFFIX)
}
