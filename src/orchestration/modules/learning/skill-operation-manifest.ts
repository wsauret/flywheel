/** Durable global skill operations and historical proposals.
 *
 * An operation binds one session interaction to an exact package plan. Current
 * interactions are tool calls; version 1 interactions are consumed decisions.
 * Terminal evidence belongs to that operation, never to another interaction
 * that happens to publish the same bytes.
 *
 *  A record authorizes filesystem work in a store the user carries into every
 *  project, and it is read by a process that did not write it. It is therefore
 *  never trusted as a shape: it is decoded strictly, and then every claim it
 *  makes is recomputed. The plan must still hash to the proposal identity it
 *  records, a manifest must still hash to the operation identity its file name
 *  announces, its package bytes must still hash to the identity it records,
 *  every path it names must be one a package may hold, and every directory it
 *  names must be one of the Flywheel-owned store paths this reconciliation
 *  owns. A record that fails any check authorizes nothing: it is quarantined
 *  with the reason, and the packages stay as they are. */

import { Schema } from "effect";
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, rmSync, type Dirent } from "node:fs";
import { basename, dirname, join, relative, sep } from "node:path";
import { writeFileAtomic } from "../../../infra/atomic-write.js";
import { ContainedDirectory } from "../../../infra/descriptor-directory.js";
import { ContainedFileTooLargeError, ContainedPathError } from "../../../infra/descriptor-directory-contract.js";
import { readFileUnder } from "../../../infra/write-file-under.js";
import { LearningScopeSchema } from "../../../infra/learning-scope.js";
import { Log } from "../../../infra/log.js";
import { MutationDiffSchema } from "../../../infra/mutation-diff.js";
import { readManifestPackage } from "../../../workflows/skill-context.js";
import { canonicalMutationPath } from "../../../infra/file-mutation-queue.js";
import { packagePathRefusal } from "../../../workflows/skill-package-path.js";
import { proposalIdentityOfPlan } from "./skill-mutation-plan.js";
import type { SkillMutationPlan } from "./skill-store-types.js";

const log = Log.create({ service: "skill-operation-manifest" });

/** Both identities are sha256 digests, so a record's file name is fully
 *  determined. Enumeration and every path derived from a name admit exactly
 *  this shape, which is why no name can escape its directory. */
const RECORD_ID_PATTERN = /^[0-9a-f]{64}$/;

/** Framing of the operation identity. The version tag makes a later change of
 *  the framing a different identity, never a silent one. */
const OPERATION_IDENTITY_DOMAIN = "flywheel-skill-operation/1";

/** A record carries one prepared package, so it is large but bounded. The
 *  bound is checked against the open file before any buffer is allocated. */
const MAX_RECORD_BYTES = 4 * 1024 * 1024;

/** One store holds one live record per package under confirmation. An area with
 *  more records than this is not a working store, and reconciliation refuses to
 *  walk it rather than doing unbounded work on every registry build. */
const MAX_AREA_RECORDS = 512;

/** Aggregate proposal bytes retained before confirmation. Individual package
 * plans are bounded separately; this cap prevents many distinct plans from
 * turning the user-wide confirmation area into persistent storage pressure. */
const MAX_PROPOSAL_AREA_BYTES = 64 * 1024 * 1024;

/** Progress of one confirmed operation.
 *
 *  `claiming` is written before the consuming append, so a crash during the
 *  claim leaves the operation recoverable instead of stranding a consumed
 *  answer. `staged`, `hidden`, and `published` are the filesystem stages.
 *  `completed` and `refused` are terminal: they are retained, so a replay of
 *  the same confirmation reads the outcome instead of applying the mutation a
 *  second time. */
const OPERATION_STATES = [
  "claiming",
  "claimed",
  "staged",
  "hidden",
  "published",
  "completed",
  "refused",
] as const;

export type OperationState = (typeof OPERATION_STATES)[number];

const LEGAL_OPERATION_TRANSITIONS = {
  claiming: ["claimed"],
  claimed: ["staged", "published", "refused"],
  staged: ["hidden"],
  hidden: ["published", "refused"],
  published: ["completed"],
  completed: [],
  refused: [],
} as const satisfies { readonly [State in OperationState]: readonly OperationState[] };

interface OperationPoint {
  readonly state: OperationState;
  readonly transition: number;
}

function reachableOperationTransitions(): ReadonlyMap<OperationState, ReadonlySet<number>> {
  const reachable = new Map<OperationState, Set<number>>();
  for (const state of OPERATION_STATES) reachable.set(state, new Set());
  const pending: OperationPoint[] = [{ state: "claiming", transition: 1 }];
  for (const point of pending) {
    const transitions = reachable.get(point.state);
    if (!transitions) throw new Error(`Unknown skill operation state: ${point.state}`);
    if (transitions.has(point.transition)) continue;
    transitions.add(point.transition);
    for (const state of LEGAL_OPERATION_TRANSITIONS[point.state]) pending.push({ state, transition: point.transition + 1 });
  }
  return reachable;
}

const REACHABLE_OPERATION_TRANSITIONS = reachableOperationTransitions();

const OperationOriginSchema = Schema.Struct({
  sessionId: Schema.String,
  interactionId: Schema.String,
});

/** The confirmation one operation applies: the session that holds the claim and
 *  the exact question whose consumed answer is that claim. */
export type OperationOrigin = typeof OperationOriginSchema.Type;

/** Identity of one confirmed operation. An answered question is consumed at
 *  most once, so this names one operation and never two: a later confirmation
 *  of identical bytes is a different question, so it is a different operation
 *  with its own manifest and its own terminal evidence. */
export function operationIdentity(origin: OperationOrigin, proposalId: string): string {
  const digest = createHash("sha256").update(OPERATION_IDENTITY_DOMAIN);
  for (const field of [origin.sessionId, origin.interactionId, proposalId]) digest.update(`${field.length}\n${field}\n`);
  return digest.digest("hex");
}

const PreparedLocationSchema = Schema.Struct({
  reach: LearningScopeSchema,
  root: Schema.Literals(["user", "project"]),
  dir: Schema.String,
});

const PreparedPackageSchema = Schema.Struct({
  files: Schema.Array(Schema.Struct({
    path: Schema.String,
    bytes: Schema.Int,
    content: Schema.String,
  })),
  identity: Schema.Struct({ sha256: Schema.String, bytes: Schema.Int }),
});

const PreparedMutationOutcomeSchema = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("package"),
    destination: PreparedLocationSchema,
    package: PreparedPackageSchema,
    writePath: Schema.String,
  }),
  Schema.Struct({
    kind: Schema.Literal("absence"),
    destination: PreparedLocationSchema,
    package: PreparedPackageSchema,
    removePath: Schema.String,
  }),
  Schema.Struct({
    kind: Schema.Literals(["archive", "restore", "promotion"]),
    source: PreparedLocationSchema,
    destination: PreparedLocationSchema,
    package: PreparedPackageSchema,
  }),
]);

const SkillMutationPlanSchema = Schema.Struct({
  proposalId: Schema.String,
  action: Schema.Literals(["created", "updated", "patched", "support_file", "file_removed", "archived", "restored", "promoted"]),
  name: Schema.String,
  reach: LearningScopeSchema,
  root: Schema.Literals(["user", "project"]),
  outcome: PreparedMutationOutcomeSchema,
  description: Schema.String,
  contentHash: Schema.String,
  diff: MutationDiffSchema,
  message: Schema.String,
  summary: Schema.String,
  basePackageSha256: Schema.optionalKey(Schema.String),
  // Compatibility: until after 2027-10-26, admit the retired catalog-truncation
  // advisory that pending proposals and manifests written before 2026-10-26 can
  // carry. Nothing reads it, so it decodes and is ignored.
  warning: Schema.optionalKey(Schema.String),
});

/** The store roots a record was planned against. Recovery compares every
 *  directory the plan names against these, so a record can never point
 *  filesystem work at a path outside the two owned stores. The originating
 *  workspace is named by `projectStoreDir`: it identifies the one event store
 *  that holds the claim, so no other project can reconcile consent for it. */
const PLANNED_AGAINST_FIELDS = {
  globalStoreDir: Schema.String,
  projectStoreDir: Schema.String,
};

const ProposalRecordSchema = Schema.Struct({
  version: Schema.Literal(1),
  proposalId: Schema.String,
  createdAt: Schema.Int,
  ...PLANNED_AGAINST_FIELDS,
  plan: SkillMutationPlanSchema,
});

const OperationManifestFields = {
  state: Schema.Literals(OPERATION_STATES),
  operationId: Schema.String,
  /** How many state transitions this manifest has committed, counting the claim
   *  that opened it. Progress is one total order, so a journalled audit fact for
   *  transition N is proven by a manifest at N or beyond, and disproven only
   *  once the operation is terminal below it. The state list alone cannot say
   *  it: a refused operation may or may not have staged first. */
  transition: Schema.Int,
  createdAt: Schema.Int,
  updatedAt: Schema.Int,
  ...PLANNED_AGAINST_FIELDS,
  origin: OperationOriginSchema,
  /** Why a terminal operation ended as it did, and where any preserved bytes
   *  were left. Evidence for a reader, never an input to recovery. */
  outcomeDetail: Schema.optionalKey(Schema.String),
  plan: SkillMutationPlanSchema,
};
const OperationManifestSchema = Schema.Union([
  // Compatibility: retain the consent-bound format until after 2027-09-24.
  // Decode in place; converting to version 2 would authorize unconfirmed work.
  Schema.Struct({ version: Schema.Literal(1), ...OperationManifestFields }),
  Schema.Struct({ version: Schema.Literal(2), ...OperationManifestFields }),
]);

export type ProposalRecord = typeof ProposalRecordSchema.Type;
export type OperationManifest = typeof OperationManifestSchema.Type;

/** Builds the next durable operation revision. Callers own the filesystem work
 * that makes the transition true; this gate owns legal order and sequence. */
export function advanceOperationManifest(manifest: OperationManifest, state: OperationState, detail?: string): OperationManifest {
  if (!LEGAL_OPERATION_TRANSITIONS[manifest.state].some((candidate) => candidate === state)) {
    throw new Error(`Illegal skill operation transition: ${manifest.state} -> ${state}`);
  }
  return {
    ...manifest,
    state,
    transition: manifest.transition + 1,
    updatedAt: Date.now(),
    ...(detail === undefined ? {} : { outcomeDetail: detail }),
  };
}

/** Compile-time proof that the schema decodes the planner's own plan type. A
 *  field added to one side without the other fails the build rather than the
 *  recovery. */
type DecodedPlan = typeof SkillMutationPlanSchema.Type;
type PlanSchemaMatchesPlanner = DecodedPlan extends SkillMutationPlan ? (SkillMutationPlan extends DecodedPlan ? true : never) : never;
const PLAN_SCHEMA_MATCHES_PLANNER: PlanSchemaMatchesPlanner = true;
void PLAN_SCHEMA_MATCHES_PLANNER;

export function operationsDir(globalRoot: string): string {
  return join(globalRoot, ".operations");
}

/** Where proposals nobody has confirmed are kept. They are named by content, so
 *  they live outside the area recovery walks: nothing about a proposal is
 *  resumable. */
function proposalsDir(globalRoot: string): string {
  return join(operationsDir(globalRoot), "proposals");
}

/** Where terminal manifests are kept. A terminal manifest is retained for as
 *  long as the consumed claim it answers, which is forever, so it lives outside
 *  the area recovery enumerates: a replay looks its own operation up by
 *  identity instead. */
function terminalDir(globalRoot: string): string {
  return join(operationsDir(globalRoot), "terminal");
}

/** Which area holds one manifest. `active` is what reconciliation walks;
 *  `terminal` is retained replay evidence. */
export type ManifestArea = "active" | "terminal";

function areaDir(globalRoot: string, area: ManifestArea): string {
  return area === "active" ? operationsDir(globalRoot) : terminalDir(globalRoot);
}

export function manifestPath(globalRoot: string, operationId: string, area: ManifestArea = "active"): string {
  return join(areaDir(globalRoot, area), `${operationId}.json`);
}

export function proposalPath(globalRoot: string, proposalId: string): string {
  return join(proposalsDir(globalRoot), `${proposalId}.json`);
}

export function stagingDir(globalRoot: string, operationId: string): string {
  return join(operationsDir(globalRoot), "staging", operationId);
}

/** Where a swap hides the package it replaces: inside the store that holds it,
 *  so the rename stays on one filesystem, and hidden, so admission skips it. */
export function rollbackDir(storeDir: string, operationId: string): string {
  return join(storeDir, ".operations", "rollback", operationId);
}

/** Where bytes that cannot be published or restored are preserved. Nothing
 *  reads this area: it exists so no recovery path has to choose between a
 *  conflict and deleting the only copy of a package. */
export function quarantineDir(storeDir: string, label: string): string {
  return join(storeDir, ".operations", "quarantine", label);
}

export type ManifestRead =
  | { readonly kind: "ok"; readonly manifest: OperationManifest; readonly area: ManifestArea }
  | { readonly kind: "absent" }
  | { readonly kind: "unusable"; readonly reason: string };

export type ProposalRead =
  | { readonly kind: "ok"; readonly proposal: ProposalRecord }
  | { readonly kind: "absent" }
  | { readonly kind: "unusable"; readonly reason: string };

/** Read, strictly decode, and fully verify the manifest of one operation,
 *  preferring the active area over retained terminal evidence. */
export function readOperationManifest(globalRoot: string, operationId: string): ManifestRead {
  if (!RECORD_ID_PATTERN.test(operationId)) return { kind: "unusable", reason: `${operationId} is not an operation identity` };
  const active = readManifestFromArea(globalRoot, operationId, "active");
  return active.kind === "absent" ? readManifestFromArea(globalRoot, operationId, "terminal") : active;
}

function readManifestFromArea(globalRoot: string, operationId: string, area: ManifestArea): ManifestRead {
  const text = readRecordText(globalRoot, manifestPath(globalRoot, operationId, area));
  if (text.kind !== "ok") return text;
  let manifest: OperationManifest;
  try {
    manifest = Schema.decodeUnknownSync(OperationManifestSchema, { onExcessProperty: "error" })(JSON.parse(text.text));
  } catch (err) {
    return { kind: "unusable", reason: `manifest does not decode: ${err instanceof Error ? err.message : String(err)}` };
  }
  const refusal = verifyOperationManifest(manifest, { operationId, globalRoot });
  return refusal ? { kind: "unusable", reason: refusal } : { kind: "ok", manifest, area };
}

/** Read, strictly decode, and fully verify one proposal. */
export function readProposalRecord(globalRoot: string, proposalId: string): ProposalRead {
  if (!RECORD_ID_PATTERN.test(proposalId)) return { kind: "unusable", reason: `${proposalId} is not a proposal identity` };
  const text = readRecordText(globalRoot, proposalPath(globalRoot, proposalId));
  return text.kind === "ok" ? decodeProposalRecord(globalRoot, proposalId, text.text) : text;
}

function decodeProposalRecord(globalRoot: string, proposalId: string, text: string): ProposalRead {
  let proposal: ProposalRecord;
  try {
    proposal = Schema.decodeUnknownSync(ProposalRecordSchema, { onExcessProperty: "error" })(JSON.parse(text));
  } catch (err) {
    return { kind: "unusable", reason: `proposal does not decode: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (proposal.proposalId !== proposalId) {
    return { kind: "unusable", reason: `proposal file ${proposalId}.json does not name proposal ${proposal.proposalId}` };
  }
  if (proposal.plan.proposalId !== proposalId) {
    return { kind: "unusable", reason: "the proposal and the plan it carries name different mutations" };
  }
  const refusal = verifyPlannedRecord(proposal, globalRoot);
  return refusal ? { kind: "unusable", reason: refusal } : { kind: "ok", proposal };
}

type RecordText =
  | { readonly kind: "ok"; readonly text: string; readonly bytes: number }
  | { readonly kind: "absent" }
  | { readonly kind: "unusable"; readonly reason: string };

/** Read a bounded regular record through the store's contained-file authority. */
function readRecordText(globalRoot: string, path: string, byteLimit: number = MAX_RECORD_BYTES): RecordText {
  const limit = Math.min(MAX_RECORD_BYTES, byteLimit);
  try {
    const buffer = readFileUnder(globalRoot, relative(globalRoot, path).split(sep).join("/"), { maxBytes: limit });
    return buffer === undefined
      ? { kind: "absent" }
      : { kind: "ok", text: buffer.toString("utf8"), bytes: buffer.byteLength };
  } catch (err) {
    if (isAbsent(err)) return { kind: "absent" };
    if (isErrnoCode(err, "ELOOP") || isErrnoCode(err, "EMLINK")) return { kind: "unusable", reason: "record path is a symbolic link" };
    if (err instanceof ContainedFileTooLargeError) return { kind: "unusable", reason: `record exceeds the ${limit} byte bound` };
    if (isErrnoCode(err, "EISDIR") || (err instanceof ContainedPathError && err.cause === undefined && !("code" in err))) {
      return { kind: "unusable", reason: "record path is not a contained regular file" };
    }
    throw err;
  }
}

/** Why this manifest may not drive filesystem work, or undefined when every
 *  claim it makes still holds. */
function verifyOperationManifest(
  manifest: OperationManifest,
  context: { readonly operationId: string; readonly globalRoot: string },
): string | undefined {
  if (context.operationId !== manifest.operationId) {
    return `manifest file ${context.operationId}.json does not name operation ${manifest.operationId}`;
  }
  if (operationIdentity(manifest.origin, manifest.plan.proposalId) !== manifest.operationId) {
    return "the operation identity does not name the confirmation and proposal the manifest records";
  }
  const reachable = REACHABLE_OPERATION_TRANSITIONS.get(manifest.state);
  if (!Number.isSafeInteger(manifest.transition) || !reachable?.has(manifest.transition)) {
    const expected = reachable ? [...reachable].sort((left, right) => left - right).join(", ") : "none";
    return `the manifest state ${manifest.state} cannot record transition ${manifest.transition}; expected ${expected}`;
  }
  return verifyPlannedRecord(manifest, context.globalRoot);
}

/** A record's plan carries the whole mutation, so a reader recomputes every
 *  claim it makes before anything acts on it. */
type PlannedRecord = {
  readonly plan: SkillMutationPlan;
  readonly globalStoreDir: string;
  readonly projectStoreDir: string;
};

/** Why the plan one record carries may not drive filesystem work. */
function verifyPlannedRecord(record: PlannedRecord, globalRoot: string): string | undefined {
  const plan = record.plan;
  if (proposalIdentityOfPlan(plan) !== plan.proposalId) return "the plan does not hash to the proposal identity it claims";
  if (plan.reach !== "global") return `a ${plan.reach} mutation is not a confirmed global operation`;
  if (canonicalMutationPath(record.globalStoreDir) !== canonicalMutationPath(globalRoot)) {
    return "the record was planned against a different global store";
  }
  return verifyPackage(plan) ?? verifyLocations(record);
}

/** The package the plan carries must still be the package it identifies, and
 *  every path in it must be one a package may hold. */
function verifyPackage(plan: SkillMutationPlan): string | undefined {
  const outcome = plan.outcome;
  const named = outcome.kind === "package" ? outcome.writePath : outcome.kind === "absence" ? outcome.removePath : undefined;
  const paths = [...outcome.package.files.map((file) => file.path), ...(named ? [named] : [])];
  for (const path of paths) {
    const refusal = packagePathRefusal(path);
    if (refusal) return `the plan names a path no package may hold: ${refusal}`;
  }
  if (outcome.kind === "package" && !outcome.package.files.some((file) => file.path === outcome.writePath)) {
    return "the plan does not carry the file it writes";
  }
  const files = new Map(outcome.package.files.map((file) => [file.path, file.content]));
  let identity: { sha256: string; bytes: number };
  try {
    identity = readManifestPackage(files).identity;
  } catch (err) {
    return `the plan's package is not admissible: ${err instanceof Error ? err.message : String(err)}`;
  }
  if (identity.sha256 !== outcome.package.identity.sha256 || identity.bytes !== outcome.package.identity.bytes) {
    return "the plan's bytes do not hash to the package identity it records";
  }
  for (const file of outcome.package.files) {
    if (Buffer.byteLength(file.content, "utf8") !== file.bytes) return `the plan misstates the length of ${file.path}`;
  }
  return undefined;
}

/** Every directory the plan names must be one of the four package paths the
 *  two owned stores can hold for this id. */
function verifyLocations(record: PlannedRecord): string | undefined {
  const plan = record.plan;
  const global = record.globalStoreDir;
  const project = record.projectStoreDir;
  const owned = new Map<string, "global" | "project">([
    [canonicalMutationPath(join(global, plan.name)), "global"],
    [canonicalMutationPath(join(global, ".archive", plan.name)), "global"],
    [canonicalMutationPath(join(project, plan.name)), "project"],
    [canonicalMutationPath(join(project, ".archive", plan.name)), "project"],
  ]);
  const destination = owned.get(canonicalMutationPath(plan.outcome.destination.dir));
  if (destination !== "global") return "the destination is not this global store's package path";
  const outcome = plan.outcome;
  if (!("source" in outcome)) return undefined;
  const source = owned.get(canonicalMutationPath(outcome.source.dir));
  if (source === undefined) return "the source is not an owned store package path";
  if (source === "project" && outcome.kind !== "promotion") return "only a promotion may move a project package";
  return undefined;
}

/** Persist one manifest durably before the step it authorizes runs. A terminal
 *  manifest is written to the retained area and its active copy dropped, so the
 *  move out of the reconciliation walk is the same durable step that records
 *  the outcome. */
export function writeOperationManifest(globalRoot: string, manifest: OperationManifest): void {
  const area: ManifestArea = isTerminalState(manifest.state) ? "terminal" : "active";
  mkdirSync(areaDir(globalRoot, area), { recursive: true });
  writeFileAtomic(manifestPath(globalRoot, manifest.operationId, area), JSON.stringify(manifest), { durableDirectorySync: true });
  if (area === "terminal") rmSync(manifestPath(globalRoot, manifest.operationId, "active"), { force: true });
}

/** Is this the last state one operation reaches? Terminal manifests are
 *  retained evidence: a replay of the same confirmation reads the outcome
 *  instead of applying the mutation again. */
export function isTerminalState(state: OperationState): boolean {
  return state === "completed" || state === "refused";
}

/** Preserve a refused record through contained source and destination directories. */
export function quarantineManifest(globalRoot: string, operationId: string, reason: string): void {
  quarantineRecord(globalRoot, "manifest", manifestPath(globalRoot, operationId, "active"), operationId, reason);
}

function quarantineProposal(globalRoot: string, proposalId: string, reason: string): void {
  quarantineRecord(globalRoot, "proposal", proposalPath(globalRoot, proposalId), proposalId, reason);
}

/** Reconciliation treats quarantine as cleanup, not an availability boundary.
 * A hostile or damaged quarantine destination must not stop registry startup. */
function tryQuarantineProposal(globalRoot: string, proposalId: string, reason: string): void {
  try {
    quarantineProposal(globalRoot, proposalId, reason);
  } catch (err) {
    log.warn("global skill proposal could not be quarantined", { proposalId, reason, err: String(err) });
  }
}

function quarantineRecord(globalRoot: string, kind: string, path: string, id: string, reason: string): void {
  if (!RECORD_ID_PATTERN.test(id)) throw new Error(`refusing to quarantine ${id}: not a record identity`);
  const target = quarantineDir(globalRoot, `${kind}-${Date.now()}-${id}.json`);
  try {
    using held = new DisposableStack();
    const source = ContainedDirectory.openExisting(globalRoot, relative(globalRoot, dirname(path)).split(sep));
    if (source) {
      held.defer(() => source.close());
      const destination = ContainedDirectory.open(globalRoot, relative(globalRoot, dirname(target)).split(sep));
      held.defer(() => destination.close());
      source.renameInto(basename(path), destination, basename(target));
    }
  } catch (err) {
    if (!isAbsent(err)) throw err;
  }
  log.warn("global skill operation record quarantined", { kind, id, reason, target });
}

/** The operation identity of every manifest in the active area. */
export function activeOperationIds(globalRoot: string): readonly string[] {
  return recordIds(operationsDir(globalRoot), "operation");
}

/** The proposal identity of every persisted proposal. */
export function proposalRecordIds(globalRoot: string): readonly string[] {
  return recordIds(proposalsDir(globalRoot), "proposal", (proposalId) => {
    tryQuarantineProposal(globalRoot, proposalId, `proposal area exceeded its ${MAX_AREA_RECORDS} record bound`);
  });
}

/** Read the proposal set used by startup and admission. Each record is measured,
 * read, decoded, and verified from one open descriptor while sharing one byte
 * budget across the walk. No later path reopen can enlarge this work. */
export function readProposalRecordsForReconciliation(globalRoot: string): readonly ProposalRecord[] {
  const ids = recordIds(proposalsDir(globalRoot), "proposal", (proposalId) => {
    tryQuarantineProposal(globalRoot, proposalId, `proposal area exceeded its ${MAX_AREA_RECORDS} record bound`);
  });
  const proposals: ProposalRecord[] = [];
  let remaining = MAX_PROPOSAL_AREA_BYTES;
  for (const proposalId of ids) {
    if (remaining === 0) {
      tryQuarantineProposal(globalRoot, proposalId, `proposal area exceeded its ${MAX_PROPOSAL_AREA_BYTES} byte startup bound`);
      continue;
    }
    const text = readRecordText(globalRoot, proposalPath(globalRoot, proposalId), remaining);
    if (text.kind === "absent") continue;
    if (text.kind === "unusable") {
      tryQuarantineProposal(globalRoot, proposalId, text.reason);
      continue;
    }
    remaining -= text.bytes;
    const read = decodeProposalRecord(globalRoot, proposalId, text.text);
    if (read.kind === "ok") proposals.push(read.proposal);
    else if (read.kind === "unusable") tryQuarantineProposal(globalRoot, proposalId, read.reason);
  }
  return proposals;
}


/** The record identities of one area, ascending so reconciliation is
 *  deterministic.
 *
 *  Only bounded, correctly named regular files are enumerated: the area is
 *  shared with every project the user opens, it holds the protocol's own
 *  working directories beside its records, and a directory entry is untrusted
 *  until it is proved to be one this module wrote. The bound is therefore over
 *  the records themselves, so an unrelated entry can neither trip it nor hide a
 *  record behind it. */
function recordIds(dir: string, kind: string, onExcess?: (id: string) => void): readonly string[] {
  let entries: readonly Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    if (isAbsent(err)) return [];
    throw err;
  }
  const ids: string[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const id = entry.name.slice(0, -".json".length);
    if (!RECORD_ID_PATTERN.test(id)) continue;
    if (!onExcess && ids.length === MAX_AREA_RECORDS) throw new Error(`${dir} holds more than ${MAX_AREA_RECORDS} ${kind} records`);
    ids.push(id);
  }
  ids.sort();
  if (!onExcess || ids.length <= MAX_AREA_RECORDS) return ids;
  for (const id of ids.slice(MAX_AREA_RECORDS)) onExcess(id);
  return ids.slice(0, MAX_AREA_RECORDS);
}

function isAbsent(err: unknown): boolean {
  return isErrnoCode(err, "ENOENT") || isErrnoCode(err, "ENOTDIR");
}

function isErrnoCode(err: unknown, code: string): boolean {
  return typeof err === "object" && err !== null && "code" in err && err.code === code;
}
