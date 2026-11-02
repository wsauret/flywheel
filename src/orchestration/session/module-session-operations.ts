import { installedModules, workflowRunOwner, workflowRunReader } from "../module-catalog.js"
import type { ChildSessionPorts, ChildStopAnswer, ModuleChildSession, ModuleChildSessionHistory, ModuleRetainedOperationAuthority, ModuleRetainedOperationContribution, ModuleSessionDeletion } from "../module-seams.js"
import type { FirstPartyModule } from "../modules.js"
import type { SessionManager } from "./manager.js"
import type { ReplayedSession } from "./schemas.js"
import { readToolExecution } from "./tool-execution-projection.js"

export function installedChildSessionHistory(modules: readonly FirstPartyModule[] = installedModules()): ModuleChildSessionHistory {
  const histories = modules.flatMap((module) => module.childSessionHistory ? [module.childSessionHistory] : [])
  if (histories.length !== 1) throw new Error(`Expected one installed child-session history owner, found ${histories.length}`)
  const history = histories[0]
  if (!history) throw new Error("Installed child-session history owner is missing")
  return history
}

/** Installed module owners that can prove deterministic continuation work. */
export function retainedOperationContinuations() {
  return installedModules().flatMap((module) =>
    (module.retainedOperations ?? []).flatMap((operation) =>
      operation.continuation ? [operation.continuation] : []))
}

export function installedSessionAdmission() {
  return installedModules().flatMap((module) => module.sessionAdmission ? [module.sessionAdmission] : [])
}

/** In-flight kinds whose acceptance or retirement changes session controls. */
export function retainedOperationKinds(): readonly string[] {
  return installedModules().flatMap((module) => (module.retainedOperations ?? []).map((operation) => operation.kind))
}

/** Binds every installed module's retained-operation authority over one
 *  composition's reader, writer, and hosts. The kinds the state Worker admits
 *  (`retainedOperationKinds`) come from the same installed list, so each
 *  admitted kind has exactly one authority here. */
export function bindRetainedOperations(input: Parameters<ModuleRetainedOperationContribution["bind"]>[0]): readonly ModuleRetainedOperationAuthority[] {
  return installedModules().flatMap((module) => (module.retainedOperations ?? []).map((operation) => operation.bind(input)))
}

export async function hasPendingRetainedOperation(
  reader: Parameters<ModuleRetainedOperationContribution["pending"]>[0],
  sessionId: string,
  conversationId: string,
): Promise<boolean> {
  for (const module of installedModules()) {
    for (const operation of module.retainedOperations ?? []) {
      if (await operation.pending(reader, sessionId, conversationId)) return true
    }
  }
  return false
}

/** Settles the installed kind owner without granting execution authority. */
export async function settleInstalledSessionDeletion(input: Parameters<ModuleSessionDeletion["settle"]>[0]): Promise<void> {
  for (const module of installedModules()) {
    if (module.sessionDeletion?.kind === input.session.kind) await module.sessionDeletion.settle(input)
  }
}

/** The settlement of a person's Stop of the child that one parent call
 *  launched, or undefined when the call launched no child or no installed
 *  module owns the child's kind, so the caller decides before it settles
 *  anything. */
export type SessionStops = (parentSessionId: string, toolUseId: string) => Promise<(() => Promise<ChildStopAnswer>) | undefined>

/** The installed owner of the children of one session kind, or nothing for
 *  a kind that no installed module launches as a child. */
export function installedChildSession(kind: ModuleChildSession["kind"]): ModuleChildSession | undefined {
  return installedModules().find((module) => module.childSession?.kind === kind)?.childSession
}

/** One current child of a parent session and its own metadata, whose launch
 *  binding names the parent and, for a call-launched child, the launching
 *  call. */
export interface LaunchedChild {
  readonly sessionId: string
  readonly session: Extract<ReplayedSession, { kind: "subagent" | "workflow-agent" }>
}

/** The current children of one parent, in link order, from the durable
 *  relationship that both sides record: the parent's live link and the
 *  child's launch binding to that parent. `unreadable` counts the linked
 *  sessions whose metadata does not read, so their launching calls are
 *  unknown. Store read failures propagate. */
export async function readLaunchedChildren(read: SessionManager["read"], parentSessionId: string): Promise<{ readonly children: readonly LaunchedChild[]; readonly unreadable: number }> {
  const linked = await Promise.all(((await read(parentSessionId))?.childSessionIds ?? []).map(async (sessionId) => ({ sessionId, session: await read(sessionId) })))
  const children: LaunchedChild[] = []
  let unreadable = 0
  for (const { sessionId, session } of linked) {
    if (!session) unreadable++
    else if ((session.kind === "subagent" || session.kind === "workflow-agent") && session.launchedFrom.parentSessionId === parentSessionId) children.push({ sessionId, session })
  }
  return { children, unreadable }
}

/** Binds every installed kind owner's Stop, a person's, over one
 *  composition's ports. It finds the child from the durable relationship
 *  that both sides record, never from a runner's memory. Only a call that
 *  opens a child's own view can have launched one, so the Stop of any other
 *  call, such as a background command's, reads no child. */
export function bindSessionStops(input: ChildSessionPorts & { readonly read: SessionManager["read"] }): SessionStops {
  const { read, ...ports } = input
  return async (parentSessionId, toolUseId) => {
    if ((await readToolExecution(input.projectionReader, parentSessionId, toolUseId))?.childHasOwnViewport !== true) return undefined
    const { children } = await readLaunchedChildren(read, parentSessionId)
    const workflow = (await workflowRunReader(input.projectionReader).listForParent(parentSessionId))
      .find(({ run }) => run.launchedFrom.toolUseId === toolUseId)
    if (workflow) return () => workflowRunOwner().work.stop({ ...ports, ...workflow, by: "person" })
    const child = children.find(({ session }) => session.kind === "subagent" && session.launchedFrom.toolUseId === toolUseId)
    if (!child || child.session.kind !== "subagent") return undefined
    const owner = installedChildSession(child.session.kind)
    return owner ? () => owner.stop({ ...ports, ...child, by: "person" }) : undefined
  }
}
