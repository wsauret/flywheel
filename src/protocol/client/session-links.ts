const SESSION_PREFIX = "flywheel://session/"
const WORKFLOW_PREFIX = "flywheel://workflow/"
const AGENT_FRAGMENT = "#agent="

/** Opens an actual conversation session. Workflow aggregates use workflowLink. */
export function sessionLink(sessionId: string): string {
  return `${SESSION_PREFIX}${sessionId}`
}

/** Reads a session URI. Unrecognized protocols and empty addresses return undefined. */
export function parseSessionLink(uri: string | undefined): { readonly sessionId: string } | undefined {
  if (uri === undefined || !uri.startsWith(SESSION_PREFIX)) return undefined
  const rest = uri.slice(SESSION_PREFIX.length)
  const hash = rest.indexOf("#")
  const sessionId = hash === -1 ? rest : rest.slice(0, hash)
  if (sessionId === "") return undefined
  return { sessionId }
}

/** Opens workflow orchestration, optionally at one logical agent. */
export function workflowLink(workflowId: string, agentNodeId?: string): string {
  return `${WORKFLOW_PREFIX}${workflowId}${agentNodeId === undefined ? "" : `${AGENT_FRAGMENT}${encodeURIComponent(agentNodeId)}`}`
}

/** Reads only workflow URIs, never interpreting a workflow id as a session. */
export function parseWorkflowLink(uri: string | undefined): { readonly workflowId: string; readonly agent?: string } | undefined {
  if (uri === undefined || !uri.startsWith(WORKFLOW_PREFIX)) return undefined
  const rest = uri.slice(WORKFLOW_PREFIX.length)
  const hash = rest.indexOf("#")
  const workflowId = hash === -1 ? rest : rest.slice(0, hash)
  if (workflowId === "") return undefined
  const fragment = hash === -1 ? "" : rest.slice(hash)
  const agent = fragment.startsWith(AGENT_FRAGMENT) ? decodeURIComponent(fragment.slice(AGENT_FRAGMENT.length)) : ""
  return agent === "" ? { workflowId } : { workflowId, agent }
}
