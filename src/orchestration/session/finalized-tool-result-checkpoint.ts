import { Schema } from "effect";
import { errorMessage } from "../../infra/error-message.js";
import { Log } from "../../infra/log.js";
import { extractToolContentFact } from "../../infra/tool-content-extraction.js";
import { hydrateToolContentFact } from "../../infra/tool-content-hydration.js";
import { createRuntimeEvent } from "../../infra/runtime-event-factory.js";
import { mapRuntimeEventToSessionRuntimeFacts } from "../../infra/runtime-fact-mapper.js";
import { LlmToolOutputPartSchema } from "../../infra/llm/tool-output-part-schema.js";
import { TOOL_OUTCOME_VALUES } from "../../infra/tool-outcome.js";
import {
  InFlightSwapConflictError,
  requireGuardedEventAppender,
  type AsyncEventStateReadSurface,
  type AsyncEventWriter,
  type GuardedEventStoreAppend,
  type InFlightRecord,
  type InFlightWrite,
} from "../../infra/event-store-types.js";
import { toolResultMessages } from "../agent-runtime/agent-state.js";
import type { ConversationTree } from "./conversation/conversation-tree.js";
import { parseSessionRuntimeFact, type SessionRuntimeFact } from "./session-runtime-event-types.js";
import { prepareSessionFactAppend, type SessionFactWriter } from "./session-fact-writer.js";
import { enforceTurnBudget } from "../agent-runtime/compaction/truncation.js";
import { turnBudgetChars } from "../agent-runtime/compaction/compaction-policy.js";
import { openToolExchangeSuffix } from "./conversation/conversation-tree-context.js";
import { MutationEvidenceResultDetailsSchema } from "../../infra/runtime-mutation-evidence.js";

export const FINALIZED_TOOL_RESULT_IN_FLIGHT_KIND = "finalized-tool-result";

/** Inline mutation evidence written before 2026-10-16 is normalized at the family recovery boundary. Remove this conversion after 2027-04-16. */
export const UnversionedFinalizedToolResultCheckpointSchema = Schema.Struct({
  conversationId: Schema.String,
  toolUseId: Schema.String,
  toolName: Schema.String,
  budgetExempt: Schema.Boolean,
  /** The batch bound in force when the result was finalized. Every current write sets it. */
  turnBudgetChars: Schema.optionalKey(Schema.Number),
  /** Cells written before 2026-10-27 record the context window instead, and
   *  recovery derives the fixed-share bound from it. Remove after 2027-04-27. */
  contextWindowTokens: Schema.optionalKey(Schema.Number),
  registrationOrdinal: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  content: Schema.mutable(Schema.Array(LlmToolOutputPartSchema)).check(Schema.isNonEmpty()),
  outcome: Schema.Literals(TOOL_OUTCOME_VALUES),
  details: Schema.optionalKey(Schema.Unknown),
  modelRequestId: Schema.optionalKey(Schema.String),
  parentToolUseId: Schema.optionalKey(Schema.String),
  contentTruncated: Schema.optionalKey(Schema.Boolean),
  originalContentBytes: Schema.optionalKey(Schema.Number),
  originalContentSha256: Schema.optionalKey(Schema.String),
  fullContentPath: Schema.optionalKey(Schema.String),
  semanticOutputTruncated: Schema.optionalKey(Schema.Boolean),
  byteOutputTruncated: Schema.optionalKey(Schema.Boolean),
  executionOutputTail: Schema.optionalKey(Schema.String),
});

// Field order is the encoded key order of every current write, so the
// bare-key shape is derived by omission rather than by reordering fields.
const { conversationId: _conversationId, toolName: _toolName, budgetExempt: _budgetExempt, turnBudgetChars: _turnBudgetChars, contextWindowTokens: _contextWindowTokens, registrationOrdinal: _registrationOrdinal, ...bareKeyFields } = UnversionedFinalizedToolResultCheckpointSchema.fields;
const BareKeyFinalizedToolResultCheckpointSchema = Schema.Struct(bareKeyFields);

export const FinalizedToolResultCheckpointSchema = Schema.Struct({
  ...UnversionedFinalizedToolResultCheckpointSchema.fields,
  version: Schema.Literal(2),
  details: Schema.optionalKey(MutationEvidenceResultDetailsSchema),
});

export type FinalizedToolResultCheckpoint = typeof FinalizedToolResultCheckpointSchema.Type;
type RecoverableCheckpoint = FinalizedToolResultCheckpoint | typeof UnversionedFinalizedToolResultCheckpointSchema.Type;

const decodeCheckpoint = Schema.decodeUnknownSync(FinalizedToolResultCheckpointSchema, { onExcessProperty: "error" });
/** Reads the pre-conversation checkpoint shape without inventing missing metadata. */
export const decodeLegacyFinalizedToolResultCheckpoint = Schema.decodeUnknownSync(BareKeyFinalizedToolResultCheckpointSchema, { onExcessProperty: "error" });
/** Decodes current and supported historical cells, rejecting unknown shapes without discarding their bytes. */
export const decodeRecoverableCheckpoint = Schema.decodeUnknownSync(Schema.Union([
  FinalizedToolResultCheckpointSchema, UnversionedFinalizedToolResultCheckpointSchema,
]), { onExcessProperty: "error" });
const log = Log.create({ service: "finalized-tool-result-checkpoint" });

export interface FinalizedToolResultCheckpointToken {
  readonly key: string;
  readonly raw: string;
}

/** Stores one strict finalized display result under its canonical tool-use ID
 * and returns the exact compare-and-swap token persistence wrote. */
export async function checkpointFinalizedToolResult(
  writer: SessionFactWriter | undefined,
  checkpoint: Omit<FinalizedToolResultCheckpoint, "version" | "details" | "turnBudgetChars" | "contextWindowTokens"> & { readonly turnBudgetChars: number; readonly details?: unknown },
): Promise<FinalizedToolResultCheckpointToken | null> {
  if (!writer?.putInFlight) return null;
  const parsed = decodeCheckpoint({ ...checkpoint, version: 2 });
  const key = checkpointKey(parsed.conversationId, parsed.toolUseId);
  const raw = JSON.stringify(parsed);
  await writer.putInFlight(FINALIZED_TOOL_RESULT_IN_FLIGHT_KIND, key, parsed);
  return { key, raw };
}

interface RecoverFinalizedToolResultCheckpointsOptions {
  readonly conversationId: string;
  readonly sessionId: string;
  readonly store: AsyncEventStateReadSurface;
  readonly writer: AsyncEventWriter;
  readonly tree: ConversationTree;
  readonly projectRoot?: string;
}

interface StoredCheckpoint {
  readonly checkpoint: RecoverableCheckpoint;
  readonly row: InFlightRecord;
}

/** The durable evidence recovery still owes. A recorded session result alone
 * does not close a tool exchange in its canonical conversation. */
export function finalizedToolResultRecoveryNeeds(checkpoint: RecoverableCheckpoint, evidence: {
  readonly results: ReadonlySet<string>;
  readonly executionOutput: ReadonlySet<string>;
  readonly derivatives: ReadonlySet<string>;
}) {
  return {
    result: !evidence.results.has(checkpoint.toolUseId),
    executionOutput: checkpoint.executionOutputTail !== undefined && !evidence.executionOutput.has(checkpoint.toolUseId),
    derivative: !evidence.derivatives.has(checkpoint.toolUseId),
  };
}

/** Converts strict finalized-result cells into the ordinary result facts and
 * conversation messages used by replay. Missing evidence and its exact-raw
 * cell retirements share one transaction. Existing result facts are reused,
 * and this path never has access to tool handlers. */
export async function recoverFinalizedToolResultCheckpoints(
  input: RecoverFinalizedToolResultCheckpointsOptions,
): Promise<void> {
  const { createMutationEvidenceRecovery } = await import("./mutation-evidence-recovery.js");
  const options = { ...input, store: createMutationEvidenceRecovery(input.store, input.writer).reader };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const checkpoints = await readCheckpoints(options.store, options.sessionId, options.conversationId);
    if (checkpoints.length === 0) return;
    const appends = await buildRecoveryAppends(options, checkpoints);
    if (appends.length === 0) {
      if (await retireAlreadyRecorded(options, checkpoints)) return;
      if (attempt === 1) {
        const first = checkpoints[0];
        if (!first) throw new Error("Finalized result recovery lost its checkpoint set");
        throw new InFlightSwapConflictError(
          options.sessionId,
          FINALIZED_TOOL_RESULT_IN_FLIGHT_KIND,
          first.row.key,
        );
      }
      continue;
    }
    try {
      const result = await requireGuardedEventAppender(options.writer, "Finalized result recovery requires guarded append authority")
        .appendBatchGuarded(withRetirements(appends, checkpoints));
      if (result.kind === "stored") return;
      if (attempt === 0) continue;
      throw new Error("Finalized tool result recovery stayed sequence-contended", { cause: result.conflict });
    } catch (cause) {
      if (attempt === 0 && cause instanceof InFlightSwapConflictError) continue;
      throw cause;
    }
  }
}

/** A cell is a checkpoint another process must be able to finish, so one this
 *  release cannot decode is one it cannot finish: an older binary wrote it in
 *  a shape whose contract no longer exists. The cell is reported and left
 *  exactly as it is, never guessed at, and it does not stop the cells this
 *  release does understand from recovering (ARCH-SUBSTRATE-013). */
async function readCheckpoints(store: AsyncEventStateReadSurface, sessionId: string, conversationId: string): Promise<StoredCheckpoint[]> {
  const checkpoints: StoredCheckpoint[] = [];
  for (const row of await store.readInFlight(sessionId, FINALIZED_TOOL_RESULT_IN_FLIGHT_KIND, `${conversationId}:`)) {
    let checkpoint: RecoverableCheckpoint;
    try {
      checkpoint = decodeRecoverableCheckpoint(row.payload);
    } catch (error) {
      log.warn("finalized tool result checkpoint is in a shape this release cannot finish; leaving it in place", {
        sessionId, key: row.key, error: errorMessage(error),
      });
      continue;
    }
    if (checkpoint.conversationId === conversationId) checkpoints.push({ row, checkpoint });
  }
  return checkpoints.sort((left, right) => left.checkpoint.registrationOrdinal - right.checkpoint.registrationOrdinal);
}

async function readRecoveryEvidence(options: RecoverFinalizedToolResultCheckpointsOptions) {
  const evidence = await readSessionRecoveryEvidence(options);
  const state = await options.tree.getState();
  const derivatives = new Set(Object.values(state.entriesById).flatMap((entry) =>
    entry.kind === "message" && entry.message.kind === "toolResult" ? [entry.message.toolUseId] : []));
  return { ...evidence, derivatives };
}

async function readSessionRecoveryEvidence(options: Pick<RecoverFinalizedToolResultCheckpointsOptions, "store" | "sessionId">) {
  const existingResults = new Set<string>();
  const existingExecutionOutput = new Set<string>();
  const slice = await options.store.readSlice({
    aggregateId: `session:${options.sessionId}`,
    types: ["tool.result.recorded", "tool.execution_output.recorded"],
  });
  for (const stored of slice.facts) {
    // oxlint-disable-next-line eslint/no-throw-literal -- boundary: preserve the narrowed durable-row Error and its identity
    if (stored instanceof Error) throw stored;
    const event = hydrateToolContentFact(stored, slice.toolContent);
    const fact = parseSessionRuntimeFact({ type: event.type, version: event.version, actor: event.actor, payload: event.payload });
    if (fact.type === "tool.result.recorded") existingResults.add(fact.payload.toolUseId);
    if (fact.type === "tool.execution_output.recorded") existingExecutionOutput.add(fact.payload.toolUseId);
  }

  return { results: existingResults, executionOutput: existingExecutionOutput };
}

/** Bare-key cells written before 2026-10-17 lack conversation metadata.
 * Retire only when their result and canonical derivative prove completion.
 * Opens and disposes each recovery-only tree through the caller's factory.
 * Remove this conversion after 2027-04-17. */
export async function retireLegacyFinalizedToolResultCheckpoints(options: {
  readonly sessionId: string;
  readonly store: AsyncEventStateReadSurface;
  readonly writer: AsyncEventWriter;
  readonly conversationIds: ReadonlySet<string>;
  readonly openConversation: (conversationId: string) => Promise<ConversationTree | null>;
}): Promise<void> {
  const cells = await options.store.readInFlight(options.sessionId, FINALIZED_TOOL_RESULT_IN_FLIGHT_KIND);
  const legacy = cells.flatMap((row) => {
    if (typeof row.payload === "object" && row.payload !== null && "conversationId" in row.payload) return [];
    try {
      const checkpoint = decodeLegacyFinalizedToolResultCheckpoint(row.payload);
      if (checkpoint.toolUseId === row.key) return [{ row, checkpoint }];
    } catch {
      log.warn("historical finalized result checkpoint is unreadable; leaving it in place", { sessionId: options.sessionId, key: row.key });
    }
    return [];
  });
  if (legacy.length === 0) return;
  const derivatives = new Set<string>();
  for (const conversationId of options.conversationIds) {
    const tree = await options.openConversation(conversationId);
    if (!tree) continue;
    try {
      const state = await tree.getState();
      for (const entry of Object.values(state.entriesById)) {
        if (entry.kind === "message" && entry.message.kind === "toolResult") derivatives.add(entry.message.toolUseId);
      }
    } finally { tree.getStorage().dispose(); }
  }
  const evidence = await readSessionRecoveryEvidence(options);
  const completed = legacy.filter(({ checkpoint }) =>
    evidence.results.has(checkpoint.toolUseId) && derivatives.has(checkpoint.toolUseId)
    && (checkpoint.executionOutputTail === undefined || evidence.executionOutput.has(checkpoint.toolUseId)));
  if (completed.length === 0) return;
  if (!options.writer.swapInFlightBatch) throw new Error("Finalized result recovery requires atomic in-flight swap authority");
  await options.writer.swapInFlightBatch(options.sessionId, completed.map(({ row }) => ({
    op: "swap", kind: FINALIZED_TOOL_RESULT_IN_FLIGHT_KIND, key: row.key, expectedRaw: row.raw, payload: null,
  })));
}

async function buildRecoveryAppends(
  options: RecoverFinalizedToolResultCheckpointsOptions,
  checkpoints: readonly StoredCheckpoint[],
): Promise<GuardedEventStoreAppend[]> {
  const evidence = await readRecoveryEvidence(options);
  let sessionSeq = await options.store.aggregateSeq(`session:${options.sessionId}`) + 1;
  const appends: GuardedEventStoreAppend[] = [];
  for (const { checkpoint } of checkpoints) {
    const needs = finalizedToolResultRecoveryNeeds(checkpoint, evidence);
    if (needs.executionOutput) {
      appends.push(toSessionAppend(options.sessionId, executionOutputFact(checkpoint), sessionSeq));
      sessionSeq += 1;
      evidence.executionOutput.add(checkpoint.toolUseId);
    }
    if (needs.result) {
      appends.push(toSessionAppend(options.sessionId, resultFact(checkpoint), sessionSeq));
      sessionSeq += 1;
      evidence.results.add(checkpoint.toolUseId);
    }
  }

  const openExchange = openToolExchangeSuffix(await options.tree.getBranch());
  const currentToolUseIds = openExchange?.toolUseIds ?? new Set<string>();
  const recoverable = checkpoints
    .map(({ checkpoint }) => checkpoint)
    .filter((checkpoint) => {
      if (checkpoint.parentToolUseId !== undefined || !finalizedToolResultRecoveryNeeds(checkpoint, evidence).derivative) return false;
      if (currentToolUseIds.has(checkpoint.toolUseId)) return true;
      log.warn("finalized tool result checkpoint is stale for the current open exchange; retaining session evidence only", {
        sessionId: options.sessionId,
        toolUseId: checkpoint.toolUseId,
      });
      return false;
    });
  const replacements = await enforceTurnBudget(recoverable.map((checkpoint) => ({
    toolUseId: checkpoint.toolUseId,
    toolName: checkpoint.toolName,
    exempt: checkpoint.budgetExempt,
    content: checkpoint.content,
    ...(checkpoint.fullContentPath ? { fullContentPath: checkpoint.fullContentPath } : {}),
  })), {
    budgetChars: recordedTurnBudgetChars(recoverable[0]),
    executionCwd: options.projectRoot ?? ".",
    projectRoot: options.projectRoot ?? ".",
    artifactScopeId: options.sessionId,
  });
  const replacementById = new Map(replacements.map((replacement) => [replacement.toolUseId, replacement.content]));
  const messages = recoverable
    .flatMap((checkpoint) => toolResultMessages([{
      ...checkpoint,
      content: replacementById.get(checkpoint.toolUseId) ?? checkpoint.content,
    }]));
  const conversation = await options.tree.prepareMessagesAppend(messages.map((message) => ({
    id: recoveredResultEntryId(options.conversationId, message.toolUseId),
    message,
  })));
  appends.push(...conversation);
  return appends;
}

/** The bound the batch ran under, so recovery replays it (ARCH-CONTEXT-029). */
function recordedTurnBudgetChars(checkpoint: RecoverableCheckpoint | undefined): number {
  return checkpoint?.turnBudgetChars ?? turnBudgetChars(checkpoint?.contextWindowTokens);
}

function resultFact(checkpoint: RecoverableCheckpoint): SessionRuntimeFact {
  const [fact] = mapRuntimeEventToSessionRuntimeFacts(createRuntimeEvent("tool.result.recorded", {
    tool_use_id: checkpoint.toolUseId,
    content: checkpoint.content,
    outcome: checkpoint.outcome,
    ...(checkpoint.details != null ? { details: checkpoint.details } : {}),
    ...(checkpoint.modelRequestId ? { model_request_id: checkpoint.modelRequestId } : {}),
    ...(checkpoint.parentToolUseId ? { parent_tool_use_id: checkpoint.parentToolUseId } : {}),
    ...(checkpoint.contentTruncated !== undefined ? { content_truncated: checkpoint.contentTruncated } : {}),
    ...(checkpoint.originalContentBytes !== undefined ? { original_content_bytes: checkpoint.originalContentBytes } : {}),
    ...(checkpoint.originalContentSha256 ? { original_content_sha256: checkpoint.originalContentSha256 } : {}),
    ...(checkpoint.fullContentPath ? { full_content_path: checkpoint.fullContentPath } : {}),
    ...(checkpoint.semanticOutputTruncated !== undefined ? { semantic_output_truncated: checkpoint.semanticOutputTruncated } : {}),
    ...(checkpoint.byteOutputTruncated !== undefined ? { byte_output_truncated: checkpoint.byteOutputTruncated } : {}),
  }));
  if (!fact || fact.type !== "tool.result.recorded") throw new Error("Finalized result recovery did not produce a result fact");
  return fact;
}

function executionOutputFact(checkpoint: RecoverableCheckpoint): SessionRuntimeFact {
  const mutationEvidence = "version" in checkpoint ? checkpoint.details?.mutationEvidence : undefined;
  const [fact] = mapRuntimeEventToSessionRuntimeFacts(createRuntimeEvent("tool.execution_output.recorded", {
    tool_use_id: checkpoint.toolUseId,
    output: checkpoint.executionOutputTail ?? "",
    ...(mutationEvidence ? { mutationEvidence } : {}),
    ...(checkpoint.modelRequestId ? { model_request_id: checkpoint.modelRequestId } : {}),
    ...(checkpoint.parentToolUseId ? { parent_tool_use_id: checkpoint.parentToolUseId } : {}),
  }));
  if (!fact || fact.type !== "tool.execution_output.recorded") throw new Error("Finalized result recovery did not produce an execution-output fact");
  return fact;
}

function toSessionAppend(sessionId: string, fact: SessionRuntimeFact, expectedSeq: number): GuardedEventStoreAppend {
  const extracted = extractToolContentFact(fact);
  return { ...prepareSessionFactAppend(sessionId, extracted.fact, extracted.contentRows), expectedSeq };
}

function withRetirements(
  appends: readonly GuardedEventStoreAppend[],
  checkpoints: readonly StoredCheckpoint[],
): GuardedEventStoreAppend[] {
  const last = appends.length - 1;
  const swaps = checkpoints.map(({ row }): InFlightWrite => ({
    op: "swap",
    kind: FINALIZED_TOOL_RESULT_IN_FLIGHT_KIND,
    key: row.key,
    expectedRaw: row.raw,
    payload: null,
  }));
  return appends.map((append, index) => index === last ? { ...append, inFlight: swaps } : append);
}

async function retireAlreadyRecorded(
  options: RecoverFinalizedToolResultCheckpointsOptions,
  checkpoints: readonly StoredCheckpoint[],
): Promise<boolean> {
  if (!options.writer.swapInFlightBatch) throw new Error("Finalized result recovery requires atomic in-flight swap authority");
  return options.writer.swapInFlightBatch(options.sessionId, checkpoints.map(({ row }) => ({
    op: "swap",
    kind: FINALIZED_TOOL_RESULT_IN_FLIGHT_KIND,
    key: row.key,
    expectedRaw: row.raw,
    payload: null,
  })));
}

const RECOVERED_RESULT_ENTRY_ID_PREFIX = "ftr-";

/** Whether a conversation entry is a result this recovery committed for a
 *  turn whose owner died, rather than one the turn committed itself. */
export function isRecoveredToolResultEntryId(entryId: string): boolean {
  return entryId.startsWith(RECOVERED_RESULT_ENTRY_ID_PREFIX);
}

function recoveredResultEntryId(conversationId: string, toolUseId: string): string {
  return RECOVERED_RESULT_ENTRY_ID_PREFIX + new Bun.CryptoHasher("sha256")
    .update(`finalized-tool-result:${conversationId}:${toolUseId}`)
    .digest("hex")
    .slice(0, 8);
}

export function finalizedToolResultCheckpointSwaps(
  calls: readonly { readonly checkpoint?: { readonly key: string; readonly raw: string } }[],
): readonly { readonly kind: typeof FINALIZED_TOOL_RESULT_IN_FLIGHT_KIND; readonly key: string; readonly expectedRaw: string }[] {
  return calls.flatMap((call) => call.checkpoint ? [{
    kind: FINALIZED_TOOL_RESULT_IN_FLIGHT_KIND,
    key: call.checkpoint.key,
    expectedRaw: call.checkpoint.raw,
  }] : []);
}

function checkpointKey(conversationId: string, toolUseId: string): string {
  return `${conversationId}:${toolUseId}`;
}
