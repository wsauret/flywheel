import { attemptBrief, planEveryCapability } from "../../../helpers/attempt-brief"
import { workflowAgentInputs } from "../../../helpers/workflow-agent-inputs"
import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { asAsyncEventReadSurface, asAsyncEventWriter, type EventStore } from "../../../../src/infra/event-store-types"
import { resolveEventStoreDbFile } from "../../../../src/infra/paths"
import { createSqliteEventStore } from "../../../../src/infra/sqlite-event-store"
import type { Agent, AgentOptions } from "../../../../src/orchestration/agent-runtime/types"
import { EventBus, createEmit } from "../../../../src/infra/event-bus"
import { createSessionFactWriter } from "../../../../src/orchestration/session/session-fact-writer"
import { publishWorkerAttempt } from "../workflow-host/_workflow-host-fixtures"
import { roleCapture } from "../../../helpers/role-capture"
import { composeFirstPartyModules } from "../../../../src/orchestration/modules"
import type { ResolvedRoles } from "../../../../src/orchestration/config/roles"
import { createWorkerCallback } from "../../../../src/orchestration/workflow-host/agent-callback"
import type { AttemptRow } from "../../../../src/workflows/view/types"
import { testAuth } from "../chat/_chat-session-agent-runtime-fixtures"
import { noSkills } from "../../../helpers/project-definitions"
import { noConversationRecall } from "../workflow-host/_workflow-controller-fixtures"
import { definition } from "../../workflows/vm/host-test-support"

let projectRoot: string
let store: EventStore
const sessionId = "child-conversation-session"

beforeEach(() => {
  projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "flywheel-child-conversation-"))
  store = createSqliteEventStore(resolveEventStoreDbFile(projectRoot))
})

afterEach(() => {
  store.close()
  fs.rmSync(projectRoot, { recursive: true, force: true })
})

describe("child conversation factory", () => {
  it("gives a workflow worker a child conversation factory owned by its ordinary session", async () => {
    let captured: AgentOptions["createChildConversation"]
    const createAgent = (options: AgentOptions): Agent => {
      captured = options.createChildConversation
      return {
        send() {
          if (options.conversation.kind !== "durable-tree") throw new Error("expected durable tree")
          options.conversation.append({ kind: "assistant", content: [{ type: "text", text: "done" }] })
          options.lifecycle.onTurnEnded?.({ handoffWritten: true, turnCount: 1 })
        },
        end() {},
        abort() {},
        done: Promise.resolve({ servedRequests: 0, durationMs: 1, terminal: { kind: "completed" } }),
      }
    }
    const step: AttemptRow = {
      id: "step",
      definitionId: "work",
      workflowDefinitionId: "workflow",
      name: "Work",
      briefId: "implementation",
      status: "running",
      writes: [],
      resumeRevertCount: 0,
    }
    const { manager, member } = await publishWorkerAttempt({ projectRoot, reader: asAsyncEventReadSurface(store), writer: asAsyncEventWriter(store), workflowId: sessionId, attemptId: step.id, conversationId: "worker-conversation" })
    const worker = createWorkerCallback({
      awaitModelAccessSettled: async () => {},
      createAgent,
      createLLMClient: () => { throw new Error("unused") },
      captureProviderConnection: async () => roleCapture(["gpt-6.1-sol"]),
      auth: testAuth,
      proactiveCompactionThreshold: () => 270_000,
      resolveRoles: async (): Promise<ResolvedRoles> => new Map([
        ["workflow-agent", { roleId: "workflow-agent", model: "test-model", effort: "high" }],
      ]),
      emit: createEmit(new EventBus()),
      sessionId,
      projectRoot,
      userDataRoot: projectRoot,
      accountHome: projectRoot,
      executionCwd: projectRoot,
      moduleSelection: composeFirstPartyModules(),
      agentInputs: workflowAgentInputs(asAsyncEventReadSurface(store), sessionId).agentInputs,
      deactivateSession: id => manager.updateLifecycleState(id, "inactive"),
      sessionEventWriter: createSessionFactWriter({ sessionId: member.sessionId, writer: asAsyncEventWriter(store) }),
      eventStore: asAsyncEventReadSurface(store),
      projectionReader: asAsyncEventReadSurface(store),
      eventWriter: asAsyncEventWriter(store),
      skills: noSkills,
      personas: new Map(),
      planCapabilities: planEveryCapability,
      resolvedAgents: new Map([["work", definition]]),
      recall: noConversationRecall,
    }).worker

    await worker(step, attemptBrief("prompt"), undefined, "worker-conversation")

    if (!captured) throw new Error("Missing child conversation factory")
    const child = await captured("nested-child")
    await child.buildContext()
    await child.recordCanonicalMessage({ kind: "user", content: "nested task" })
    await child.flushSavePoint()
    await child.dispose()
    expect(store.read({ aggregateId: "conversation:nested-child", types: ["chat.tree.created"] })).toMatchObject([{ sessionId: member.sessionId }])
  })

})
