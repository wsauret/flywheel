import { mkdirSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { Database } from "bun:sqlite"
import { ManagedRuntime } from "effect"
import { EventReaderService, EventStoreLive, EventStoreService } from "../src/infra/event-store-effect.js"
import { asAsyncEventReadSurface, type AsyncEventStateReadSurface, type EventReader, type EventStoreAppend, type EventStoreReadSurface, type StoredFact } from "../src/infra/event-store-types.js"
import { createSqliteEventStore } from "../src/infra/sqlite-event-store.js"
import { factRowsChanged } from "../src/infra/sqlite-event-store-core.js"
import { resolveEventStoreDbFile } from "../src/infra/paths.js"
import { installedWorkspaceMigrations } from "../src/orchestration/modules.js"
import { migrateAgentInputAnswers } from "../src/orchestration/migrations/agent-input-answer.js"
import { createSessionDetailProjection } from "../src/orchestration/app-service/session-detail-projection.js"
import { createOutputProjection } from "../src/orchestration/app-service/output-projection.js"
import { createShippedOutput } from "../src/orchestration/app-service/shipped-output.js"
import { createRuntimeUiPatchSequencer } from "../src/orchestration/app-service/runtime-ui-patch-sequencer.js"
import type { RuntimeUiPatch } from "../src/protocol/runtime-ui-protocol-types.js"
import { createOutputSession } from "../src/orchestration/runner/output-session.js"
import { createSessionStore } from "../src/orchestration/session-store/store.js"
import { readSessionMetadata } from "../src/orchestration/session/session-metadata-store.js"
import { readSubagentRunsByToolUseId } from "../src/orchestration/modules/subagents/history/subagent-history.js"
import { readToolResultDisplayMeta } from "../src/orchestration/session/conversation/tool-result-meta.js"
import { workflowMembershipReader } from "../src/orchestration/session/workflow-membership.js"
import { outputSeamInlineFixtures, type OutputSeamInlineFixtureId } from "../tests/fixtures/tolerant-reprojection-fixtures.js"

interface StringArrayDictionary { [key: string]: string[] }
interface SanitizableDictionary { [key: string]: SanitizableValue }
type SanitizableValue = string | number | boolean | null | undefined | SanitizableDictionary | SanitizableValue[]
export type CorpusSource =
  | { kind: "extracted"; sessionId: string; conversationId?: string; maxPosition: number }
  | { kind: "inline"; fixtureId: OutputSeamInlineFixtureId }
export interface CorpusManifestCase { id: string; source: CorpusSource; coverage: StringArrayDictionary; artifacts: string[] }
export interface CorpusManifest { version: number; source: string; cases: CorpusManifestCase[] }
export interface CorpusCase {
  id: string; source: { kind: CorpusSource["kind"] }; kind: "chat" | "workflow"; sessionId: string; conversationId?: string; facts: EventStoreAppend[]
  requests: { history: { anchor: { kind: "tail" }; maxEntries: number }; range: { anchor: { kind: "tail" }; maxBlocks: number; maxBytes: number } }
  liveScript?: { queuedText: string; interruptionText: string }; artifacts: SanitizableDictionary
}
export interface OutputSeamCorpus { version: number; generatedAt: "deterministic"; cases: CorpusCase[] }
export interface CorpusFailureOutcome { kind: "failure"; entrypoint: string; errorKind: string; eventType: string; aggregateId: string; position?: number; diagnostic: string }
export interface CorpusDecorationOutcome { kind: "success"; entrypoint: string; omittedMalformedDecoration: true; decorationCount: number }

/** The one project directory every sanitized corpus path is written against:
 *  the sanitizer rewrites real directories to it, and a replay resolves
 *  rendered paths from the session metadata that carries it. */
export const SANITIZED_PROJECT_DIR = "/workspace/sanitized-project"
const SESSION_FACT_TYPES = new Set(["session.created", "workflow.worker_boundary.recorded", "child_run.created", "subagent.prompted", "agent.subagent.dispatched", "agent.subagent_model.selected", "tool.input.completed", "tool.result.recorded", "subagent.completed"])

export async function generateOutputSeamCorpus(reader: EventReader, manifest: CorpusManifest, temporaryRoot: string): Promise<OutputSeamCorpus> {
  const cases: CorpusCase[] = []
  for (const [caseIndex, selection] of manifest.cases.entries()) {
    const extracted = resolveFacts(reader, selection)
    const sourceSessionId = selection.source.kind === "extracted" ? selection.source.sessionId : extracted[0]?.sessionId ?? (() => { throw new Error(`Inline fixture ${selection.id} has no facts`) })()
    const sourceConversationId = selection.source.kind === "extracted" ? selection.source.conversationId : inlineConversationId(extracted)
    const aliases = buildAliases(extracted, sourceSessionId, sourceConversationId, caseIndex)
    const facts = extracted.map((event, index) => sanitizeEvent(event, aliases, caseIndex, index))
    const sessionId = aliasFor(aliases, sourceSessionId)
    const conversationId = sourceConversationId ? aliasFor(aliases, sourceConversationId) : undefined
    const requests = corpusRequests(selection.id)
    const liveScript = selection.id === "chat-tool-outcomes" ? { queuedText: "sanitized queued message", interruptionText: "Sanitized stream interrupted" } : undefined
    const corpusCase: CorpusCase = { id: selection.id, source: { kind: selection.source.kind }, kind: sourceConversationId ? "chat" : "workflow", sessionId, ...(conversationId ? { conversationId } : {}), facts, requests, ...(liveScript ? { liveScript } : {}), artifacts: {} }
    const inlineFixture = selection.source.kind === "inline" ? outputSeamInlineFixtures[selection.source.fixtureId] : undefined
    corpusCase.artifacts = await projectArtifacts(corpusCase, selection.artifacts, join(temporaryRoot, `case-${caseIndex + 1}`), inlineFixture && "corruptPayloadBytes" in inlineFixture && typeof inlineFixture.corruptPayloadBytes === "string" ? inlineFixture.corruptPayloadBytes : undefined)
    cases.push(corpusCase)
  }
  return { version: manifest.version, generatedAt: "deterministic", cases }
}

/** Reprojects derived artifacts from the committed sanitized facts without
 * extracting or sanitizing source events again. An extracted case's facts
 * first take the conversions a project store runs when it opens, so a fact
 * version bump reaches the corpus the way it reaches a person's store. */
export async function refreshOutputSeamCorpus(corpus: OutputSeamCorpus, manifest: CorpusManifest, temporaryRoot: string): Promise<OutputSeamCorpus> {
  if (corpus.version !== manifest.version) throw new Error(`Corpus version ${corpus.version} does not match manifest version ${manifest.version}`)
  if (corpus.cases.length !== manifest.cases.length) throw new Error("Corpus cases do not match manifest cases")
  const cases: CorpusCase[] = []
  for (const [caseIndex, selection] of manifest.cases.entries()) {
    const source = corpus.cases[caseIndex]
    if (!source || source.id !== selection.id || source.source.kind !== selection.source.kind) throw new Error(`Corpus case ${caseIndex + 1} does not match manifest case ${selection.id}`)
    const facts = source.source.kind === "extracted" && source.kind === "chat" ? convertedCorpusFacts(source, join(temporaryRoot, `conversion-${caseIndex + 1}`)) : source.facts
    const corpusCase: CorpusCase = { ...source, facts, requests: corpusRequests(selection.id), artifacts: {} }
    const inlineFixture = selection.source.kind === "inline" ? outputSeamInlineFixtures[selection.source.fixtureId] : undefined
    const corruptPayloadBytes = inlineFixture && "corruptPayloadBytes" in inlineFixture && typeof inlineFixture.corruptPayloadBytes === "string" ? inlineFixture.corruptPayloadBytes : undefined
    corpusCase.artifacts = object(preserveObjectOrder(
      await projectArtifacts(corpusCase, selection.artifacts, join(temporaryRoot, `case-${caseIndex + 1}`), corruptPayloadBytes),
      source.artifacts,
    ))
    cases.push(corpusCase)
  }
  return { version: corpus.version, generatedAt: "deterministic", cases }
}

/** The case's facts after the stored-facts conversions and the agent input
 *  conversion, which a store runs in this order when it opens. Inline cases
 *  keep their facts: each one is a deliberate historical or malformed shape.
 *  A case keeps only its own rows, each converted in place. A pass can add
 *  rows after them, such as the parent chat that workflow adoption creates
 *  and its own markers, and those are not the case's facts. */
function convertedCorpusFacts(corpusCase: CorpusCase, root: string): EventStoreAppend[] {
  const projectRoot = join(root, "project")
  const accountHome = join(root, "home")
  const directories = { projectRoot, accountHome, userDataRoot: join(accountHome, ".flywheel") }
  mkdirSync(join(projectRoot, ".flywheel"), { recursive: true })
  mkdirSync(directories.userDataRoot, { recursive: true })
  const dbFile = resolveEventStoreDbFile(projectRoot)
  const writer = createSqliteEventStore(dbFile)
  try { writer.appendBatch(corpusCase.facts) } finally { writer.close() }
  for (const migration of installedWorkspaceMigrations("stored-facts", false, undefined, { dbFile, directories })) migration.run({ dbFile, directories })
  migrateAgentInputAnswers(dbFile)
  const reader = createSqliteEventStore(dbFile)
  try {
    const converted = reader.read().filter((fact) => fact.position <= corpusCase.facts.length)
    return converted.map((fact, index) => {
      const original = corpusCase.facts[index]
      if (original?.aggregateId !== fact.aggregateId || original.type !== fact.type) throw new Error(`Case ${corpusCase.id} fact ${index + 1} changed identity during conversion`)
      // The sanitizer writes every corpus object with sorted keys, and a converted row keeps that form.
      return { ...original, version: fact.version, payload: object(sortedKeys(fact.payload)) }
    })
  } finally { reader.close() }
}

/** A stored JSON value with every object's keys in sorted order. */
function sortedKeys(value: unknown): SanitizableValue {
  if (value === null || value === undefined || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value
  if (Array.isArray(value)) return value.map(sortedKeys)
  if (typeof value !== "object") throw new Error(`Stored fact holds a ${typeof value}, which JSON cannot hold`)
  // Keys are unique, so the comparison never meets two equal keys.
  return Object.fromEntries(Object.entries(value).toSorted(([left], [right]) => left < right ? -1 : 1).map(([key, child]) => [key, sortedKeys(child)]))
}

function corpusRequests(id: string): CorpusCase["requests"] {
  const workflowWorkers = id === "workflow-workers"
  return {
    history: { anchor: { kind: "tail" }, maxEntries: 12 },
    range: { anchor: { kind: "tail" }, maxBlocks: workflowWorkers ? 16 : 12, maxBytes: 32_768 },
  }
}

/** Writes canonical corpus facts in the historical shape accepted by the current production projection. The committed facts remain unchanged. */
export function appendOutputSeamCorpusFacts(store: { appendBatch: (events: readonly EventStoreAppend[]) => StoredFact[] }, corpusCase: CorpusCase): void {
  store.appendBatch(corpusCase.facts.map(projectableCorpusFact))
}

function projectableCorpusFact(fact: EventStoreAppend): EventStoreAppend {
  if (fact.type !== "workflow.control.initialized" || fact.version !== 1) return fact
  const control = object(sanitizable(fact.payload.control))
  const identity = object(control.definitionIdentity)
  if (!Array.isArray(identity.stepDefinitions)) throw new Error("Legacy corpus workflow identity has no step definitions")
  const bindings = identity.stepDefinitions.map((value) => {
    const step = object(value)
    if (typeof step.definitionId !== "string" || typeof step.sha256 !== "string") throw new Error("Legacy corpus workflow identity has an invalid step definition")
    return { bindingId: step.definitionId, sha256: step.sha256 }
  })
  if (!Array.isArray(control.attempts)) throw new Error("Legacy corpus workflow control has no attempts")
  const attempts = control.attempts.map((value) => {
    const attempt = object(value)
    const { reads: _reads, ...currentAttempt } = attempt
    return currentAttempt
  })
  const { stepDefinitions: _stepDefinitions, ...commonIdentity } = identity
  return {
    ...fact,
    version: 2,
    payload: {
      ...fact.payload,
      control: {
        ...control,
        attempts,
        definitionIdentity: { ...commonIdentity, bindings, personas: [] },
      },
    },
  }
}

export function parseOutputSeamManifest(value: SanitizableValue): CorpusManifest {
  const record = object(value)
  if (typeof record.version !== "number" || typeof record.source !== "string" || !Array.isArray(record.cases)) throw new Error("Invalid output-seam manifest")
  return { version: record.version, source: record.source, cases: record.cases.map((raw): CorpusManifestCase => {
    const item = object(raw)
    if (typeof item.id !== "string" || !Array.isArray(item.artifacts)) throw new Error("Invalid output-seam case")
    return { id: item.id, source: parseSource(item.source), coverage: Object.fromEntries(Object.entries(object(item.coverage)).map(([key, artifacts]) => [key, strings(artifacts)])), artifacts: strings(item.artifacts) }
  }) }
}

export function parseOutputSeamCorpus(value: SanitizableValue): OutputSeamCorpus {
  const corpus = object(value)
  if (typeof corpus.version !== "number" || corpus.generatedAt !== "deterministic" || !Array.isArray(corpus.cases)) throw new Error("Invalid output-seam corpus")
  return { version: corpus.version, generatedAt: "deterministic", cases: corpus.cases.map(parseCorpusCase) }
}

function parseCorpusCase(value: SanitizableValue): CorpusCase {
  const item = object(value)
  const source = object(item.source)
  const history = object(object(item.requests).history)
  const range = object(object(item.requests).range)
  const historyAnchor = object(history.anchor)
  const rangeAnchor = object(range.anchor)
  const liveScript = item.liveScript === undefined ? undefined : object(item.liveScript)
  if (
    typeof item.id !== "string"
    || (source.kind !== "extracted" && source.kind !== "inline")
    || (item.kind !== "chat" && item.kind !== "workflow")
    || typeof item.sessionId !== "string"
    || (item.conversationId !== undefined && typeof item.conversationId !== "string")
    || !Array.isArray(item.facts)
    || historyAnchor.kind !== "tail"
    || typeof history.maxEntries !== "number"
    || rangeAnchor.kind !== "tail"
    || typeof range.maxBlocks !== "number"
    || typeof range.maxBytes !== "number"
    || (liveScript !== undefined && (typeof liveScript.queuedText !== "string" || typeof liveScript.interruptionText !== "string"))
  ) throw new Error("Invalid output-seam corpus case")
  return {
    id: item.id,
    source: { kind: source.kind },
    kind: item.kind,
    sessionId: item.sessionId,
    ...(typeof item.conversationId === "string" ? { conversationId: item.conversationId } : {}),
    facts: item.facts.map(parseCorpusFact),
    requests: { history: { anchor: { kind: "tail" }, maxEntries: history.maxEntries }, range: { anchor: { kind: "tail" }, maxBlocks: range.maxBlocks, maxBytes: range.maxBytes } },
    ...(liveScript ? { liveScript: { queuedText: String(liveScript.queuedText), interruptionText: String(liveScript.interruptionText) } } : {}),
    artifacts: object(item.artifacts),
  }
}

function parseCorpusFact(value: SanitizableValue): EventStoreAppend {
  const fact = object(value)
  if (typeof fact.aggregateId !== "string" || typeof fact.type !== "string" || typeof fact.version !== "number" || typeof fact.timestamp !== "number" || typeof fact.actor !== "string" || typeof fact.sessionId !== "string" || (fact.runId !== undefined && typeof fact.runId !== "string")) throw new Error("Invalid output-seam corpus fact")
  return { aggregateId: fact.aggregateId, type: fact.type, version: fact.version, timestamp: fact.timestamp, actor: fact.actor, sessionId: fact.sessionId, payload: object(fact.payload), ...(typeof fact.runId === "string" ? { runId: fact.runId } : {}) }
}

function parseSource(value: SanitizableValue): CorpusSource {
  const source = object(value)
  const keys = Object.keys(source).sort().join(",")
  if (source.kind === "inline" && typeof source.fixtureId === "string" && keys === "fixtureId,kind" && source.fixtureId in outputSeamInlineFixtures) return { kind: "inline", fixtureId: inlineFixtureId(source.fixtureId) }
  if (source.kind === "extracted" && typeof source.sessionId === "string" && typeof source.maxPosition === "number" && (keys === "kind,maxPosition,sessionId" || (keys === "conversationId,kind,maxPosition,sessionId" && typeof source.conversationId === "string"))) return { kind: "extracted", sessionId: source.sessionId, ...(typeof source.conversationId === "string" ? { conversationId: source.conversationId } : {}), maxPosition: source.maxPosition }
  throw new Error("Invalid output-seam source")
}
function inlineFixtureId(value: string): OutputSeamInlineFixtureId {
  if (
    value === "old-session-created-v1"
    || value === "retired-field"
    || value === "unknown-version"
    || value === "newer-version-fence"
    || value === "corrupt-json-creation"
    || value === "decoration-fact-failure"
    || value === "mutation-before-creation"
    || value === "reconcile-tombstone"
  ) return value
  throw new Error("Invalid output-seam source")
}

function resolveFacts(reader: EventReader, selection: CorpusManifestCase): StoredFact[] {
  if (selection.source.kind === "extracted") return extractFacts(reader, selection.id, selection.source)
  const sessionId = `inline-session-${selection.id}`
  return outputSeamInlineFixtures[selection.source.fixtureId].facts.map((fact, index) => ({ id: `inline-${selection.id}-${index}`, position: index + 1, seq: index + 1, aggregateId: `session:${sessionId}`, sessionId, type: fact.type, version: fact.version, actor: "flywheel", timestamp: index + 1, payload: object(JSON.parse(fact.payloadBytes)) }))
}
function inlineConversationId(events: readonly StoredFact[]): string | undefined { const created = events.find((event) => event.type === "session.created"); return typeof created?.payload.conversationId === "string" ? created.payload.conversationId : undefined }

function extractFacts(reader: EventReader, id: string, selection: Extract<CorpusSource, { kind: "extracted" }>): StoredFact[] {
  const sessionFacts = reader.read({ aggregateId: `session:${selection.sessionId}` }).filter((event) => event.position <= selection.maxPosition)
  const created = sessionFacts.find((event) => event.type === "session.created")
  if (!created) throw new Error(`Missing session.created for ${selection.sessionId}`)
  if (selection.conversationId) {
    const conversation = reader.read({ aggregateId: `conversation:${selection.conversationId}` }).filter((event) => event.position <= selection.maxPosition)
    const tree = conversation.find((event) => event.type === "chat.tree.created")
    if (!tree) throw new Error(`Missing chat tree ${selection.conversationId}`)
    const committed = conversation.filter((event) => event.type === "chat.entries.appended")
    const selectedIndex = committed.findLastIndex((event) => id === "chat-compaction" ? entries(event).some((entry) => object(entry).kind === "compaction") : entries(event).some(isOutcomeEntry))
    if (selectedIndex < 0) throw new Error(`No selected semantic entry in ${id}`)
    return [created, tree, ...committed.slice(0, selectedIndex + 1)].sort(byPosition)
  }
  const selectedSession = sessionFacts.filter((event) => SESSION_FACT_TYPES.has(event.type))
  const workflowFacts = reader.read({ aggregateId: `workflow:${selection.sessionId}` }).filter((event) => event.position <= selection.maxPosition)
  const conversationIds = workflowFacts.filter((event) => event.type === "step.resume_state.recorded").map((event) => event.payload.conversationId).filter((value): value is string => typeof value === "string")
  const conversationFacts = conversationIds.flatMap((conversationId) => reader.read({ aggregateId: `conversation:${conversationId}` }).filter((event) => event.position <= selection.maxPosition && (event.type === "chat.tree.created" || event.type === "chat.entries.appended")))
  return [...selectedSession, ...workflowFacts, ...conversationFacts].sort(byPosition)
}
function entries(event: StoredFact): SanitizableValue[] { return Array.isArray(event.payload.entries) ? event.payload.entries.map((entry) => sanitizable(entry)) : [] }
function isOutcomeEntry(value: SanitizableValue): boolean { if (!value || typeof value !== "object" || Array.isArray(value)) return false; const message = "message" in value && value.message && typeof value.message === "object" && !Array.isArray(value.message) ? value.message : undefined; return message !== undefined && "kind" in message && message.kind === "toolResult" && (("isError" in message && message.isError === true) || ("interrupted" in message && message.interrupted === true)) }
function byPosition(left: StoredFact, right: StoredFact): number { return left.position - right.position }

function buildAliases(events: readonly StoredFact[], sourceSessionId: string, sourceConversationId: string | undefined, caseIndex: number): Map<string, string> {
  const aliases = new Map<string, string>([[sourceSessionId, `sanitized-case-session-${caseIndex + 1}`]])
  if (sourceConversationId) aliases.set(sourceConversationId, `sanitized-case-conversation-${caseIndex + 1}`)
  const ids: string[] = []
  const visit = (value: SanitizableValue, key = ""): void => {
    if (typeof value === "string" && /(?:^id$|Id$|_id$)/.test(key)) ids.push(value)
    else if (Array.isArray(value)) for (const item of value) visit(item, key)
    else if (value && typeof value === "object") for (const [childKey, child] of Object.entries(value)) visit(child, childKey)
  }
  for (const event of events) { ids.push(event.aggregateId.replace(/^[^:]+:/, "")); if (event.runId) ids.push(event.runId); visit(sanitizable(event.payload)) }
  for (const id of [...new Set(ids)].sort()) if (!aliases.has(id)) aliases.set(id, /(?:alias-|corpus-|sanitized-)/.test(id) ? id : `alias-${caseIndex + 1}-${aliases.size + 1}`)
  return aliases
}
function sanitizeEvent(event: StoredFact, aliases: ReadonlyMap<string, string>, caseIndex: number, eventIndex: number): EventStoreAppend {
  return { aggregateId: replaceAliases(event.aggregateId, aliases), type: event.type, version: event.version, timestamp: 1_700_000_000_000 + caseIndex * 100_000 + eventIndex * 1_000, actor: event.actor, sessionId: aliasFor(aliases, event.sessionId), payload: object(sanitize(sanitizable(event.payload), aliases, "payload", eventIndex)), ...(event.runId ? { runId: aliasFor(aliases, event.runId) } : {}) }
}
function sanitize(value: SanitizableValue, aliases: ReadonlyMap<string, string>, key: string, index: number): SanitizableValue {
  if (typeof value === "string") {
    const replaced = replaceAliases(value, aliases)
      .replace(/\/(?:Users|home)\/[^/\s"']+(?:\/[^\s"']*)?/g, "/workspace/sanitized-project")
      .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "sanitized-email")
      .replace(/\b(?:sk|ghp|github_pat|xox[baprs])-[_A-Za-z0-9-]{12,}\b/g, "sanitized-secret")
    if (/timestamp|createdAt|updatedAt|lastUpdated|activatedAt/.test(key) || /^\d{4}-\d\d-\d\dT/.test(value)) return new Date(1_700_000_000_000 + index * 1_000).toISOString()
    if (key === "executionCwd") return SANITIZED_PROJECT_DIR
    if (key === "path" || key === "planPath") return key === "path" ? "src/sanitized-example.ts" : "sanitized workflow request"
    if (key === "command") return value === "chat" || value === "workflow" ? value : "printf sanitized"
    if (key === "name" && ["subagent", "read", "search", "list", "write", "edit", "replace", "bash"].includes(value)) return value
    if (["label", "name", "description", "feature"].includes(key)) return `Sanitized ${key}`
    if (["text", "summary", "content", "contentPreview", "inputPreview", "displayContent", "documentation_digest", "error", "errorMessage", "prompt", "systemPrompt", "rationale", "new", "old", "diff", "output", "detail"].includes(key)) return semanticText(replaced)
    return replaced
  }
  if (Array.isArray(value)) return value.map((item) => sanitize(item, aliases, key, index))
  if (!value || typeof value !== "object") return value
  const source = object(value)
  const sanitized = Object.fromEntries(Object.keys(source).sort().map((childKey) => [childKey, sanitize(source[childKey], aliases, childKey, index)]))
  if (source.kind === "compaction" && sanitized.tokensAfter === undefined && typeof source.tokensBefore === "number") sanitized.tokensAfter = Math.floor(source.tokensBefore / 2)
  return sanitized
}
function semanticText(value: string): string { if (["Sanitized interrupted tool output", "Sanitized tool failure", "Sanitized compaction summary", "Sanitized recorded content"].includes(value)) return value; const lower = value.toLowerCase(); if (lower.includes("aborted") || lower.includes("interrupt")) return "Sanitized interrupted tool output"; if (lower.includes("failed") || lower.includes("error") || lower.includes("invalid")) return "Sanitized tool failure"; if (lower.includes("compaction") || lower.includes("language model started")) return "Sanitized compaction summary"; return "Sanitized recorded content" }
function replaceAliases(value: string, aliases: ReadonlyMap<string, string>): string { let result = value; for (const [source, alias] of aliases) result = result.replaceAll(source, alias); return result }
function aliasFor(aliases: ReadonlyMap<string, string>, source: string): string { return aliases.get(source) ?? source }

async function projectArtifacts(corpusCase: CorpusCase, requested: readonly string[], root: string, corruptPayloadBytes?: string): Promise<SanitizableDictionary> {
  const path = join(root, "facts.sqlite")
  let store = openOutputSeamCorpus(corpusCase, root)
  store.close()
  if (corruptPayloadBytes !== undefined) corruptPersistedCreation(path, corpusCase.sessionId, corruptPayloadBytes)
  store = createSqliteEventStore(path)
  try {
    if (requested.length === 1 && requested[0] === "decorationOutcomes") return object(sanitizable({ decorationOutcomes: await decorationFailureOutcomes(store, corpusCase) }))
    const metadata = await readSessionMetadata(asAsyncEventReadSurface(store), corpusCase.sessionId)
    const projection = createSessionDetailProjection({
      projectRoot: root,
      sessionStore: { get: () => undefined },
      manager: {
        read: async (id) => id === corpusCase.sessionId
          ? (corpusCase.source.kind === "inline"
              ? (metadata ? { ...metadata, executionCwd: root } : null)
              : extractedSessionMetadata(corpusCase, root))
          : readSessionMetadata(asAsyncEventReadSurface(store), id),
      },
      reader: asAsyncEventReadSurface(store),
      projectionReader: asAsyncEventReadSurface(store),
    })
    const artifacts: { [key: string]: unknown } = {}
    if (requested.includes("metadataOutcome")) artifacts.metadataOutcome = metadata ? { kind: "success", metadata } : metadataFailureOutcome(corpusCase)
    const outputWindow = await projection.outputWindow(corpusCase.sessionId, corpusCase.requests.range)
    const range = outputWindow.range
    if (requested.includes("history")) artifacts.history = { consistencyToken: range.consistencyToken, totalBlocks: outputWindow.totalBlocks, window: range.window, ...(range.kind === "unavailable" ? { unavailable: range.unavailable } : {}) }
    if (requested.includes("range")) artifacts.range = range
    if (requested.includes("boundedRange")) artifacts.boundedRange = await projection.outputRange(corpusCase.sessionId, { anchor: { kind: "tail" }, maxBlocks: 4, maxBytes: 4096 })
    // A workflow has no transcript: each agent's view reads that agent's
    // conversation, so its blocks come from the agent whose view holds the
    // most of them.
    const agent = requested.includes("agentRange") ? await longestAgentOutput(projection, asAsyncEventReadSurface(store), corpusCase) : undefined
    if (agent) artifacts.agentRange = agent.range
    const bodyRange = agent?.range ?? range
    const outputSessionId = agent?.sessionId ?? corpusCase.sessionId
    if (bodyRange.kind === "ok") {
      const group = bodyRange.blocks.find((block) => block.kind === "agentGroup")
      if (requested.includes("groupChildren") && group?.kind === "agentGroup") artifacts.groupChildren = await projection.outputGroupChildren(outputSessionId, { groupBlockIds: [`tool:${group.id}`], maxBytes: 1024 * 1024 })
      const tool = bodyRange.blocks.find((block) => block.kind === "tool" && (block.content !== undefined || block.diff !== undefined)) ?? bodyRange.blocks.find((block) => block.kind === "tool")
      if (requested.includes("toolBody") && tool?.kind === "tool") artifacts.toolBody = await projection.outputBlockBody(outputSessionId, { blockId: `tool:${tool.id}` })
    }
    if (corpusCase.liveScript) Object.assign(artifacts, await liveArtifacts(corpusCase, root))
    if (requested.includes("decorationOutcomes")) artifacts.decorationOutcomes = await decorationFailureOutcomes(store, corpusCase)
    for (const name of requested) {
      if (name in artifacts) continue
      const rangeSummary = range.kind === "ok" ? `${range.blocks.length} blocks (${range.blocks.map((block) => block.kind).join(", ")})` : range.kind
      throw new Error(`Case ${corpusCase.id} did not produce ${name}; range contained ${rangeSummary}`)
    }
    return normalizeProjectionRoot(artifacts, root)
  } finally { store.close() }
}

/** Opens frozen bytes through the installed conversions before reading current member output. */
export function openOutputSeamCorpus(corpusCase: CorpusCase, root: string) {
  const dbFile = join(root, "facts.sqlite")
  const store = createSqliteEventStore(dbFile)
  appendOutputSeamCorpusFacts(store, corpusCase)
  if (corpusCase.kind !== "workflow") return store
  store.close()
  const directories = { projectRoot: root, executionCwd: root, accountHome: join(root, "home"), userDataRoot: join(root, "home", ".flywheel") }
  mkdirSync(directories.userDataRoot, { recursive: true })
  for (const migration of installedWorkspaceMigrations("stored-facts", false, undefined, { dbFile, directories })) migration.run({ dbFile, directories })
  migrateAgentInputAnswers(dbFile)
  return createSqliteEventStore(dbFile)
}

/** The view of the workflow agent whose conversation holds the most blocks. */
export async function longestAgentOutput(projection: Pick<ReturnType<typeof createSessionDetailProjection>, "outputRange">, reader: AsyncEventStateReadSurface, corpusCase: CorpusCase) {
  const members = await workflowMembershipReader(reader).list(corpusCase.sessionId)
  const outputs = await Promise.all(members.map(async ({ sessionId }) => ({ sessionId, range: await projection.outputRange(sessionId, corpusCase.requests.range) })))
  return outputs.reduce<(typeof outputs)[number] | undefined>((longest, output) => output.range.kind === "ok" && (longest?.range.kind !== "ok" || output.range.blocks.length > longest.range.blocks.length) ? output : longest, undefined)
}

function metadataFailureOutcome(corpusCase: CorpusCase): CorpusFailureOutcome {
  const fact = corpusCase.facts.find((item) => item.type.startsWith("session.")) ?? corpusCase.facts[0]
  if (!fact) throw new Error(`Case ${corpusCase.id} has no fact for its metadata failure`)
  return { kind: "failure", entrypoint: "readSessionMetadata", errorKind: "metadata-unavailable", eventType: fact.type, aggregateId: fact.aggregateId, position: corpusCase.facts.indexOf(fact) + 1, diagnostic: "Session metadata is unavailable because the persisted fact does not satisfy the registered projection contract." }
}

async function decorationFailureOutcomes(reader: EventStoreReadSurface, corpusCase: CorpusCase): Promise<CorpusDecorationOutcome[]> {
  const projectionReader = asAsyncEventReadSurface(reader)
  const boundaries = [
    ["readToolResultDisplayMeta", async () => (await readToolResultDisplayMeta(projectionReader, corpusCase.sessionId)).size],
    ["readSubagentRunsByToolUseId", async () => (await readSubagentRunsByToolUseId(projectionReader, corpusCase.sessionId)).size],
  ] as const
  const outcomes: CorpusDecorationOutcome[] = []
  for (const [entrypoint, invoke] of boundaries) {
    outcomes.push({ kind: "success", entrypoint, omittedMalformedDecoration: true, decorationCount: await invoke() })
  }
  return outcomes
}

function extractedSessionMetadata(corpusCase: CorpusCase, executionCwd: string) {
  const payload = corpusCase.facts.find((fact) => fact.type === "session.created")?.payload
  if (!payload) throw new Error(`Case ${corpusCase.id} has no metadata`)
  const common = { label: "Sanitized session", lastUpdated: "2023-11-14T22:13:20.000Z", lifecycleState: "inactive" as const, name: "Sanitized session", executionCwd }
  return payload.kind === "workflow" ? null : { ...common, kind: "chat" as const, command: "chat" as const, conversationId: String(payload.conversationId) }
}

function normalizeProjectionRoot(value: unknown, root: string): SanitizableDictionary {
  return object(normalizeProjectionValue(sanitizable(value), realpathSync(root)))
}

function preserveObjectOrder(value: SanitizableValue, template: SanitizableValue): SanitizableValue {
  if (Array.isArray(value)) {
    const templateItems = Array.isArray(template) ? template : []
    return value.map((item, index) => preserveObjectOrder(item, templateItems[index]))
  }
  if (!value || typeof value !== "object") return value
  const source = object(value)
  const templateObject = template && typeof template === "object" && !Array.isArray(template) ? object(template) : {}
  const existingKeys = Object.keys(templateObject).filter((key) => key in source)
  const newKeys = Object.keys(source).filter((key) => !(key in templateObject)).sort()
  return Object.fromEntries([...existingKeys, ...newKeys].map((key) => [key, preserveObjectOrder(source[key], templateObject[key])]))
}

function normalizeProjectionValue(value: SanitizableValue, root: string): SanitizableValue {
  if (typeof value === "string") return value.replaceAll(root, SANITIZED_PROJECT_DIR).replace(/(?:\.\.\/)+tmp\/flywheel-uat-tabswitch\.sh/g, "../../tmp/flywheel-uat-tabswitch.sh")
  if (Array.isArray(value)) return value.map((item) => normalizeProjectionValue(item, root))
  if (!value || typeof value !== "object") return value
  const source = object(value)
  const normalized = Object.fromEntries(Object.entries(source).map(([key, item]) => [key, normalizeProjectionValue(item, root)]))
  const sourceWindow = source.window
  if (Array.isArray(source.blocks) && sourceWindow && typeof sourceWindow === "object" && !Array.isArray(sourceWindow)) {
    const normalizedWindow = object(normalized.window)
    if (typeof normalizedWindow.contentBytes === "number") {
      const contentBytesDelta = metricRelevantLengthDelta(source.blocks, normalized.blocks)
      normalized.window = { ...normalizedWindow, contentBytes: normalizedWindow.contentBytes + contentBytesDelta }
    }
  }
  const normalizedHistory = normalized.history
  const normalizedRange = normalized.range
  if (normalizedHistory && typeof normalizedHistory === "object" && !Array.isArray(normalizedHistory) && normalizedRange && typeof normalizedRange === "object" && !Array.isArray(normalizedRange)) {
    const history = object(normalizedHistory)
    const range = object(normalizedRange)
    if (range.window !== undefined) normalized.history = { ...history, window: range.window }
  }
  return normalized
}

function metricRelevantLengthDelta(source: SanitizableValue, normalized: SanitizableValue, key = ""): number {
  if (typeof source === "string" && typeof normalized === "string") return key === "detail" ? normalized.length - source.length : 0
  if (Array.isArray(source) && Array.isArray(normalized)) return source.reduce<number>((sum, item, index) => sum + metricRelevantLengthDelta(item, normalized[index]), 0)
  if (!source || !normalized || typeof source !== "object" || typeof normalized !== "object" || Array.isArray(source) || Array.isArray(normalized)) return 0
  const sourceRecord = object(source)
  const normalizedRecord = object(normalized)
  return Object.entries(sourceRecord).reduce((sum, [childKey, item]) => sum + metricRelevantLengthDelta(item, normalizedRecord[childKey], childKey), 0)
}
export function corruptPersistedCreation(path: string, sessionId: string, payloadBytes: string): void {
  const db = new Database(path)
  try {
    const rowsBefore = db.query<{ position: number; payload: string; type: string }, { $sessionId: string }>("select position, cast(payload as text) as payload, type from event where session_id = $sessionId order by position").all({ $sessionId: sessionId })
    const targetBefore = rowsBefore.find((row) => row.type === "session.created")
    if (!targetBefore || targetBefore.payload === payloadBytes) throw new Error("Corrupt-json target bytes must change")
    db.exec("begin immediate")
    db.query("update event set payload = $payload where session_id = $sessionId and type = 'session.created'").run({ $payload: payloadBytes, $sessionId: sessionId })
    const changed = factRowsChanged(db)
    if (changed !== 1) throw new Error(`Expected one corrupt-json target row, changed ${changed}`)
    db.exec("commit")
    const rowsAfter = db.query<{ position: number; payload: string; type: string }, { $sessionId: string }>("select position, cast(payload as text) as payload, type from event where session_id = $sessionId order by position").all({ $sessionId: sessionId })
    expectIntegrity(rowsBefore.filter((row) => row.position !== targetBefore.position), rowsAfter.filter((row) => row.position !== targetBefore.position), "non-target event rows")
    if (rowsAfter.find((row) => row.position === targetBefore.position)?.payload !== payloadBytes) throw new Error("Corrupt-json target bytes did not change to the requested payload")
  } catch (error) { if (db.inTransaction) db.exec("rollback"); throw error } finally { db.close() }
}

function expectIntegrity(before: SanitizableValue, after: SanitizableValue, label: string): void {
  if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error(`Corruption changed ${label}`)
}
async function liveArtifacts(corpusCase: CorpusCase, root: string): Promise<SanitizableDictionary> {
  if (!corpusCase.liveScript || !corpusCase.conversationId) return {}
  const runtime = ManagedRuntime.make(EventStoreLive(join(root, "live.sqlite")))
  const eventStore = runtime.runSync(EventStoreService)
  const sessionStore = createSessionStore(runtime, runtime.runSync(EventReaderService))
  sessionStore.openSessionRuntime({ sessionId: corpusCase.sessionId, conversationId: corpusCase.conversationId })
  const sequencer = createRuntimeUiPatchSequencer(); const patches: RuntimeUiPatch[] = []
  const outputProjection = createOutputProjection({ sessionStore, shipped: createShippedOutput({ publish: (input) => { const patch = sequencer.publish(input); patches.push(patch); return patch } }) })
  const output = createOutputSession({ sessionId: corpusCase.sessionId, executionCwd: SANITIZED_PROJECT_DIR, updateEntry: (patch) => sessionStore.updateChatEntry(corpusCase.sessionId, patch) })
  try {
    patches.length = 0
    output.pushUserMessage(corpusCase.liveScript.queuedText, 1_700_000_000_000, { queued: true })
    output.pushSystemMessage(corpusCase.liveScript.interruptionText, 1_700_000_001_000, { level: "error" }); output.flush()
    const recalled = output.recallQueued(); output.flush(); await new Promise<void>((done) => { setTimeout(done, 0) })
    const deltas = patches.flatMap((patch) => patch.payload.kind === "output.delta" ? [patch.payload.delta] : [])
    return object(sanitizable({ liveDeltas: deltas, liveSignals: { recalled, hasQueued: output.hasQueued(), blocks: output.getBlocks() } }))
  } finally { output.dispose(); outputProjection.dispose(); eventStore.close(); await runtime.dispose() }
}

export function serializeOutputSeamCorpus(corpus: OutputSeamCorpus, manifest: CorpusManifest): string {
  let bytes = `${JSON.stringify(corpus, null, 2)}\n`
  const generatedIds = new Map<string, string>()
  bytes = bytes.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/gi, (id) => {
    let alias = generatedIds.get(id)
    if (!alias) { alias = `sanitized-uuid-${generatedIds.size + 1}`; generatedIds.set(id, alias) }
    return alias
  })
  assertCorpusSanitized(bytes, manifest)
  return bytes
}

export function assertCorpusSanitized(bytes: string, manifest: CorpusManifest): void {
  const sourceIds = manifest.cases.flatMap((item) => item.source.kind === "extracted" ? [item.source.sessionId, item.source.conversationId].filter((id): id is string => id !== undefined && !id.startsWith("sanitized-")) : [])
  const forbidden = [/(?:\/(?:Users|home)\/[^/\s"']+)/, /[A-Za-z]:\\Users\\[^\\\s"']+/, /\b(?:sk|ghp|github_pat|xox[baprs])-[_A-Za-z0-9-]{12,}\b/, /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/, /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i, /inspiration\//, /harness-maps/, ...sourceIds.map((id) => new RegExp(id, "g"))]
  const match = forbidden.find((pattern) => pattern.test(bytes)); if (match) throw new Error(`Refusing unsanitized corpus (${match.source})`)
}
function object(value: SanitizableValue): SanitizableDictionary {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected object")
  return value
}
function strings(value: SanitizableValue): string[] {
  if (!Array.isArray(value)) throw new Error("Expected strings")
  const result: string[] = []
  for (const item of value) {
    if (typeof item !== "string") throw new Error("Expected strings")
    result.push(item)
  }
  return result
}
function sanitizable(value: unknown): SanitizableValue {
  // oxlint-disable-next-line unicorn/prefer-structured-clone -- boundary: JSON serialization removes undefined properties before the corpus is normalized.
  return JSON.parse(JSON.stringify(value))
}

async function main(): Promise<void> {
  const args = new Map<string, string>()
  for (let index = 2; index < process.argv.length; index += 2) { const key = process.argv[index]; const value = process.argv[index + 1]; if (!key?.startsWith("--") || !value) throw new Error("Usage: --store PATH --manifest PATH --output PATH"); args.set(key.slice(2), value) }
  const manifestPath = resolve(args.get("manifest") ?? "tests/fixtures/output-seam-corpus/manifest.json"); const outputPath = resolve(args.get("output") ?? "tests/fixtures/output-seam-corpus/corpus.json")
  const manifest = parseOutputSeamManifest(await Bun.file(manifestPath).json()); const temporaryRoot = `${outputPath}.projection-${process.pid}`
  try {
    const storePath = args.get("store")
    const corpus = storePath
      ? await withEventReader(resolve(storePath), (source) => generateOutputSeamCorpus(source, manifest, temporaryRoot))
      : await refreshOutputSeamCorpus(parseOutputSeamCorpus(await Bun.file(outputPath).json()), manifest, temporaryRoot)
    const bytes = serializeOutputSeamCorpus(corpus, manifest); const temporary = `${outputPath}.tmp-${process.pid}`; writeFileSync(temporary, bytes, { encoding: "utf8", mode: 0o600 }); renameSync(temporary, outputPath); console.log(`${storePath ? "extracted" : "refreshed"} ${corpus.cases.length} sanitized output-seam cases at ${outputPath}`)
  } finally { rmSync(temporaryRoot, { recursive: true, force: true }) }
}

async function withEventReader<T>(path: string, use: (reader: EventReader) => Promise<T>): Promise<T> {
  const reader = createSqliteEventStore(path)
  try { return await use(reader) }
  finally { reader.close() }
}
if (import.meta.main) await main()