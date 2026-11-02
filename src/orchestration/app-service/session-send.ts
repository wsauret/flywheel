import { normalizeChatInput } from "../../infra/chat-input.js"
import { errorMessage } from "../../infra/error-message.js"
import { Log } from "../../infra/log.js"
import type { FrontendMutation, MutationResult } from "../../protocol/app-service-types.js"
import type { ModuleProtocolRoutes } from "./module-protocol-host.js"
import type { RuntimeSupervisor } from "./runtime-supervisor-types.js"

const log = Log.create({ service: "session-send" })

/** The owners a person's message reaches, one for each kind of session. */
export interface SessionSendDeps {
  readonly supervisor: Pick<RuntimeSupervisor, "sessionKind" | "sendChat">
  readonly modules: Pick<ModuleProtocolRoutes, "send">
}

/** A person's message to any session (`session.send`). The runtime, not the
 *  client, reads the kind of the session and routes the message: a chat to
 *  its actor, which starts or joins a turn, and a child conversation to the
 *  module that owns its kind. A child delivers through `deliverSessionInput`, and a chat through the
 *  ordered send section of its actor. Each owner starts the work of an
 *  interrupted session again (PI-INTERACTION-050). */
export async function handleSessionSend(mutation: Extract<FrontendMutation, { type: "session.send" }>, deps: SessionSendDeps): Promise<MutationResult> {
  try {
    return await sendByKind(mutation, deps)
  } catch (error) {
    log.error("a person's message failed", { sessionId: mutation.sessionId, error: errorMessage(error) })
    return { ok: false, error: errorMessage(error) }
  }
}

async function sendByKind({ sessionId, input, targets }: Extract<FrontendMutation, { type: "session.send" }>, deps: SessionSendDeps): Promise<MutationResult> {
  const kind = await deps.supervisor.sessionKind(sessionId)
  if (targets !== undefined) return { ok: false, error: "Session messages address one conversation. Workflow direction uses workflow.send." }
  switch (kind) {
    case undefined:
      return { ok: false, error: `Session ${sessionId} is no longer available` }
    case "chat": {
      const sent = await deps.supervisor.sendChat(sessionId, input)
      if (!sent.ok) return { ok: false, error: sent.reason }
      // The chat's transcript shows a message it holds already, so the
      // transcript retires the client's copy.
      return { ok: true, sessionId, ...(sent.confirmedSubmissionIds ? { confirmedSubmissionIds: sent.confirmedSubmissionIds, inTranscript: true } : {}) }
    }
    case "workflow-agent":
    case "subagent": {
      const { text, attachments } = normalizeChatInput(input)
      if (text.trim().length === 0 && !attachments?.length) return { ok: false, error: "A message to a subagent needs text or an image" }
      const sent = await deps.modules.send(kind, sessionId, input)
      return sent.ok ? { ...sent, sessionId } : sent
    }
  }
}
