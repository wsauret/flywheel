import { asAsyncEventReadSurface, asAsyncEventWriter } from "../../../../src/infra/event-store-types"
import type { ChatInput } from "../../../../src/infra/chat-input"
import { createBackgroundWorkRegistry, type BackgroundWorkRegistry } from "../../../../src/orchestration/agent-runtime/background-work"
import { createMessageSessionTool } from "../../../../src/orchestration/agent-runtime/tools/message-session"
import type { ToolContext } from "../../../../src/orchestration/agent-runtime/tools/types"
import { createConversationTreeWriterController } from "../../../../src/orchestration/chat/tree-writer"
import { holdQueuedBackgroundNotification, type HeldBackgroundNotification } from "../../../../src/orchestration/session/conversation/queued-background-notifications"
import { dropQueuedUserInput } from "../../../../src/orchestration/session/conversation/queued-user-inputs"
import { retireAddressedWorkflowMessages } from "../../../../src/orchestration/session/conversation/addressed-workflow-messages"
import { registerLiveSessionControl, type LiveRecipientState } from "../../../../src/orchestration/session/live-session-control"
import { createSessionManager } from "../../../../src/orchestration/session/manager"
import { executeChildSessionDeletionPlan } from "../../../../src/orchestration/session/child-session-deletion"
import { createSessionMessaging, type SessionMessaging } from "../../../../src/orchestration/session/session-messaging"
import { workflowParentBinding } from "../../../helpers/workflow-parent"
import { cleanupTmpRoot, makeDepsWithStore, makeTmpDir, publishTestWorkflow, startTestWorkflowMember } from "./_session-manager-fixtures"
import { unusedChildSessionControl } from "../../../helpers/child-session-control.js"

export const REPLY_WAIT_KIND = "session.reply_wait"
export const unregisters: (() => void)[] = []

/** Ends a test: unregisters its live sessions, lets the waits on them end,
 *  and removes its stores. */
export async function cleanupReplyWaitTest(): Promise<void> {
  for (const unregister of unregisters.splice(0)) unregister()
  // A session that leaves the registry ends the waits on it, which reads the store.
  await settle()
  cleanupTmpRoot()
}

/** The work the microtasks of a settled wait finish before the next step. */
export function settle(): Promise<void> {
  return new Promise<void>((resolve) => { setTimeout(resolve, 0) })
}

/** A reader of the same store that another runtime of the project holds, as
 *  a successor or a restarted service does. */
export function anotherRuntimeReader(here: Project): Project["reader"] {
  return { ...here.reader }
}

export function project() {
  const root = makeTmpDir()
  const { deps, store } = makeDepsWithStore(root)
  const reader = asAsyncEventReadSurface(store)
  const writer = asAsyncEventWriter(store)
  const manager = createSessionManager({ ...deps, projectionReader: reader })
  // A parent's message to its interrupted child stays held: these waits
  // read no person's or parent's cut, so no hand-back resumes the child.
  const children = unusedChildSessionControl({ resume: async () => ({ ok: false, error: "This test continues no child." }) })
  const runtime = (projectionReader = reader): SessionMessaging => createSessionMessaging({ manager, projectionReader, eventWriter: writer }, children)
  const replyWaitCells = (sessionId: string) => store.readInFlight(sessionId, REPLY_WAIT_KIND)
  return { root, store, reader, writer, manager, messaging: runtime(), runtime, replyWaitCells }
}

type Project = ReturnType<typeof project>

/** Publishes an ordinary member of a workflow owned by this chat. */
export async function childWorkflow(here: Project, parentSessionId: string, name: string): Promise<string> {
  const workflowId = await publishTestWorkflow(here.manager, { name, launchedFrom: await workflowParentBinding(here.manager, { workflowDefinitionId: "fixture-workflow", parentSessionId }) })
  const member = await startTestWorkflowMember(here.manager, here.store, workflowId)
  await here.manager.updateLabel(member, { label: name, shortLabel: name }, "user")
  return member
}

/** A person's delete of `sessionId`, as the process that runs the sessions executes it. */
export async function deleteSession(here: Project, sessionId: string): Promise<void> {
  await executeChildSessionDeletionPlan({
    projectRoot: here.root, reader: here.reader, projectionReader: here.reader, writer: here.writer, read: here.manager.read,
    finalizeDeletionTarget: here.manager.finalizeDeletionTarget,
  }, await here.manager.admitDeletion(sessionId))
}

/** One live session as the test sees it. */
interface LiveTestSession {
  state: LiveRecipientState
  readonly received: ChatInput[]
  readonly notified: HeldBackgroundNotification[]
  readonly notices: { readonly text: string; readonly key?: string; readonly runtimeNotice?: true }[]
  readonly tasks: BackgroundWorkRegistry
}

/** One live session: a control whose state the test sets, which records the
 *  messages and notices it receives, and the background work of its run,
 *  which holds each notice in the session's conversation as a run does. */
export function live(here: Project, sessionId: string): LiveTestSession {
  const notices: LiveTestSession["notices"] = []
  const session: LiveTestSession = {
    state: "running",
    received: [],
    notified: [],
    notices,
    tasks: createBackgroundWorkRegistry({
      kind: "chat",
      enqueueNotification: (text, key, runtimeNotice) => {
        notices.push({ text, ...(key ? { key } : {}), ...(runtimeNotice ? { runtimeNotice: true as const } : {}) })
        void holdQueuedBackgroundNotification(here.writer, sessionId, `${sessionId}-conversation`, text, key)
      },
    }),
  }
  unregisters.push(registerLiveSessionControl(here.reader, {
    sessionId,
    state: async () => session.state,
    deliver: async (input, decide) => {
      session.received.push(input)
      return decide(session.state)
    },
    notify: async (notification) => {
      session.notified.push(notification)
      return true
    },
  }))
  return session
}

/** Tracks a running child in the background work of its parent, as a
 *  dispatch does. The child runs until the test ends. */
export function runChild(tasks: BackgroundWorkRegistry, childSessionId: string): void {
  tasks.track({
    done: new Promise(() => {}),
    meta: { id: `${childSessionId}-run`, type: "subagent", settlementOwner: "child_session", description: childSessionId, model: "test-model", roleSessionId: childSessionId, toolUseId: `${childSessionId}-tool` },
    kill: { run: () => {} },
  })
}

function context(sessionId: string, toolUseId: string): ToolContext {
  return {
    executionCwd: "/scratch",
    userDataRoot: "/scratch/.test-account", projectRoot: "/scratch",
    artifactScopeId: sessionId,
    retrievalSessionId: sessionId,
    sessionId,
    conversationId: `${sessionId}-conversation`,
    toolUseId,
  }
}

export async function message(messaging: SessionMessaging, from: { readonly id: string; readonly tasks?: BackgroundWorkRegistry }, toolUseId: string, input: { readonly to: string; readonly text?: string; readonly wait?: boolean }) {
  const sender = await messaging.identity(from.id)
  const result = await createMessageSessionTool(messaging, from.tasks).execute({ target: "session", ...input }, { ...context(from.id, toolUseId), conversationId: sender?.conversationId ?? `${from.id}-conversation` })
  await settle()
  return result
}

/** The addressee reads a message: its run commits the held cell, or, for a
 *  workflow, a commit records the message and retires its addressed cell. */
export async function read(here: Project, sessionId: string, senderSessionId: string, toolUseId: string): Promise<void> {
  const key = `msg:${senderSessionId}:${toolUseId}`
  await dropQueuedUserInput(here.writer, sessionId, key)
  await retireAddressedWorkflowMessages(here.writer, sessionId, [key])
}

export async function conversationOf(here: Project, sessionId: string) {
  const session = await here.manager.read(sessionId)
  if (session?.kind !== "chat") throw new Error(`${sessionId} is not a chat`)
  return createConversationTreeWriterController({ sessionId, conversationId: session.conversationId, projectRoot: here.root, store: here.reader, projectionReader: here.reader, writer: here.writer })
}
