import { Database } from "bun:sqlite"
import { createHash } from "node:crypto"
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import type { EventStoreAppend } from "../../../src/infra/event-store-types.js"
import type { historicalWorkflowPublicationFacts } from "./historical-workflow-publication.js"

export interface UpgradeWorkload {
  readonly workflows: number
  readonly agents: number
  readonly generations: number
  readonly toolCalls: number
  readonly contentBytes: number
  readonly nestedChildren: number
}

export const WORKFLOW_UPGRADE_WORKLOAD: UpgradeWorkload = {
  workflows: 10, agents: 50, generations: 2, toolCalls: 30_000, contentBytes: 128 * 1024 * 1024, nestedChildren: 50,
}

const timestamp = Date.parse("2026-10-16T00:00:00.000Z")
const lastUpdated = new Date(timestamp).toISOString()
const hash = (text: string) => createHash("sha256").update(text).digest("hex")

/** Reads frozen bytes without running workspace preparation or a current serializer. */
export function inspectUpgradeFixture(dbFile: string) {
  const db = new Database(dbFile, { readonly: true })
  const count = (sql: string) => db.query<{ n: number }, []>(sql).get()!.n
  try {
    return {
      workflows: count("select count(*) as n from event where type='session.created' and json_extract(payload,'$.kind')='workflow'"),
      generations: count("select count(*) as n from event where type='chat.tree.created' and aggregate_id like 'conversation:upgrade-%-g%'"),
      followUps: count("select count(*) as n from event where type='follow_up.requested'"),
      toolCalls: count("select count(*) as n from event where type='tool.result.recorded'"),
      contentBytes: count("select coalesce(sum(bytes),0) as n from tool_content where session_content_node=0"),
      contentNodes: count("select count(*) as n from tool_content where session_content_node=1"),
      nestedChildren: count("select count(*) as n from event where type='session.created' and json_extract(payload,'$.kind')='subagent'"),
      admittedDeletions: count("select count(*) as n from in_flight where kind='session.subagent_recursive_deletion'"),
    }
  } finally { db.close() }
}

/** Generates once through pinned pre-D serializers. Each measured archive receives a byte-identical database copy.
 * The source identity is supplied by the revision driver manifest, never the current checkout. */
export async function generateUpgradeFixture(directory: string, sourceRoot: string, workload: UpgradeWorkload = WORKFLOW_UPGRADE_WORKLOAD): Promise<void> {
  const revision = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: sourceRoot, stderr: "inherit", windowsHide: true })
  if (revision.exitCode !== 0 || revision.stdout.toString().trim() !== "01612ddbd517c1dc76eea1797ad1f07f06a5ef99") throw new Error("upgrade generation requires the pinned pre-D checkout")
  const load = (path: string) => import(pathToFileURL(join(sourceRoot, path)).href)
  await load("src/orchestration/modules.ts")
  const { createSqliteEventStore }: typeof import("../../../src/infra/sqlite-event-store.js") = await load("src/infra/sqlite-event-store.ts")
  const { historicalWorkflowPublicationFacts: publication }: { historicalWorkflowPublicationFacts: typeof historicalWorkflowPublicationFacts } = await load("tests/release/fixtures/historical-workflow-publication.ts")
  const { parseWorkflowSessionFact }: typeof import("../../../src/workflows/vm/session-facts.js") = await load("src/workflows/vm/session-facts.ts")
  const { parseConversationTreeFact }: typeof import("../../../src/orchestration/session/conversation/conversation-facts.js") = await load("src/orchestration/session/conversation/conversation-facts.ts")
  const { createRuntimeEvent }: typeof import("../../../src/infra/runtime-event-factory.js") = await load("src/infra/runtime-event-factory.ts")
  const { mapRuntimeEventToSessionRuntimeFacts }: typeof import("../../../src/infra/runtime-fact-mapper.js") = await load("src/infra/runtime-fact-mapper.ts")
  const { prepareSessionFactAppend }: typeof import("../../../src/orchestration/session/session-fact-writer.js") = await load("src/orchestration/session/session-fact-writer.ts")
  const { WORKSPACE_STATE_EPOCH }: typeof import("../../../src/orchestration/workspace-state-retirement.js") = await load("src/orchestration/workspace-state-retirement.ts")
  const { buildSessionAuthProfileSelectedFact }: typeof import("../../../src/orchestration/session/session-metadata-facts.js") = await load("src/orchestration/session/session-metadata-facts.ts")
  const { buildMutationFileEvidence, buildMutationEvidence }: typeof import("../../../src/infra/mutation-evidence.js") = await load("src/infra/mutation-evidence.ts")
  mkdirSync(directory, { recursive: true })
  const dbFile = join(directory, "previous.sqlite")
  const store = createSqliteEventStore(dbFile)
  const append = (sessionId: string, type: string, version: number, payload: EventStoreAppend["payload"], aggregateId = `session:${sessionId}`) =>
    store.append({ sessionId, aggregateId, type, version, payload, timestamp, actor: "flywheel" })
  const conversation = (sessionId: string, conversationId: string) => {
    const fact = parseConversationTreeFact({ type: "chat.tree.created", version: 1, actor: "flywheel", payload: { conversationId, createdAt: lastUpdated } })
    store.append({ sessionId, aggregateId: `conversation:${conversationId}`, timestamp, ...fact })
  }
  let calls = 0
  let contentWritten = 0
  let nested = 0
  try {
    append("upgrade-parent", "session.created", 5, { kind: "chat", command: "chat", conversationId: "upgrade-parent-conversation", label: "Upgrade parent", lifecycleState: "inactive", executionCwd: directory, lastUpdated })
    conversation("upgrade-parent", "upgrade-parent-conversation")
    for (let workflow = 0; workflow < workload.workflows; workflow++) {
      const id = `upgrade-${workflow}`
      const firstCall = calls
      const facts = publication({ childSessionId: id, parentSessionId: "upgrade-parent", description: `Upgrade workload ${workflow}`, projectRoot: directory, timestamp, completed: true })
      for (const fact of facts) {
        if (fact.type === "session.created") {
          const { executionCwd, ...historical } = fact.payload
          const payload = {
            ...historical, ...(workflow === 1 ? {} : { executionCwd }), lifecycleState: "inactive",
            launchedFrom: { parentSessionId: "upgrade-parent", conversationId: "upgrade-parent-conversation", [workflow === 1 ? "toolCallId" : "toolUseId"]: `workflow-${id}`, workflowDefinitionId: "implement", description: `Upgrade workload ${workflow}` },
          }
          store.append({ ...fact, version: workflow === 1 ? 3 : 5, payload })
        } else store.append(fact)
      }
      if (workflow === 0) store.append({ sessionId: id, aggregateId: `session:${id}`, timestamp, ...buildSessionAuthProfileSelectedFact("Personal") })
      append(id, "session.label.updated", 1, { label: `Renamed ${id}`, shortLabel: id, name: `Renamed ${id}`, userNamed: true, lastUpdated })
      const root = facts.find(fact => fact.type === "workflow.control.initialized")!
      const parsed = parseWorkflowSessionFact({ type: root.type, version: root.version, actor: root.actor, payload: root.payload })
      if (parsed.type !== "workflow.control.initialized") throw new Error("pre-D serializer produced no control")
      const base = parsed.payload.control
      const baseNode = base.graph.nodes[0]!
      const baseAttempt = base.attempts[0]!
      for (let generation = 0; generation < workload.generations; generation++) {
        const control = {
          ...base, aggregateSeq: store.aggregateSeq(`workflow:${id}`) + 2,
          graph: { ...base.graph, nodes: Array.from({ length: workload.agents }, (_, agent) => ({ ...baseNode, id: `${id}:node:${agent}`, order: agent })) },
          attempts: Array.from({ length: workload.agents }, (_, agent) => ({
            ...baseAttempt, id: `${id}:node:${agent}:attempt:1`, logicalNodeId: `${id}:node:${agent}`,
            conversationId: `${id}-a${agent}-g${generation}`,
          })),
        }
        const controlFact = parseWorkflowSessionFact({ type: "workflow.control.initialized", version: 11, actor: "flywheel", payload: { control } })
        store.append({ sessionId: id, aggregateId: `workflow:${id}`, timestamp, ...controlFact })
        for (let agent = 0; agent < workload.agents; agent++) {
          const conversationId = `${id}-a${agent}-g${generation}`
          conversation(id, conversationId)
          const remainingGenerations = workload.workflows * workload.agents * workload.generations - (workflow * workload.generations + generation) * workload.agents - agent
          const count = Math.ceil((workload.toolCalls - calls) / remainingGenerations)
          const messages = []
          const events: EventStoreAppend[] = []
          let parentId: string | null = null
          for (let index = 0; index < count; index++, calls++) {
            const toolUseId = `upgrade-tool-${calls}`
            const remainingCalls = workload.toolCalls - calls
            const bytes = Math.ceil((workload.contentBytes - contentWritten) / remainingCalls)
            const text = `${toolUseId}:`.padEnd(bytes, "x").slice(0, bytes)
            contentWritten += bytes
            const sha256 = hash(text)
            const reference = { type: "text_reference" as const, sha256, bytes, preview: text.slice(0, 80) }
            for (const event of [
              createRuntimeEvent("tool.input.completed", { tool_use: { id: toolUseId, name: "bash", provider_call_id: toolUseId, provider_tool_name: "bash", executable_tool_name: "bash", input: { command: "echo retained" }, execution: { mode: "foreground", trace_kind: "tool", child_has_own_viewport: false } }, model_request_id: `${conversationId}-request` }),
              createRuntimeEvent("tool.result.recorded", { tool_use_id: toolUseId, content: [{ type: "text", text }], outcome: "ok" }),
            ]) {
              for (const fact of mapRuntimeEventToSessionRuntimeFacts(event)) events.push({ ...prepareSessionFactAppend(id, fact), timestamp, contentRows: [{ sha256, content: text, bytes }] })
            }
            const callId = `${toolUseId}-call`
            const resultId = `${toolUseId}-result`
            messages.push(
              { id: callId, parentId, timestamp: lastUpdated, kind: "message", message: { kind: "assistant", content: [{ type: "tool_use", id: toolUseId, name: "bash", input: { command: "echo retained" } }] } },
              { id: resultId, parentId: callId, timestamp: lastUpdated, kind: "message", message: { kind: "toolResult", toolUseId, content: [reference] } },
            )
            parentId = resultId
          }
          const entries = parseConversationTreeFact({ type: "chat.entries.appended", version: 2, actor: "flywheel", payload: { conversationId, entries: messages } })
          store.appendBatch([...events, { sessionId: id, aggregateId: `conversation:${conversationId}`, timestamp, ...entries }])
          if (nested < workload.nestedChildren) {
            const child = `upgrade-nested-${nested++}`
            append(child, "session.created", 5, { kind: "subagent", command: "subagent", conversationId: `${child}-conversation`, label: child, lifecycleState: "inactive", executionCwd: directory, lastUpdated, launchedFrom: { parentSessionId: id, conversationId, toolUseId: `nested-${child}` } })
            append(id, "session.child.linked", 1, { childSessionId: child, lastUpdated })
            conversation(child, `${child}-conversation`)
            append(child, "child_run.created", 2, {
              childSessionId: child, childRunId: `${child}-run`, conversationId: `${child}-conversation`,
              parentSessionId: id, parentConversationId: conversationId, parentToolCallId: `nested-${child}`,
              persona: { name: "general", kind: "general" },
              capabilityGrant: { operation: "subagent", required: [], capabilities: [], moduleIds: [], requireWorkflowConfirmation: false, workflowsMode: "on", identity: `${child}-grant` },
              admittedModuleIds: [], skillsRevision: 1, model: "fixture-model", tools: [], executionCwd: directory,
              budget: { maxTurns: 10, maxTokens: 1000 }, parentDepth: 0, description: "Retained nested work",
            })
          }
        }
      }
      const followUp = `${id}-follow-up`
      append(id, "follow_up.requested", 1, { prompt: "Retained follow-up", conversationId: followUp, requestSequence: 1 }, `workflow:${id}`)
      conversation(id, followUp)
      const finalRoot = store.read({ aggregateId: `workflow:${id}`, types: ["workflow.control.initialized"] }).at(-1)!
      const finalControl = parseWorkflowSessionFact({ type: finalRoot.type, version: finalRoot.version, actor: finalRoot.actor, payload: finalRoot.payload })
      if (finalControl.type !== "workflow.control.initialized") throw new Error("pre-D final root is unavailable")
      append(id, "workflow.control.initialized", 11, { control: { ...finalControl.payload.control, aggregateSeq: store.aggregateSeq(`workflow:${id}`) + 2 } }, `workflow:${id}`)
      for (const [inputTokens, cost] of [[10, 0.1], [20, 0.15]]) store.append({ sessionId: id, aggregateId: `session:${id}`, timestamp, actor: "provider", type: "model.usage.measured", version: 3,
        payload: { totalCostUsd: cost, billedCostUsd: cost, inputTokens, outputTokens: 8, cacheReadTokens: 0, cacheCreateTokens: 0, reasoningTokens: 0, budgetStreamId: `${id}-cumulative` } })
      const first = `${id}-a0-g0`
      append(id, "prompt.assembled", 2, {
        requestId: `${first}-request`, conversationId: `${first}-provider-key`, turn: 1, promptKind: "workflow-agent",
        systemPromptHash: "system", toolSurfaceHash: "surface", promptSha256: "prompt", messageCount: 1,
        estimatedContextTokens: 100, contextWindow: 1000, treePointer: { conversationId: first, leafEntryId: null },
      })
      store.putInFlight(id, "chat.queued_user_input", `held-${id}`, { conversationId: first, text: "Retained private input", origin: "human" })
      store.putInFlight("upgrade-parent", "session.reply_wait", `${id}:wait`, { openedAtMs: timestamp, readKey: `msg:upgrade-parent:${id}` })
      const question = append(id, "agent_input.requested", 3, { interactionId: `${id}-question`, conversationId: first, toolUseId: `${id}-ask`, request: [] })
      append(id, "agent_input.answered", 3, { interactionId: `${id}-question`, damagedAnswer: "Retained historical bytes" })
      store.append({ sessionId: id, aggregateId: `session:${id}`, type: "tool.execution_output.recorded", version: 1, actor: "agent", timestamp, parentEventId: question.id, payload: { damaged: "Retained linked output" } })
      const stage = async (nodes: Parameters<typeof store.stageSessionContentNodes>[1]) => { store.stageSessionContentNodes(id, nodes) }
      const file = await buildMutationFileEvidence({
        mutationId: `${id}-mutation`, path: join(directory, `${id}.txt`), displayPath: `${id}.txt`,
        before: { kind: "absent" }, after: { kind: "text", text: Array.from({ length: 3000 }, (_, line) => `${id}-${line}\n`).join("") },
      }, stage)
      if (!file) throw new Error("pre-D mutation serializer produced no changed file")
      const evidence = await buildMutationEvidence(Array.from({ length: 128 }, (_, index) => ({
        kind: "applied" as const, file: { ...file, mutationId: `${id}-mutation-${index}`, path: join(directory, `${id}-${index}.txt`) },
      })), stage)
      const mutationOutput = createRuntimeEvent("tool.execution_output.recorded", { tool_use_id: `upgrade-tool-${firstCall}`, output: "Retained file evidence", mutationEvidence: evidence })
      for (const fact of mapRuntimeEventToSessionRuntimeFacts(mutationOutput)) store.append({ ...prepareSessionFactAppend(id, fact), timestamp })
      store.putInFlight(id, "file.mutation", `${id}-mutation`, { version: 3, operationId: `${id}-mutation`, damaged: "Retained plan" })
      store.putInFlight(id, "usage.settlement", `${id}-wire`, { state: "pending", attemptId: `${id}-wire`, requestId: `${first}-request`, profileId: "Personal", budgetStreamId: `${id}-wire-stream`, identity: { providerSessionKey: `${first}-provider-key`, conversationId: first }, turn: 1 })
      store.putInFlight(id, "session.command_handover", `${id}-command`, {
        version: 1, handoffId: `${id}-handoff`, sessionId: id, conversationId: first, processId: `${id}-command`,
        pid: 2_000_000_000, description: "Historical kept command", logPath: join(directory, `${id}.log`),
        recordPath: join(directory, `${id}.record`), channel: `${id}-channel`, token: `${id}-fixture-token`,
        startedAtMs: timestamp, deadlineAtMs: timestamp + 1000, kept: true,
      })
      const notes = join(directory, "sessions", id, "scratch", "notes", Buffer.from(first, "utf8").toString("hex"))
      mkdirSync(notes, { recursive: true })
      writeFileSync(join(notes, "checkpoint.md"), `Retained ${first} notes.\n`)
    }
  } finally { store.close() }
  const generation = new Database(dbFile)
  try { generation.exec(`PRAGMA user_version = ${WORKSPACE_STATE_EPOCH}`) } finally { generation.close() }
  copyFileSync(dbFile, join(directory, "deletion.sqlite"))
  const deletion = createSqliteEventStore(join(directory, "deletion.sqlite"))
  try {
    deletion.putInFlight("upgrade-0", "session.subagent_recursive_deletion", "upgrade-0", { version: 1, rootSessionId: "upgrade-0", edges: [] })
  } finally { deletion.close() }
  writeFileSync(join(directory, "fixture.json"), `${JSON.stringify({
    sourceRoot, sourceRevision: revision.stdout.toString().trim(), workload, counts: inspectUpgradeFixture(dbFile),
    sha256: createHash("sha256").update(readFileSync(dbFile)).digest("hex"),
    deletionSha256: createHash("sha256").update(readFileSync(join(directory, "deletion.sqlite"))).digest("hex"),
    expected: { workflows: workload.workflows, generations: workload.workflows * workload.agents * workload.generations, followUps: workload.workflows,
      deletionWorkflows: workload.workflows - 1, deletionGenerations: (workload.workflows - 1) * workload.agents * workload.generations,
      nestedSurvivors: workload.nestedChildren, retainedDeletionRoots: 1 },
  }, null, 2)}\n`)
}
