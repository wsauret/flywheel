/** Skill usage telemetry derives from durable load, tool-input, and managed-write
 *  facts. A rebuildable prefix snapshot and an in-process high-water mark keep
 *  repeated reads proportional to new activity. Consumers are the maintenance
 *  CLI, lifecycle pruner, and learning review context. */

import { capturedFacts, type AsyncEventWriter, type AsyncEventStateReadSurface, type StoredFact } from "../../../infra/event-store-types.js";
import type { LearningScope } from "../../../infra/learning-scope.js";
import { createOrderedLane, type OrderedLane } from "../../../infra/ordered-lane.js";
import { createEventProjection, parseProjectionFact } from "../../../infra/event-projection.js";
import { heldProjection } from "../../../infra/projection-registry.js";
import { skillLoadsSnapshottedFact, type SkillLoadedFact, type SkillLoadsSnapshottedFact, type SkillWrittenFact } from "../../../workflows/skill-facts.js";
import type { SessionFactWriter } from "../../session/session-fact-writer.js";
import { parseSessionFact } from "../../session/session-fact-registry.js";

export interface SkillLoadStats {
  loads: number;
  lastLoadedAt: number;
}

export interface SkillLoadRecord {
  sessionId: string;
  timestamp: number;
  modelRequestId?: string;
}

export interface SkillWriteRecord {
  sessionId: string;
  timestamp: number;
  action: string;
  /** Reach of the store the write landed in. */
  reach: LearningScope;
  /** Origin identity: "user", "session:<id>", or "review:<runId>". */
  origin: string;
  contentHash: string;
  /** Whole-package identity after the write. Absent for writes recorded before
   *  prepared package identities existed. */
  packageSha256?: string;
}

const SKILL_MAINTENANCE_AGGREGATE = "session:skill-pruner";
const SKILL_LOAD_SNAPSHOT_TYPE = "skill.loads.snapshotted";

// The tool input inside the fact is model-authored, so the reads here are the
// external-boundary kind: typeof guards, skip on mismatch, never throw.
interface ParsedTelemetryFields {
  readonly [key: string]: unknown;
}

function isParsedTelemetryFields(value: unknown): value is ParsedTelemetryFields {
  return typeof value === "object" && value !== null;
}

function field(value: unknown, key: string) {
  return isParsedTelemetryFields(value) ? value[key] : undefined;
}

function skillLoadId(event: StoredFact): string | undefined {
  if (field(event.payload, "toolName") !== "skill") return undefined;
  const input = field(event.payload, "input");
  if (field(input, "action") !== "load") return undefined;
  const skillId = field(input, "skill_id");
  return typeof skillId === "string" && skillId ? skillId : undefined;
}

interface SkillLoadProjection {
  readonly stats: Map<string, SkillLoadStats>;
  readonly throughPosition: number;
}

interface SkillLoadCatchUp {
  projection?: SkillLoadProjection;
  readonly folds: OrderedLane;
}

const skillLoadProjectionCache = new WeakMap<AsyncEventStateReadSurface, SkillLoadCatchUp>();

async function latestSkillLoadProjection(store: AsyncEventStateReadSurface, cached?: SkillLoadProjection): Promise<SkillLoadProjection> {
  if (cached) return { stats: new Map(cached.stats), throughPosition: cached.throughPosition };
  const snapshot = (await store.readLatestByAggregateAndTypes(SKILL_MAINTENANCE_AGGREGATE, [SKILL_LOAD_SNAPSHOT_TYPE]))[0];
  if (!snapshot) return { stats: new Map(), throughPosition: 0 };
  const fact = parseSessionFact<SkillLoadsSnapshottedFact>(factEnvelope(snapshot));
  if (fact.payload.throughPosition >= snapshot.position) throw new Error("skill load snapshot claims events at or after its own position");
  const stats = new Map(fact.payload.stats.map(({ skillId, loads, lastLoadedAt }) => [skillId, { loads, lastLoadedAt }]));
  if (stats.size !== fact.payload.stats.length) throw new Error("skill load snapshot contains duplicate skill ids");
  return { stats, throughPosition: fact.payload.throughPosition };
}

function projectSkillLoadStats(store: AsyncEventStateReadSurface): Promise<SkillLoadProjection> {
  let owner = skillLoadProjectionCache.get(store);
  if (!owner) {
    owner = { folds: createOrderedLane() };
    skillLoadProjectionCache.set(store, owner);
  }
  const cache = owner;
  return cache.folds.run(async () => {
    const projection = await latestSkillLoadProjection(store, cache.projection);
    const upper = await store.capturePosition();
    for await (const event of capturedFacts(store, { types: ["tool.input.completed"] }, { upperPosition: upper, afterPosition: projection.throughPosition })) {
      const skillId = skillLoadId(event);
      if (!skillId) continue;
      const entry = projection.stats.get(skillId);
      projection.stats.set(skillId, {
        loads: (entry?.loads ?? 0) + 1,
        lastLoadedAt: entry ? Math.max(entry.lastLoadedAt, event.timestamp) : event.timestamp,
      });
    }
    const completed = { stats: projection.stats, throughPosition: Math.max(projection.throughPosition, upper) };
    // A failed fold publishes nothing.
    cache.projection = { stats: new Map(completed.stats), throughPosition: completed.throughPosition };
    return completed;
  });
}

/** Load counts per skill from the latest rebuildable snapshot plus its unseen fact suffix. */
export async function collectSkillLoadStats(store: AsyncEventStateReadSurface): Promise<Map<string, SkillLoadStats>> {
  return (await projectSkillLoadStats(store)).stats;
}

/** Publish the current load projection and discard older replace-only snapshots. */
export async function refreshSkillLoadStatsSnapshot(
  store: AsyncEventStateReadSurface,
  writer: SessionFactWriter,
  maintenance: Pick<AsyncEventWriter, "pruneSupersededEvents">,
): Promise<Map<string, SkillLoadStats>> {
  const projection = await projectSkillLoadStats(store);
  const throughPosition = projection.throughPosition;
  const stats = [...projection.stats.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([skillId, value]) => ({ skillId, ...value }));
  const stored = await writer.record(skillLoadsSnapshottedFact({ throughPosition, stats }));
  if (!stored) throw new Error("skill load snapshot writer was disposed before the snapshot landed");
  await maintenance.pruneSupersededEvents(SKILL_MAINTENANCE_AGGREGATE, SKILL_LOAD_SNAPSHOT_TYPE);
  return projection.stats;
}

/** The lifecycle pass's two activity inputs from one store.
 *
 *  `activity` is the opening snapshot the pass plans against. `latestActivity`
 *  is the recheck the pruner runs under the package lock, so it advances from
 *  committed activity rather than closing over the snapshot: a session that loads a skill
 *  while the pass is walking the library must keep that skill off the archive
 *  list. Both callers of the pruner take the pair from here, so the recheck
 *  cannot be wired to a fixed map at one of them. */
export async function skillActivitySource(store: AsyncEventStateReadSurface, loads?: ReadonlyMap<string, SkillLoadStats>) {
  const projection = skillActivityProjection(store);
  const activity = new Map(await projection.replay());
  for (const [skillId, stats] of loads ?? []) activity.set(skillId, Math.max(activity.get(skillId) ?? 0, stats.lastLoadedAt));
  return {
    activity,
    latestActivity: async (skillId: string) => (await projection.replay()).get(skillId),
  };
}

function skillActivityProjection(store: AsyncEventStateReadSurface) {
  return heldProjection(store, "learning-skill-activity", () => createEventProjection(store, {
    factTypes: ["tool.input.completed", "skill.loaded", "skill.written"],
    initialState: () => new Map<string, number>(),
    seed: async () => {
      const { stats } = await latestSkillLoadProjection(store);
      // Load snapshots may retain timestamps from a compacted telemetry prefix.
      // Writes and direct loads have no such snapshot, so their cursor starts at zero.
      return { state: new Map([...stats].map(([id, entry]) => [id, entry.lastLoadedAt])), position: 0 };
    },
    reduce(activity, event) {
      let skillId: string | undefined;
      if (event.type === "tool.input.completed") {
        skillId = skillLoadId(event);
      } else if (event.type === "skill.loaded") {
        skillId = parseProjectionFact(event, parseSessionFact<SkillLoadedFact>).payload.name;
      } else {
        const { payload } = parseProjectionFact(event, parseSessionFact<SkillWrittenFact>);
        if (payload.origin.kind !== "pruner") skillId = payload.name;
      }
      if (skillId) activity.set(skillId, Math.max(activity.get(skillId) ?? 0, event.timestamp));
      return activity;
    },
  }));
}

/** One skill's loads with session and request identities, newest first. */
export async function collectSkillLoadRecords(store: AsyncEventStateReadSurface, skillId: string): Promise<SkillLoadRecord[]> {
  const records: SkillLoadRecord[] = [];
  for await (const event of capturedFacts(store,{ types: ["tool.input.completed"] })) {
    if (skillLoadId(event) !== skillId) continue;
    const modelRequestId = field(event.payload, "modelRequestId");
    records.push({
      sessionId: event.sessionId,
      timestamp: event.timestamp,
      ...(typeof modelRequestId === "string" ? { modelRequestId } : {}),
    });
  }
  return records.sort((a, b) => b.timestamp - a.timestamp);
}

function originIdentity(origin: SkillWrittenFact["payload"]["origin"]): string {
  switch (origin.kind) {
    case "user": return "user";
    case "pruner": return "pruner";
    case "agent": return `session:${origin.sessionId}`;
    case "review": return `review:${origin.reviewRunId}`;
  }
}

function factEnvelope(event: StoredFact) {
  return { type: event.type, version: event.version, actor: event.actor, payload: event.payload };
}

/** One skill's managed writes with origin identities, newest first. These are
 *  Flywheel-owned facts, so they are decoded through the registry: a payload
 *  the current schema does not accept is a store defect, not a value to guess
 *  at. Version upgrades run in `prepareWorkspaceState` before any reader. */
export async function collectSkillWriteRecords(store: AsyncEventStateReadSurface, name: string): Promise<SkillWriteRecord[]> {
  const records: SkillWriteRecord[] = [];
  for await (const event of capturedFacts(store,{ types: ["skill.written"] })) {
    const { payload } = parseSessionFact<SkillWrittenFact>(factEnvelope(event));
    if (payload.name !== name) continue;
    records.push({
      sessionId: event.sessionId,
      timestamp: event.timestamp,
      action: payload.action,
      reach: payload.reach,
      origin: originIdentity(payload.origin),
      contentHash: payload.contentHash,
      ...(payload.identity.kind === "recorded" ? { packageSha256: payload.identity.packageIdentity.sha256 } : {}),
    });
  }
  return records.sort((a, b) => b.timestamp - a.timestamp);
}

const TELEMETRY_LIMIT = 15;

/** The review's load-count context block: most-loaded skills first, so the
 *  review prefers patching the skills sessions actually reach for. Undefined
 *  when the workspace has no recorded loads, so quiet workspaces add nothing
 *  to the review prompt. */
export function renderSkillLoadStats(stats: ReadonlyMap<string, SkillLoadStats>): string | undefined {
  if (stats.size === 0) return undefined;
  const ranked = [...stats.entries()]
    .sort(([, a], [, b]) => b.loads - a.loads || b.lastLoadedAt - a.lastLoadedAt)
    .slice(0, TELEMETRY_LIMIT);
  const lines = ranked.map(([skillId, { loads }]) => `- ${skillId}: ${loads} load${loads === 1 ? "" : "s"}`);
  return `## Skill load counts (workspace, most loaded first)\n\n${lines.join("\n")}`;
}
