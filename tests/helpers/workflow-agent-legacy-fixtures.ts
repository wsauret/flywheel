import { createSqliteEventStore } from "../../src/infra/sqlite-event-store.js"
import { historicalWorkflowPublicationFacts } from "../release/fixtures/historical-workflow-publication.js"
import { resolveEventStoreDbFile } from "../../src/infra/paths.js"
import { isRecord } from "../../src/infra/record.js"

const CHAT = '{"kind":"chat","command":"chat","conversationId":"parent-conversation","label":"Parent","lifecycleState":"inactive","lastUpdated":"2026-10-16T00:00:00.000Z"}'
const WORKFLOW = '{"kind":"workflow","command":"workflow","workflowDefinitionId":"implement","label":"Original request","lifecycleState":"inactive","createdAt":"2026-10-16T00:00:00.000Z","lastUpdated":"2026-10-16T00:00:00.000Z","authProfileId":"Personal","roleAssignments":{"defaults":{},"overrides":{}},"launchedFrom":{"parentSessionId":"parent","conversationId":"parent-conversation","toolUseId":"workflow-old","workflowDefinitionId":"implement","description":"Original request"}}'

/** Previous-format bytes are independent of current session and workflow writers. */
export function legacyWorkflowFixture(root: string) {
  const dbFile = resolveEventStoreDbFile(root)
  const store = createSqliteEventStore(dbFile)
  const timestamp = Date.parse("2026-10-16T00:00:00.000Z")
  store.append({ aggregateId: "session:parent", sessionId: "parent", type: "session.created", version: 5, actor: "flywheel", timestamp, payload: JSON.parse(CHAT) })
  for (const fact of historicalWorkflowPublicationFacts({
    childSessionId: "old", parentSessionId: "parent", description: "Original request", projectRoot: root, timestamp, completed: false,
  })) {
    store.append(fact.type === "session.created"
      ? { ...fact, version: 5, payload: JSON.parse(WORKFLOW) }
      : fact)
  }
  store.append({ aggregateId: "session:old", sessionId: "old", type: "session.label.updated", version: 1, actor: "flywheel", timestamp,
    payload: JSON.parse('{"label":"Renamed","shortLabel":"Renamed","name":"Renamed","userNamed":true,"lastUpdated":"2026-10-16T00:00:00.000Z"}') })
  // Retained roots prove generations even when older commits were pruned.
  const original = store.read({ aggregateId: "workflow:old", types: ["workflow.control.initialized"] })[0]!
  for (const conversationId of ["generation-one", "generation-two"]) {
    const control: unknown = structuredClone(original.payload.control)
    const attempt: unknown = isRecord(control) && Array.isArray(control.attempts) ? control.attempts[0] : undefined
    if (!isRecord(control) || !isRecord(attempt)) throw new Error("the historical workflow control holds no first attempt")
    attempt.conversationId = conversationId
    attempt.state = { _tag: "running" }
    control.aggregateSeq = store.aggregateSeq("workflow:old") + 2
    store.append({ aggregateId: "workflow:old", sessionId: "old", type: "workflow.control.initialized", version: 11, timestamp, actor: "flywheel", payload: { control } })
    store.append({ aggregateId: `conversation:${conversationId}`, sessionId: "old", type: "chat.tree.created", version: 1, timestamp, actor: "flywheel",
      payload: { conversationId, createdAt: "2026-10-16T00:00:00.000Z" } })
  }
  return { store, dbFile, root }
}
