import { Schema } from "effect";
import { InvariantViolation } from "../../infra/invariant.js";
import { USER_REQUEST_ARTIFACT_ID } from "../definition-validation.js";
import { selectionReport } from "../reducers/list-selection.js";
import { compareCodeUnits } from "../reducers/reducer.js";
import { attemptNodeIdOf, roundOfNodeId } from "../vm/graph-types.js";
import { ArtifactContractSchema } from "../artifact-contracts.js";
import { AddressedAddendumSchema, HandoffEntrySchema, RequestAddendumSchema, type AddressedAddendum, type HandoffEntry, type ItemScope, type RecipientScope, type RequestAddendum } from "./context-facts.js";
import { WorkflowInputValueSchema, type WorkflowInputValue } from "../output-contract/compile.js";
import type { AgentRead } from "../workflow-schema.js";

/** Transient contract a blocked attempt wrote instead of its declared durable
 *  artifacts: the blocker report reached the immediate next attempt, the one
 *  that reassesses the stopped work, and nothing inherited it afterwards. Only
 *  a build before blocked retirement wrote it, addressed by `recipientAttemptId`.
 *  The accumulator still reads such an entry so a stored corrective chain
 *  resumes with its blocker. Remove this reader after 2027-04-03. */
export const BLOCKED_WORK_ARTIFACT_ID = "blocked_work";

/** The most bytes of branch handoff content that the projection expands into
 *  one post-join artifact. A reference past the cap stays a reference. A
 *  later round of a loop reads at most as many bytes of what the earlier
 *  rounds reported. */
export const JOIN_EXPANSION_CAP_BYTES = 64 * 1024;

export type { HandoffEntry } from "./context-facts.js";

/** The launch seed in the artifact index: the verbatim request, and the
 *  structured input when the launch passed one. */
const WorkflowInputArtifactIndexEntrySchema = Schema.Struct({
  id: Schema.Literal(USER_REQUEST_ARTIFACT_ID),
  origin: Schema.Literal("workflow_input"),
  workflowDefinitionId: Schema.NonEmptyString,
  value: Schema.String,
  input: Schema.optionalKey(WorkflowInputValueSchema),
  inheritedIntent: Schema.optionalKey(Schema.NonEmptyString),
  timestamp: Schema.Number,
});

/** One artifact that an agent's handoff entry writes. */
const AgentArtifactIndexEntrySchema = Schema.Struct({
  id: Schema.NonEmptyString,
  origin: Schema.Literal("workflow_agent"),
  writerEntryId: Schema.String,
  writerAgentName: Schema.String,
  writerDefinitionId: Schema.NonEmptyString,
  workflowDefinitionId: Schema.NonEmptyString,
  contract: ArtifactContractSchema,
  value: Schema.Record(Schema.String, Schema.Unknown),
  timestamp: Schema.Number,
});

type ArtifactIndexEntry = typeof WorkflowInputArtifactIndexEntrySchema.Type | AgentArtifactIndexEntry;
type AgentArtifactIndexEntry = typeof AgentArtifactIndexEntrySchema.Type;

interface ArtifactIndex {
  readonly [id: string]: ArtifactIndexEntry;
}

/** One addition to the request: a message to the workflow with its
 *  address, or a message that an agent read, which only a build before
 *  addresses accepted. */
export type ContextAddendum = RequestAddendum | AddressedAddendum;

export interface AccumulatorState {
  entries: HandoffEntry[];
  artifacts: ArtifactIndex;
  addenda: ContextAddendum[];
}

/** The run's request: the verbatim launch request, the structured launch
 *  input when the launch passed one, then each addendum in recorded order.
 *  An addendum never replaces the original. The input is workflow scope:
 *  every recipient, on every item, reads it. */
export interface WorkflowRequest {
  readonly original: string;
  readonly input?: WorkflowInputValue;
  readonly inheritedIntent?: string;
  readonly addenda: readonly ContextAddendum[];
}

/** One record that the recipient's view leaves out, and why. The prompt
 *  audit and session verification read this list, so no record leaves the
 *  view without a stated reason. The list is ordered by kind, then id.
 *  - `list_local`: a record of an item of a list whose join has not
 *    settled.
 *  - `folded_into_join`: a handoff of an item that the list's post-join
 *    artifact references instead.
 *  - `item_evidence`: a handoff of an item of a settled list that the
 *    post-join artifact does not reference, such as the handoff of an
 *    earlier phase of a stream. It stays durable evidence only.
 *  - `sibling_item`: a record of another item of the recipient's list.
 *  - `after_admission`: a workflow-scope entry outside the recipient's
 *    frozen bundle: its list's, or for a workflow-scope attempt, the
 *    entries of the nodes that complete before its node can start.
 *  - `join_expansion_cap`: a handoff of an item that a post-join artifact names
 *    by reference only, because its content did not fit the cap
 *    ({@link WithheldJoinItem}).
 *  - `addressed_elsewhere`: a message that a sender addressed to items or
 *    agents that do not include the recipient. */
type ContextExclusion = {
  readonly kind: "entry" | "addendum";
  readonly id: string;
  readonly reason: "list_local" | "folded_into_join" | "item_evidence" | "sibling_item" | "after_admission" | "addressed_elsewhere";
} | WithheldJoinItem;

/** One item handoff that a post-join value the recipient reads names by
 *  reference only, because its content did not fit
 *  {@link JOIN_EXPANSION_CAP_BYTES}. `id` is the attempt that wrote the
 *  handoff, `key` is the item's key in the join, and `bytes` is the size of
 *  the content that the cap withheld. `join` is the entry id of the join, and
 *  `shownBytes` is the size of the item content that the join expanded. */
interface WithheldJoinItem {
  readonly kind: "join_reference";
  readonly id: string;
  readonly reason: "join_expansion_cap";
  readonly key: string;
  readonly bytes: number;
  readonly join: string;
  readonly shownBytes: number;
}

/** One output that the recipient agent reads by name: the latest handoff
 *  of an agent's entry, or the post-join entry of a list, labeled with the
 *  id that the agent names. A post-join entry has its references expanded. */
interface ReadOutput {
  readonly id: string;
  readonly entry: HandoffEntry;
}

/** What one earlier round of a repeat over a list reported, as each agent
 *  of an item of a later round reads it: each item that the round's join
 *  kept, as the join recorded it without its `branch` field, and the key and
 *  reason of each entry that it dropped. The join of a later round drops
 *  every key listed here, so an agent that reads them looks for new items
 *  instead of repeating them.
 *  `omitted` counts the entries that did not fit the cap. */
interface EarlierRound {
  readonly round: number;
  readonly kept: readonly { readonly [field: string]: unknown }[];
  readonly dropped: readonly { readonly key: string; readonly reason: string }[];
  readonly omitted: number;
}

export interface AccumulatedContext {
  request: WorkflowRequest | null;
  priorHandoff: HandoffEntry | null;
  /** The outputs that the recipient's agent names in `reads`, in its order.
   *  Each output reaches the agent once: an output that would also be its
   *  prior handoff or a durable artifact is here only. A phase of a repeat
   *  that the agent reads from outside the repeat reaches it once for each
   *  round. */
  reads: ReadOutput[];
  /** For an item of a list in round N of a repeat, what that list
   *  reported in rounds 1 to N - 1, round 1 first. Empty for every other
   *  recipient. */
  earlierRounds: EarlierRound[];
  artifacts: AgentArtifactIndexEntry[];
  exclusions: ContextExclusion[];
}

/** The attempt one context view is for, and its scope. `attemptId` matches
 *  an entry addressed to that attempt, and `nodeId`, the attempt's logical
 *  node, matches a message addressed to that agent. `reads` names the
 *  outputs that the attempt's agent reads; absent, it reads none. */
export interface ContextRecipient {
  readonly attemptId: string | null;
  readonly nodeId?: string;
  readonly scope: RecipientScope;
  readonly reads?: readonly AgentRead[];
}

const WORKFLOW_RECIPIENT: ContextRecipient = { attemptId: null, scope: { _tag: "workflow" } };

type HandoffEntryInput = typeof HandoffEntrySchema.Encoded;

interface WorkflowInputSeed {
  workflowDefinitionId: string;
  userRequest: string;
  /** The decoded structured input. Absent for a launch with the text
   *  request only. */
  input?: WorkflowInputValue;
  inheritedIntent?: string;
  timestamp: number;
}

/** The stored fact that carries an addendum, named in an invariant violation. */
interface AddendumOrigin {
  readonly position: number;
  readonly aggregateId: string;
}

const JOIN_SUFFIX = ":join";

/** Whether a recipient reads the workflow-scope entry or promoted join
 *  `entryId`. A recipient without a bundle reads everything. A branch reads
 *  only its group's frozen bundle. A workflow-scope recipient with a bundle
 *  reads the attempt and join entries that its bundle names, so an entry
 *  that a parallel sibling records after the recipient started never
 *  reaches it, whenever the recipient reads. It also reads every entry that
 *  no attempt or join of a run records, such as the predecessor evidence
 *  that a recovery root inherits: no run records such an entry later. */
function sharedAdmission(scope: RecipientScope): (entryId: string) => boolean {
  if (scope.sharedEntryIds === undefined) return () => true;
  const shared = new Set(scope.sharedEntryIds);
  if (scope._tag === "item") return (entryId) => shared.has(entryId);
  return (entryId) => shared.has(entryId) || (attemptNodeIdOf(entryId) === null && joinedListNodeId(entryId) === null);
}

/** The entry id of a list's one post-join entry. */
export function joinEntryId(listNodeId: string): string {
  return `${listNodeId}${JOIN_SUFFIX}`;
}

/** The list node id of a post-join entry's id, or null when the entry id
 *  names no post-join entry. */
export function joinedListNodeId(entryId: string): string | null {
  return entryId.endsWith(JOIN_SUFFIX) ? entryId.slice(0, -JOIN_SUFFIX.length) : null;
}

export interface ContextAccumulator {
  seedInput(input: WorkflowInputSeed): void;
  /** Append one request addendum after the earlier ones. The writer records
   *  each key once in an epoch, so a repeated key is a broken invariant and
   *  throws: the accumulator never deduplicates. Addenda stay out of the
   *  handoff entries, so they never change the prior handoff or the agent
   *  count. An item scope keeps the addendum local to its list until its
   *  join. */
  add(addendum: typeof RequestAddendumSchema.Encoded, origin: AddendumOrigin, scope?: ItemScope | null): void;
  /** Append one message to the workflow with its address. Its key shares
   *  the one key space of the addenda, so a repeated key throws. */
  address(addendum: typeof AddressedAddendumSchema.Encoded, origin: AddendumOrigin): void;
  accumulate(entry: HandoffEntryInput, scope?: ItemScope | null): void;
  /** Context for one recipient. An entry addressed to another attempt is
   *  not visible to this one; unaddressed entries are the ordinary context
   *  of the phase before. Without a recipient, the view is the workflow scope. */
  getContext(recipient?: ContextRecipient): AccumulatedContext;
  serialize(): AccumulatorState;
}

/** The handoff entries one recipient reads: the workflow-scope entries it
 *  shares and its own branch's entries. */
interface VisibleEntries {
  readonly shared: readonly HandoffEntry[];
  readonly own: readonly HandoffEntry[];
}

/** The stored value of one handoff. */
type HandoffValue = HandoffEntry["handoff"];

/** One recorded record with its recorded position and scope. */
interface Scoped<T> {
  readonly value: T;
  readonly position: number;
  readonly scope: ItemScope | null;
}

/** One addressed message with its recorded position. Its addresses are its
 *  scope. */
interface AddressedRecord {
  readonly value: AddressedAddendum;
  readonly position: number;
  readonly addressed: true;
}

/** One item of a post-join value that references a branch handoff. */
interface JoinReference {
  readonly item: object;
  readonly key: string;
  readonly reference: object;
  readonly attemptId: string;
}

/** The item handoff attempt ids that a post-join value references, in item
 *  order, each with its item and the item's key. A reducer output names a
 *  handoff as `{ step_id }` under the `handoff` key of an item, beside the
 *  item's `key`. */
function joinReferences(value: HandoffValue): readonly JoinReference[] {
  const items = value.items;
  if (!Array.isArray(items)) return [];
  return items.flatMap((item: unknown) => {
    if (typeof item !== "object" || item === null || !("handoff" in item) || !("key" in item) || typeof item.key !== "string") return [];
    const reference = item.handoff;
    if (typeof reference !== "object" || reference === null || !("step_id" in reference) || typeof reference.step_id !== "string") return [];
    return [{ item, key: item.key, reference, attemptId: reference.step_id }];
  });
}

/** The size of one handoff's content as a join expands it. */
function handoffBytes(content: HandoffValue): number {
  return Buffer.byteLength(JSON.stringify(content), "utf8");
}

/** A post-join value with its references expanded, the attempt ids of the
 *  references that stayed references because their content did not fit, and
 *  the size of the content that the expansion added. */
export interface ExpandedJoin {
  readonly value: HandoffValue;
  readonly unexpanded: readonly string[];
  readonly shownBytes: number;
}

/** A post-join value with each referenced branch handoff expanded, in item
 *  order, when its content still fits {@link JOIN_EXPANSION_CAP_BYTES} beside
 *  the content already expanded. A reference that does not fit stays a
 *  reference and is returned in `unexpanded`, and a later, smaller one can
 *  still expand. A reference without content stays as it is. Item order is
 *  the stable manifest order, so the result never depends on the order in
 *  which items settled. Every reader of a post-join value expands it
 *  here: an agent's context and the parent's completion message. */
export function expandJoinReferences(value: HandoffValue, contentOf: (attemptId: string) => HandoffValue | undefined): ExpandedJoin {
  const items = value.items;
  if (!Array.isArray(items)) return { value, unexpanded: [], shownBytes: 0 };
  const expanded = new Map<unknown, unknown>();
  const unexpanded: string[] = [];
  let used = 0;
  for (const { item, reference, attemptId } of joinReferences(value)) {
    const content = contentOf(attemptId);
    if (content === undefined) continue;
    const bytes = handoffBytes(content);
    if (used + bytes > JOIN_EXPANSION_CAP_BYTES) {
      unexpanded.push(attemptId);
      continue;
    }
    used += bytes;
    expanded.set(item, { ...item, handoff: { ...reference, content } });
  }
  return { value: { ...value, items: items.map((item: unknown) => expanded.get(item) ?? item) }, unexpanded, shownBytes: used };
}

/** One kept item or dropped entry of an earlier round. */
type ReportedEntry = EarlierRound["kept"][number] | EarlierRound["dropped"][number];

/** The earlier rounds that one recipient reads, and the ids of their
 *  post-join entries, which reach it only through this report. */
interface EarlierRoundsView {
  readonly rounds: EarlierRound[];
  readonly entryIds: ReadonlySet<string>;
}

/** What the earlier rounds of an item's list reported, from the post-join
 *  entry of the same list in each earlier round in the item's frozen shared
 *  bundle, in round order, and the ids of those entries. The list of a later
 *  round freezes those entries when it expands, and each is the pure fold of
 *  its round's committed join, so the view never depends on the order in
 *  which items or rounds finished. The kept items of every round come first, then the
 *  dropped entries, each while it still fits {@link JOIN_EXPANSION_CAP_BYTES}
 *  beside the entries before it. */
function earlierRoundsOf(scope: RecipientScope, shared: readonly HandoffEntry[]): EarlierRoundsView {
  const current = scope._tag === "item" ? roundOfNodeId(scope.listNodeId) : null;
  if (current === null) return { rounds: [], entryIds: new Set() };
  const reports = shared.flatMap((entry) => {
    const listNodeId = joinedListNodeId(entry.entryId);
    const of = listNodeId === null ? null : roundOfNodeId(listNodeId);
    return of !== null && of.repeatNodeId === current.repeatNodeId && of.rest === current.rest && of.round < current.round
      ? [{ round: of.round, entryId: entry.entryId, ...selectionReport(entry.handoff) }]
      : [];
  }).toSorted((left, right) => left.round - right.round);
  let used = 0;
  const omitted = new Map<number, number>();
  const fits = (round: number) => (entry: ReportedEntry): boolean => {
    const bytes = Buffer.byteLength(JSON.stringify(entry), "utf8");
    if (used + bytes > JOIN_EXPANSION_CAP_BYTES) {
      omitted.set(round, (omitted.get(round) ?? 0) + 1);
      return false;
    }
    used += bytes;
    return true;
  };
  const kept = reports.map(({ round, kept: items }) => items.filter(fits(round)));
  const dropped = reports.map(({ round, dropped: entries }) => entries.filter(fits(round)));
  return {
    rounds: reports.map(({ round }, index) => ({ round, kept: kept[index] ?? [], dropped: dropped[index] ?? [], omitted: omitted.get(round) ?? 0 })),
    entryIds: new Set(reports.map(({ entryId }) => entryId)),
  };
}

export function createContextAccumulator(): ContextAccumulator {
  const entries: Scoped<HandoffEntry>[] = [];
  const addenda: (Scoped<RequestAddendum> | AddressedRecord)[] = [];
  let seed: Extract<ArtifactIndexEntry, { origin: "workflow_input" }> | null = null;
  let position = 0;

  function seedInput(input: WorkflowInputSeed): void {
    seed = Schema.decodeUnknownSync(WorkflowInputArtifactIndexEntrySchema, { onExcessProperty: "error" })({
      id: USER_REQUEST_ARTIFACT_ID,
      origin: "workflow_input",
      workflowDefinitionId: input.workflowDefinitionId,
      value: input.userRequest,
      ...(input.input === undefined ? {} : { input: input.input }),
      ...(input.inheritedIntent === undefined ? {} : { inheritedIntent: input.inheritedIntent }),
      timestamp: input.timestamp,
    });
  }

  function accumulate(entry: HandoffEntryInput, scope: ItemScope | null = null): void {
    const parsed = Schema.decodeUnknownSync(HandoffEntrySchema, { onExcessProperty: "error" })(entry);
    entries.push({ value: parsed, position: position++, scope });
  }

  function requireNewKey(key: string, origin: AddendumOrigin): void {
    if (!addenda.some(({ value }) => value.key === key)) return;
    throw new InvariantViolation({
      kind: "duplicate-event",
      eventType: "step_context.input.added",
      eventPosition: origin.position,
      aggregateId: origin.aggregateId,
      detail: `request addendum ${key} is already recorded`,
    });
  }

  function add(addendum: typeof RequestAddendumSchema.Encoded, origin: AddendumOrigin, scope: ItemScope | null = null): void {
    const parsed = Schema.decodeUnknownSync(RequestAddendumSchema, { onExcessProperty: "error" })(addendum);
    requireNewKey(parsed.key, origin);
    addenda.push({ value: parsed, position: position++, scope });
  }

  function address(addendum: typeof AddressedAddendumSchema.Encoded, origin: AddendumOrigin): void {
    const parsed = Schema.decodeUnknownSync(AddressedAddendumSchema, { onExcessProperty: "error" })(addendum);
    requireNewKey(parsed.key, origin);
    addenda.push({ value: parsed, position: position++, addressed: true });
  }

  /** The recorded position of each group's post-join entry. */
  function joins(): ReadonlyMap<string, number> {
    const settled = new Map<string, number>();
    for (const { value, position: at, scope } of entries) {
      const listNodeId = scope === null ? joinedListNodeId(value.entryId) : null;
      if (listNodeId !== null) settled.set(listNodeId, at);
    }
    return settled;
  }

  /** The branch handoffs that some post-join entry references. */
  function joinedEntryIds(): ReadonlySet<string> {
    const referenced = new Set<string>();
    for (const { value, scope } of entries) {
      if (scope !== null || joinedListNodeId(value.entryId) === null) continue;
      for (const { attemptId } of joinReferences(value.handoff)) referenced.add(attemptId);
    }
    return referenced;
  }

  /** The request addenda one recipient reads. A workflow-scope addendum is
   *  live for everyone. An item addendum is visible to its own item, and
   *  after its list's join it is workflow scope at the join's position, in
   *  item-key order. A recipient with a frozen bundle reads a promoted
   *  addendum only when its bundle holds that join. A message addressed
   *  to the whole workflow is live for everyone at once, as a workflow-scope
   *  addendum is. A message addressed to items or agents is visible to each
   *  item and agent it names; the join of the items promotes it as it
   *  promotes an item addendum, and an agent's own handoff carries it on, so
   *  an agent address is never promoted. */
  function visibleAddenda(recipient: ContextRecipient, settled: ReadonlyMap<string, number>, exclusions: ContextExclusion[]): ContextAddendum[] {
    const { scope } = recipient;
    const admits = sharedAdmission(scope);
    const promotedAt = (listNodeId: string): number | undefined => {
      const joinAt = settled.get(listNodeId);
      return joinAt !== undefined && admits(joinEntryId(listNodeId)) ? joinAt : undefined;
    };
    const visible: { readonly addendum: ContextAddendum; readonly at: number; readonly key: string; readonly position: number }[] = [];
    for (const record of addenda) {
      if ("addressed" in record) {
        const { value, position: at } = record;
        const itemParts = value.addressedTo.flatMap((part) => part._tag === "item" ? [part] : []);
        const reaches = value.addressedTo.some((part) => part._tag === "workflow"
          || (part._tag === "item" ? scope._tag === "item" && part.itemNodeId === scope.itemNodeId : part.nodeId === recipient.nodeId));
        if (reaches) {
          visible.push({ addendum: value, at, key: "", position: at });
          continue;
        }
        const promotions = itemParts.flatMap((part) => promotedAt(part.listNodeId) ?? []);
        if (promotions.length > 0) {
          visible.push({ addendum: value, at: Math.min(...promotions), key: itemParts[0]?.key ?? "", position: at });
          continue;
        }
        exclusions.push({
          kind: "addendum",
          id: value.key,
          reason: scope._tag === "item" && itemParts.some((part) => part.listNodeId === scope.listNodeId) ? "sibling_item" : "addressed_elsewhere",
        });
        continue;
      }
      const { value, position: at, scope: owner } = record;
      if (owner === null) {
        visible.push({ addendum: value, at, key: "", position: at });
        continue;
      }
      if (scope._tag === "item" && owner.itemNodeId === scope.itemNodeId) {
        visible.push({ addendum: value, at, key: "", position: at });
        continue;
      }
      const joinAt = promotedAt(owner.listNodeId);
      if (joinAt !== undefined) {
        visible.push({ addendum: value, at: joinAt, key: owner.key, position: at });
        continue;
      }
      exclusions.push({
        kind: "addendum",
        id: value.key,
        reason: scope._tag === "item" && owner.listNodeId === scope.listNodeId ? "sibling_item" : "list_local",
      });
    }
    return visible
      .toSorted((left, right) => left.at - right.at || compareCodeUnits(left.key, right.key) || left.position - right.position)
      .map(({ addendum }) => addendum);
  }

  /** The handoff entries one recipient reads. The entries of its own item
   *  are in recorded order, because one item runs one phase at a time. The
   *  shared entries are in the order of the recipient's frozen bundle, so
   *  the view never depends on the order in which parallel attempts
   *  finished; a scope without bundle order reads them in recorded order
   *  (refer to `RecipientScopeSchema`). */
  function visibleEntries(scope: RecipientScope, settled: ReadonlyMap<string, number>, exclusions: ContextExclusion[]): VisibleEntries {
    const bundle = scope.sharedEntryIds;
    const admits = sharedAdmission(scope);
    const joined = joinedEntryIds();
    const recorded: HandoffEntry[] = [];
    const own: HandoffEntry[] = [];
    for (const { value, scope: owner } of entries) {
      if (owner === null) {
        if (admits(value.entryId)) recorded.push(value);
        else exclusions.push({ kind: "entry", id: value.entryId, reason: "after_admission" });
        continue;
      }
      if (scope._tag === "item" && owner.itemNodeId === scope.itemNodeId) {
        own.push(value);
        continue;
      }
      exclusions.push({
        kind: "entry",
        id: value.entryId,
        reason: scope._tag === "item" && owner.listNodeId === scope.listNodeId
          ? "sibling_item"
          : !settled.has(owner.listNodeId) ? "list_local"
          : joined.has(value.entryId) ? "folded_into_join" : "item_evidence",
      });
    }
    if (bundle === undefined || (scope._tag === "item" && scope.bundleOrder !== true)) return { shared: recorded, own };
    const rank = new Map(bundle.map((id, index) => [id, index]));
    return { shared: recorded.toSorted((left, right) => (rank.get(left.entryId) ?? -1) - (rank.get(right.entryId) ?? -1)), own };
  }

  /** The durable artifacts that the given entries write, after supersession.
   *  A later write of an id replaces the earlier one. */
  function artifactIndex(visible: readonly HandoffEntry[]): Map<string, AgentArtifactIndexEntry> {
    const index = new Map<string, AgentArtifactIndexEntry>();
    for (const entry of visible) {
      for (const contract of entry.writes) {
        const artifact = Schema.decodeUnknownSync(AgentArtifactIndexEntrySchema, { onExcessProperty: "error" })({
          id: contract.id,
          origin: "workflow_agent",
          writerEntryId: entry.entryId,
          writerAgentName: entry.agentName,
          writerDefinitionId: entry.definitionId,
          workflowDefinitionId: entry.workflowDefinitionId,
          contract,
          value: entry.handoff,
          timestamp: entry.timestamp,
        });
        index.set(contract.id, artifact);
      }
    }
    return index;
  }

  /** A post-join value with its references expanded through the shared
   *  expansion. Each reference past the cap is listed as an exclusion, with
   *  its item key, the size of the content that the cap withheld, the join
   *  entry `join`, and the size of the content that the join shows. */
  function expandJoin(join: string, value: HandoffValue, exclusions: ContextExclusion[]): HandoffValue {
    const contents = new Map(entries.map(({ value: entry }) => [entry.entryId, entry.handoff]));
    const expanded = expandJoinReferences(value, (attemptId) => contents.get(attemptId));
    const withheld = new Set(expanded.unexpanded);
    for (const { key, attemptId } of joinReferences(value)) {
      const content = contents.get(attemptId);
      if (content !== undefined && withheld.has(attemptId)) exclusions.push({ kind: "join_reference", id: attemptId, reason: "join_expansion_cap", key, bytes: handoffBytes(content), join, shownBytes: expanded.shownBytes });
    }
    return expanded.value;
  }

  function withExpandedJoin(entry: HandoffEntry, exclusions: ContextExclusion[]): HandoffEntry {
    return joinedListNodeId(entry.entryId) === null ? entry : { ...entry, handoff: expandJoin(entry.entryId, entry.handoff, exclusions) };
  }

  /** The prior handoff of one recipient, when the latest entry is addressed
   *  to it or to no one. In the workflow scope, the latest entry must also
   *  write a transient artifact. On an item, it is the latest entry of the
   *  recipient's own item, its immediate predecessor, whatever it writes;
   *  the first phase of a stream has none, so a sibling objective in the shared bundle's
   *  handoff never reaches it. */
  function priorOf(scope: RecipientScope, visible: VisibleEntries, attemptId: string | null): HandoffEntry | null {
    const latest = scope._tag === "item" ? visible.own.at(-1) : visible.shared.at(-1);
    if (latest === undefined || (latest.recipientAttemptId !== null && latest.recipientAttemptId !== attemptId)) return null;
    return scope._tag === "item" || latest.writes.some(({ lifetime }) => lifetime === "transient") ? latest : null;
  }

  /** The outputs that one recipient reads, in its order. An agent source is
   *  the latest workflow-scope entry of an attempt of its record; a join
   *  source is its post-join entry. A source in a repeat that the recipient
   *  reads from inside the repeat is its latest entry, which is the output
   *  of the recipient's own round. Read from outside, it is each round's
   *  output, round 1 first, or, for the last phase of the repeat, the
   *  repeat's one entry that holds every round. An item recipient reads only
   *  its shared bundle, which holds every output that settled before its
   *  list started. A source that has not written yet has no output to read.
   *  A run paused before phases holds the node ids of the retired step
   *  grammar, and its joins carry the retired map id, so a read that the
   *  retired grammar's conversion made first finds a join where the retired
   *  grammar put it, and falls back to it for a retired record whose second
   *  place the conversion renamed. */
  function readOutputs(reads: readonly AgentRead[], readerNodeId: string | undefined, visible: VisibleEntries, exclusions: ContextExclusion[]): ReadOutput[] {
    const readerRepeat = readerNodeId === undefined ? undefined : roundOfNodeId(readerNodeId)?.repeatNodeId;
    return reads.flatMap((read) => {
      const retired = read.retired?.kind === "map" ? retiredOutput(read, visible, exclusions) : [];
      if (retired.length > 0) return retired;
      const current = currentOutputs(read, readerRepeat, visible, exclusions);
      return current.length > 0 || read.retired?.kind !== "step" ? current : retiredOutput(read, visible, exclusions);
    });
  }

  /** The output of one read where the retired step grammar found it: the
   *  latest join entry of its retired map at that map's node, or the latest
   *  handoff of its retired record at that record's node. Both keys must
   *  match, so a run that started
   *  in the phase grammar never finds another phase's output here. Remove
   *  after 2027-04-30. */
  function retiredOutput(read: AgentRead, visible: VisibleEntries, exclusions: ContextExclusion[]): ReadOutput[] {
    const source = read.retired;
    if (source === undefined) return [];
    const entry = visible.shared.findLast((candidate) => source.kind === "map"
      ? candidate.entryId === joinEntryId(source.nodeId) && candidate.definitionId === source.mapId
      : candidate.definitionId === source.stepId && attemptNodeIdOf(candidate.entryId) === source.nodeId); // key of the retired read
    return entry === undefined ? [] : [{ id: read.id, entry: withExpandedJoin(entry, exclusions) }];
  }

  /** The outputs of one read in the phase grammar (refer to {@link readOutputs}). */
  function currentOutputs(read: AgentRead, readerRepeat: string | undefined, visible: VisibleEntries, exclusions: ContextExclusion[]): ReadOutput[] {
    const place = roundOfNodeId(read.nodeId);
    const sameNode = (nodeId: string): boolean => {
      if (nodeId === read.nodeId) return true;
      const of = roundOfNodeId(nodeId);
      return place !== null && of !== null && of.repeatNodeId === place.repeatNodeId && of.rest === place.rest;
    };
    const matches = visible.shared.filter((candidate) => {
      if (read.kind === "agent") return candidate.definitionId === read.definitionId && attemptNodeIdOf(candidate.entryId) !== null;
      const joined = joinedListNodeId(candidate.entryId);
      return joined !== null && (sameNode(joined) || candidate.definitionId === read.id);
    });
    const everyRound = place !== null && place.repeatNodeId !== readerRepeat;
    if (!everyRound) {
      const entry = matches.at(-1);
      return entry === undefined ? [] : [{ id: read.id, entry: withExpandedJoin(entry, exclusions) }];
    }
    const whole = read.kind === "join" ? visible.shared.findLast((candidate) => candidate.entryId === joinEntryId(place.repeatNodeId) && candidate.definitionId === read.id) : undefined;
    if (whole !== undefined) return [{ id: read.id, entry: withExpandedJoin(whole, exclusions) }];
    const latest = new Map<string, HandoffEntry>();
    for (const entry of matches) latest.set(attemptNodeIdOf(entry.entryId) ?? joinedListNodeId(entry.entryId) ?? entry.entryId, entry);
    return [...latest.values()].map((entry) => ({ id: read.id, entry: withExpandedJoin(entry, exclusions) }));
  }

  function getContext(recipient: ContextRecipient = WORKFLOW_RECIPIENT): AccumulatedContext {
    const exclusions: ContextExclusion[] = [];
    const settled = joins();
    const visible = visibleEntries(recipient.scope, settled, exclusions);
    const reads = readOutputs(recipient.reads ?? [], recipient.nodeId, visible, exclusions);
    const readIds = new Set(reads.map(({ entry }) => entry.entryId));
    const earlier = earlierRoundsOf(recipient.scope, visible.shared);
    // The artifact index reads only workflow-scope entries, so the durable
    // writes of an item never reach another phase or replace a shared artifact.
    // An output that the recipient reads, or that an earlier round of its
    // loop reported, reaches it once, there.
    const index = artifactIndex(visible.shared);
    const suppressedIds = new Set<string>();
    for (const artifact of index.values()) {
      if (artifact.contract.lifetime !== "durable") continue;
      for (const id of artifact.contract.supersedes) suppressedIds.add(id);
    }
    const artifacts: AgentArtifactIndexEntry[] = [];
    for (const artifact of index.values()) {
      if (artifact.contract.lifetime === "durable" && !suppressedIds.has(artifact.id) && !readIds.has(artifact.writerEntryId) && !earlier.entryIds.has(artifact.writerEntryId)) {
        artifacts.push(joinedListNodeId(artifact.writerEntryId) === null ? artifact : { ...artifact, value: expandJoin(artifact.writerEntryId, artifact.value, exclusions) });
      }
    }
    const latest = priorOf(recipient.scope, visible, recipient.attemptId);
    const prior = latest !== null && readIds.has(latest.entryId) ? null : latest;
    const request = seed === null ? null : {
      original: seed.value,
      ...(seed.input === undefined ? {} : { input: seed.input }),
      ...(seed.inheritedIntent === undefined ? {} : { inheritedIntent: seed.inheritedIntent }),
      addenda: visibleAddenda(recipient, settled, exclusions),
    };
    return {
      request,
      priorHandoff: prior === null ? null : withExpandedJoin(prior, exclusions),
      reads,
      earlierRounds: earlier.rounds,
      artifacts,
      // Stable order, so the view never depends on the order in which
      // branches settled.
      exclusions: exclusions.toSorted((left, right) => compareCodeUnits(left.kind, right.kind) || compareCodeUnits(left.id, right.id)),
    };
  }

  function serialize(): AccumulatorState {
    const workflow = artifactIndex(entries.filter(({ scope }) => scope === null).map(({ value }) => value));
    return {
      entries: entries.map(({ value }) => value),
      artifacts: Object.fromEntries([...(seed === null ? [] : [[seed.id, seed] as const]), ...workflow]),
      addenda: addenda.map(({ value }) => value),
    };
  }

  return { seedInput, add, address, accumulate, getContext, serialize };
}
