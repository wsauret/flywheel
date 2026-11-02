import { resolve } from "node:path"
import { factDescriptors } from "../../src/infra/event-registry.js"
import type { EventStoreAppend } from "../../src/infra/event-store-types.js"
import { SessionMetadataFactSchemas } from "../../src/orchestration/session/session-metadata-facts.js"
import { SessionRuntimeFactSchemas } from "../../src/orchestration/session/session-runtime-event-types.js"
import { SubagentRunFactSchemas } from "../../src/orchestration/modules/subagents/facts.js"
import { ConversationTreeFactSchemas } from "../../src/orchestration/session/conversation/conversation-facts.js"
import { WORKFLOW_CONTROL_FACT_TYPES } from "../../src/workflows/vm/session-facts.js"

/** A canonical absolute project directory (ARCH-DIRECTORIES-006) as these payloads state
 *  it. The corpus is byte-exact within one run, not across platforms: an
 *  absolute path names a drive on Windows, so a path that equals its own
 *  resolution there is not the same string a POSIX run writes. */
export function corpusProjectDir(leaf: string): string {
  return resolve(`/workspace/${leaf}`)
}

/** The same directory as a JSON string literal, for the payload bytes below. */
function jsonDir(leaf: string): string {
  return JSON.stringify(corpusProjectDir(leaf))
}

const workflowControlVersions = new Map<string, number>([["workflow.control.committed", 2]])
const currentSessionCreatedPayload = `{"kind":"chat","command":"chat","conversationId":"inline-conversation","label":"Sanitized session","name":"Sanitized session","lastUpdated":"2023-11-14T22:13:20.000Z","lifecycleState":"inactive","executionCwd":${jsonDir("sanitized-project")}}`

const AUTHORITATIVE_FACT_FAMILIES = {
  session_metadata: factDescriptors(SessionMetadataFactSchemas),
  chat_tree: factDescriptors(ConversationTreeFactSchemas),
  decorations: [
    ...factDescriptors(SessionRuntimeFactSchemas).filter(({ type }) => type === "tool.result.recorded" || type === "tool.execution_output.recorded" || type === "workflow.worker_boundary.recorded" || type === "workflow.step.started"),
    ...factDescriptors(SubagentRunFactSchemas),
  ],
  workflow_control: WORKFLOW_CONTROL_FACT_TYPES.map((type) => ({ type, version: workflowControlVersions.get(type) ?? 1 })),
} as const

export type TolerantReprojectionFactFamily = keyof typeof AUTHORITATIVE_FACT_FAMILIES
export type TolerantReprojectionFailureClass =
  | "valid-current"
  | "retired-excess-field"
  | "unknown-older-version"
  | "newer-version"
  | "invalid JSON"
  | "mutation-before-creation"
  | "chat-update-on-non-chat"
  | "role-delta-before-snapshot"
  | "tool-result-without-tool-use"
export type TolerantReprojectionConsumerSurface =
  | "strict-projection"
  | "metadata-listing"
  | "output-history"
  | "chat-reactivation"
  | "workflow-resume"
  | "retirement"
  | "tree-handle"
  | "conversation-recall"
  | "decoration-reader"
  | "workflow-history"
export type TolerantReprojectionDisposition =
  | { readonly kind: "executable"; readonly testName: string }
  | { readonly kind: "not_applicable"; readonly reason: string }
export type StrictProjectionEquivalenceDisposition =
  | { readonly kind: "equivalent" }
  | { readonly kind: "non_equivalent"; readonly reason: string }

const na = (reason: string): TolerantReprojectionDisposition => ({ kind: "not_applicable", reason })
const executable = (testName: string): TolerantReprojectionDisposition => ({ kind: "executable", testName })
const allNotApplicable = (reason: string): Record<TolerantReprojectionConsumerSurface, TolerantReprojectionDisposition> => ({
  "strict-projection": na(reason), "metadata-listing": na(reason), "output-history": na(reason), "chat-reactivation": na(reason), "workflow-resume": na(reason), retirement: na(reason), "tree-handle": na(reason), "conversation-recall": na(reason), "decoration-reader": na(reason), "workflow-history": na(reason),
})
const surfaces = (reason: string, overrides: Partial<Record<TolerantReprojectionConsumerSurface, TolerantReprojectionDisposition>>): Record<TolerantReprojectionConsumerSurface, TolerantReprojectionDisposition> => ({ ...allNotApplicable(reason), ...overrides })

export const tolerantReprojectionFixtures = {
  session_metadata: {
    descriptors: AUTHORITATIVE_FACT_FAMILIES.session_metadata,
    failures: {
      "valid-current": { payloadBytes: currentSessionCreatedPayload, surfaces: surfaces("This surface does not consume session metadata.", { "strict-projection": executable("session_metadata valid-current strict-projection accepts the registered current wire") }) },
      "retired-excess-field": { payloadBytes: "{\"temporary\":true}", surfaces: surfaces("Retired excess fields are exercised only by the destructive retirement boundary.", { retirement: executable("session_metadata retired-excess-field retirement deletes the unrepairable session and recall rows") }) },
      "unknown-older-version": { facts: [
        { type: "session.created", version: 1, actor: "flywheel", payloadBytes: "{\"kind\":\"chat\",\"command\":\"chat\",\"conversationId\":\"legacy-conversation-1\",\"label\":\"legacy-1\",\"lifecycleState\":\"inactive\"}" },
        { type: "session.created", version: 2, actor: "flywheel", payloadBytes: "{\"kind\":\"chat\",\"command\":\"chat\",\"conversationId\":\"legacy-conversation-2\",\"label\":\"legacy-2\",\"lifecycleState\":\"inactive\"}" },
      ], surfaces: surfaces("This consumer does not load session catalog metadata.", {
        "metadata-listing": executable("session_metadata unknown-older-version metadata-listing makes session.created@1 and @2 unavailable"),
        "output-history": executable("session_metadata unknown-older-version output-history reports session.created@1 and @2 unavailable"),
        "chat-reactivation": executable("session_metadata unknown-older-version chat-reactivation opens session.created@1 and @2 through project fallback"),
        "workflow-resume": executable("session_metadata unknown-older-version workflow-resume starts session.created@1 and @2 through project fallback"),
      }) },
      "newer-version": { fact: { type: "session.created", version: 4, actor: "flywheel", payloadBytes: "{\"shape\":\"newer-binary\"}" }, surfaces: surfaces("Only retirement classifies whether an unreadable newer wire can be deleted.", { retirement: executable("session_metadata newer-version retirement preserves the exact payload bytes") }) },
      "invalid JSON": { payloadBytes: "{{{not-json", surfaces: surfaces("Only the metadata projection and strict event read consume this metadata row directly.", { "strict-projection": executable("session_metadata invalid JSON strict-projection captures a per-session error and strict read throws") }) },
      "mutation-before-creation": { surfaces: surfaces("Only the metadata reducer has a creation-order invariant.", { "strict-projection": executable("session_metadata mutation-before-creation strict-projection records the missing creation invariant") }) },
      "chat-update-on-non-chat": { surfaces: allNotApplicable("No reviewed phase-1 production boundary writes a chat-only metadata mutation to a workflow session.") },
      "role-delta-before-snapshot": { surfaces: allNotApplicable("The current metadata reducer accepts role deltas without requiring an earlier snapshot, so no rejection contract exists.") },
      "tool-result-without-tool-use": { surfaces: allNotApplicable("Session metadata does not consume tool-result decoration facts.") },
    },
  },
  chat_tree: {
    descriptors: AUTHORITATIVE_FACT_FAMILIES.chat_tree,
    failures: {
      "valid-current": { surfaces: allNotApplicable("Current chat-tree acceptance is covered by broad tree tests, not a tolerant-reprojection boundary leaf.") },
      "retired-excess-field": { surfaces: allNotApplicable("The chat-tree registry has no reviewed retired excess field.") },
      "unknown-older-version": { surfaces: allNotApplicable("The chat-tree registry has no historical schema version.") },
      "newer-version": { surfaces: allNotApplicable("Strict chat-tree reads have no downgrade retirement path.") },
      "invalid JSON": { payloadBytes: "{{{not-json", surfaces: surfaces("Only strict tree consumers parse chat-tree rows.", { "strict-projection": executable("chat_tree invalid JSON strict-projection throws before any recall FTS mapping"), "conversation-recall": executable("chat_tree invalid JSON conversation-recall fails strict projection before FTS mapping") }) },
      "mutation-before-creation": { payloadBytes: "{\"conversationId\":\"conv-matrix\",\"entries\":[]}", surfaces: surfaces("Only strict tree projection owns chat creation order.", { "strict-projection": executable("chat_tree mutation-before-creation strict-projection throws missing-producer-event") }) },
      "chat-update-on-non-chat": { surfaces: allNotApplicable("Chat-tree aggregates are keyed by conversation, not session kind.") },
      "role-delta-before-snapshot": { surfaces: allNotApplicable("Chat-tree facts do not contain session role deltas.") },
      "tool-result-without-tool-use": { surfaces: surfaces("Transcript display degrades an orphan tool result without changing tree topology or model context.", { "tree-handle": executable("chat_tree tool-result-without-tool-use tree-handle degrades the orphan result") }) },
    },
  },
  decorations: {
    descriptors: AUTHORITATIVE_FACT_FAMILIES.decorations,
    failures: {
      "valid-current": { surfaces: allNotApplicable("Valid decoration replay is covered by the output-seam corpus, not a failure leaf.") },
      "retired-excess-field": { surfaces: allNotApplicable("Decoration registries have no reviewed retired field fixture.") },
      "unknown-older-version": { surfaces: allNotApplicable("Decoration readers have no historical version compatibility contract.") },
      "newer-version": { surfaces: allNotApplicable("Decoration readers are strict and have no retirement boundary.") },
      "invalid JSON": { surfaces: allNotApplicable("The output-seam corpus records concrete schema failures instead of mutating persisted JSON for each decoration reader.") },
      "mutation-before-creation": { surfaces: allNotApplicable("Decoration readers key by tool or run identity and do not consume session creation order.") },
      "chat-update-on-non-chat": { surfaces: allNotApplicable("Decoration facts are valid for chat and workflow sessions.") },
      "role-delta-before-snapshot": { surfaces: allNotApplicable("Decoration registries do not contain role facts.") },
      "tool-result-without-tool-use": { surfaces: surfaces("Only the tool-result metadata reader consumes this identity.", { "decoration-reader": executable("decorations tool-result-without-tool-use decoration-reader preserves metadata by tool identity") }) },
    },
  },
  workflow_control: {
    descriptors: AUTHORITATIVE_FACT_FAMILIES.workflow_control,
    failures: {
      "valid-current": { surfaces: surfaces("This surface does not consume workflow control facts.", { "workflow-resume": executable("workflow_control valid-current workflow-resume starts the registered durable workflow") }) },
      "retired-excess-field": { surfaces: allNotApplicable("Workflow control has no reviewed retired excess field.") },
      "unknown-older-version": { surfaces: allNotApplicable("Workflow control has no supported older wire in this safety net.") },
      "newer-version": { surfaces: allNotApplicable("Workflow control is strict and has no catalog retirement path.") },
      "invalid JSON": { surfaces: allNotApplicable("The workflow aggregate strict reader has no output-seam tolerant conversion.") },
      "mutation-before-creation": { surfaces: allNotApplicable("Workflow control ordering is covered by the VM oracle suite, not these consumer surfaces.") },
      "chat-update-on-non-chat": { surfaces: allNotApplicable("Workflow control does not consume chat metadata updates.") },
      "role-delta-before-snapshot": { surfaces: allNotApplicable("Workflow control does not consume session role facts.") },
      "tool-result-without-tool-use": { surfaces: allNotApplicable("Workflow control does not consume tool-result metadata.") },
    },
  },
} as const satisfies Record<TolerantReprojectionFactFamily, { readonly descriptors: readonly { readonly type: string; readonly version: number }[]; readonly failures: Record<TolerantReprojectionFailureClass, { readonly surfaces: Record<TolerantReprojectionConsumerSurface, TolerantReprojectionDisposition>; readonly [key: string]: unknown }> }>

export const registeredPhaseOneWireTestNames = [
  "session_metadata valid-current strict-projection accepts the registered current wire",
  "session_metadata retired-excess-field retirement deletes the unrepairable session and recall rows",
  "session_metadata unknown-older-version metadata-listing makes session.created@1 and @2 unavailable",
  "session_metadata unknown-older-version output-history reports session.created@1 and @2 unavailable",
  "session_metadata unknown-older-version chat-reactivation opens session.created@1 and @2 through project fallback",
  "session_metadata unknown-older-version workflow-resume starts session.created@1 and @2 through project fallback",
  "session_metadata newer-version retirement preserves the exact payload bytes",
  "session_metadata invalid JSON strict-projection captures a per-session error and strict read throws",
  "session_metadata mutation-before-creation strict-projection records the missing creation invariant",
  "chat_tree invalid JSON strict-projection throws before any recall FTS mapping",
  "chat_tree invalid JSON conversation-recall fails strict projection before FTS mapping",
  "chat_tree mutation-before-creation strict-projection throws missing-producer-event",
  "chat_tree tool-result-without-tool-use tree-handle degrades the orphan result",
  "decorations tool-result-without-tool-use decoration-reader preserves metadata by tool identity",
  "workflow_control valid-current workflow-resume starts the registered durable workflow",
] as const

export const strictProjectionAgreementFixtures = {
  session_metadata: {
    fixtureId: "strict-session-created-v5",
    equivalence: { kind: "equivalent" },
    fact: {
      type: "session.created",
      version: 5,
      actor: "flywheel",
      payloadBytes: `{"kind":"chat","command":"chat","conversationId":"strict-conversation","label":"Strict session","name":"Strict session","lastUpdated":"2023-11-14T22:13:20.000Z","lifecycleState":"inactive","executionCwd":${jsonDir("strict-project")}}`,
    },
    strictRejectedFixtures: {
      invalid_json: { equivalence: { kind: "non_equivalent", reason: "The owning strict reader rejects invalid JSON before projection reduction." } },
      schema_rejection: { equivalence: { kind: "non_equivalent", reason: "Both strict routes reject the schema-invalid envelope, so no typed result exists to compare." } },
      historical_version: { equivalence: { kind: "non_equivalent", reason: "Unregistered historical metadata versions have no current strict typed result." } },
      future_version: { equivalence: { kind: "non_equivalent", reason: "A newer metadata version has no current strict typed result." } },
    },
  },
  chat_tree: {
    fixtureId: "strict-chat-tree-created-v1",
    equivalence: { kind: "equivalent" },
    fact: {
      type: "chat.tree.created",
      version: 1,
      actor: "flywheel",
      payloadBytes: "{\"conversationId\":\"strict-conversation\",\"createdAt\":\"2023-11-14T22:13:20.000Z\"}",
    },
    strictRejectedFixtures: {
      invalid_json: { equivalence: { kind: "non_equivalent", reason: "The owning strict reader rejects invalid JSON before projection reduction." } },
      schema_rejection: { equivalence: { kind: "non_equivalent", reason: "Both strict routes reject the schema-invalid envelope, so no typed result exists to compare." } },
      strict_tree_violation: { equivalence: { kind: "non_equivalent", reason: "The payload strictly decodes, while transcript replay degrades each disconnected committed entry without adding it to tree topology." } },
    },
  },
} as const satisfies Record<"session_metadata" | "chat_tree", {
  readonly fixtureId: string
  readonly equivalence: StrictProjectionEquivalenceDisposition
  readonly fact: { readonly type: string; readonly version: number; readonly actor: string; readonly payloadBytes: string }
  readonly strictRejectedFixtures: Readonly<Record<string, { readonly equivalence: Extract<StrictProjectionEquivalenceDisposition, { kind: "non_equivalent" }> }>>
}>

export type OutputSeamInlineFixtureId = keyof typeof outputSeamInlineFixtures

const createdPayload = currentSessionCreatedPayload
const legacyCreatedPayload = "{\"kind\":\"chat\",\"command\":\"chat\",\"conversationId\":\"inline-legacy-conversation\",\"label\":\"legacy\",\"lifecycleState\":\"inactive\"}"

export const outputSeamInlineFixtures = {
  "old-session-created-v1": { facts: [{ type: "session.created", version: 1, payloadBytes: legacyCreatedPayload }] },
  "retired-field": { facts: [{ type: "session.created", version: 3, payloadBytes: createdPayload.replace(/}$/, ",\"temporary\":true}") }] },
  "unknown-version": { facts: [{ type: "session.created", version: 0, payloadBytes: createdPayload }] },
  "newer-version-fence": { facts: [{ type: "session.created", version: 6, payloadBytes: "{\"shape\":\"newer-binary\"}" }] },
  "corrupt-json-creation": { facts: [{ type: "session.created", version: 3, payloadBytes: createdPayload }], corruptPayloadBytes: tolerantReprojectionFixtures.session_metadata.failures["invalid JSON"].payloadBytes },
  "decoration-fact-failure": { facts: [
    { type: "session.created", version: 3, payloadBytes: `{"kind":"workflow","command":"workflow","workflowDefinitionId":"sanitized-workflow","label":"Sanitized session","name":"Sanitized session","lastUpdated":"2023-11-14T22:13:20.000Z","lifecycleState":"inactive","executionCwd":${jsonDir("sanitized-project")}}` },
    { type: "tool.result.recorded", version: 1, payloadBytes: "{}" },
    { type: "child_run.created", version: 1, payloadBytes: "{}" },
    { type: "workflow.step.started", version: 1, payloadBytes: "{}" },
  ] },
  "mutation-before-creation": { facts: [{ type: "session.label.updated", version: 1, payloadBytes: "{}" }, { type: "session.created", version: 3, payloadBytes: createdPayload }] },
  "reconcile-tombstone": { facts: [{ type: "session.created", version: 3, payloadBytes: createdPayload }, { type: "session.deleted", version: 1, payloadBytes: "{\"lastUpdated\":\"2023-11-14T22:13:20.000Z\"}" }, { type: "session.label.updated", version: 1, payloadBytes: "{}" }] },
} as const satisfies Record<string, { readonly facts: readonly { readonly type: string; readonly version: number; readonly payloadBytes: string }[]; readonly corruptPayloadBytes?: string }>

/** Mixed workspace evidence for catalog and detail recovery tests. The envelope
 * session id is the only identity shared across corrupt metadata and the
 * independently readable conversation or workflow aggregate. */
export const mixedSessionProjectionFixtures = {
  corruptMetadata: { type: "session.auth.profile.selected", version: 1, payloadBytes: "{{not-json" },
  chatRoot: { type: "chat.tree.created", version: 1 },
  workflowRoot: { type: "workflow.control.initialized", version: 2 },
} as const

export function historicalSessionCreatedFacts(sessionId: string): readonly EventStoreAppend[] {
  return tolerantReprojectionFixtures.session_metadata.failures["unknown-older-version"].facts.map((fact, index) => ({
    aggregateId: `session:${sessionId}-${fact.version}`,
    sessionId: `${sessionId}-${fact.version}`,
    type: fact.type,
    version: fact.version,
    actor: fact.actor,
    timestamp: index + 1,
    payload: JSON.parse(fact.payloadBytes),
  }))
}

export function historicalWorkflowSessionCreatedFacts(sessionId: string): readonly EventStoreAppend[] {
  return [1, 2].map((version) => ({
    aggregateId: `session:${sessionId}-${version}`,
    sessionId: `${sessionId}-${version}`,
    type: "session.created",
    version,
    actor: "flywheel",
    timestamp: version,
    payload: {
      kind: "workflow",
      command: "workflow",
      workflowDefinitionId: "implement",
      label: `legacy-${version}`,
      lifecycleState: "inactive",
    },
  }))
}

export function assertTolerantReprojectionRegistryComplete(): void {
  const executableNames: string[] = []
  for (const family of Object.values(tolerantReprojectionFixtures)) {
    if (family.descriptors.length === 0) throw new Error("fact family has no authoritative descriptors")
    for (const failure of Object.values(family.failures)) {
      for (const disposition of Object.values(failure.surfaces)) {
        if (disposition.kind === "executable") executableNames.push(disposition.testName)
        else if (disposition.reason.length === 0) throw new Error("not_applicable matrix leaf requires a reason")
      }
    }
  }
  const expected = [...registeredPhaseOneWireTestNames].sort()
  const actual = executableNames.sort()
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`Executable registry leaves do not match registered tests: ${JSON.stringify(actual)}`)
}
