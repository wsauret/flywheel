const LOCAL_ID = /^[a-z0-9][a-z0-9_-]*$/u

/** Validate a workflow-local name. Dots delimit references; global command
 * reservations do not apply inside a workflow. */
export function isWorkflowLocalId(value: string): boolean {
  return LOCAL_ID.test(value)
}

/** Validate a brief id, which names a brief's model seat. A file basename
 * or an inline workflow/record pair consists of dot-separated local names. */
export function isBriefId(value: string): boolean {
  return value.split(".").every(isWorkflowLocalId)
}
