/** What the learning stores owe this session, settled at the start of every
 *  interactive turn.
 *
 *  Two obligations outlive the run that created them. A published memory entry
 *  or skill package whose audit fact the event store never accepted leaves a
 *  journal entry beside the store; a recommendation the background review
 *  recorded is worthless until the interactive conversation holds it. Both are
 *  keyed by durable identity, so settling them is idempotent and belongs to the
 *  session, not to the review that happened to produce them: a review that
 *  never fires again, or a process that died before its next one, must not
 *  strand either. */

import { dirname } from "node:path";
import type { ProjectDirectories } from "../../../infra/directory-authorities.js";
import type { AsyncEventReadSurface } from "../../../infra/event-store-types.js";
import { createEventProjection, parseProjectionFact } from "../../../infra/event-projection.js";
import { heldProjection } from "../../../infra/projection-registry.js";
import { requireContainedDirectory } from "../../../infra/write-file-under.js";
import { Log } from "../../../infra/log.js";
import type { SkillRecommendationRecordedFact } from "../../../workflows/skill-facts.js";
import { ownedSkillStoreDirs } from "../../../workflows/skills.js";
import { escapeXml, formatRuntimeNotification } from "../../agent-runtime/runtime-notifications.js";
import { createConversationTreeProjection, currentContextIdentities } from "../../session/conversation/conversation-projection.js";
import type { ContextContentIdentities } from "../../session/conversation/conversation-context-identities.js";
import { reconcilePendingAudits } from "./learning-journal.js";
import { createMemoryStoreConfig, memoryStorePath } from "./memory-store.js";
import type { CapabilityAccess } from "../../agent-runtime/tools/types.js";
import type { SessionFactWriter } from "../../session/session-fact-writer.js";
import { parseSessionFact } from "../../session/session-fact-registry.js";

const log = Log.create({ service: "learning-reconciliation" });

export interface LearningJournalStore {
  readonly dir: string;
  readonly baseDir: string;
  readonly relativeDir: string;
}

export interface LearningReconciliationDeps {
  readonly sessionId: string;
  readonly conversationId: string;
  readonly store: AsyncEventReadSurface;
  /** Absent in a session that records nothing; journalled facts then wait for
   *  a session that does. */
  readonly writer?: SessionFactWriter;
  /** Root of the project whose event store settles these facts. The outbox is
   *  origin-bound, so a shared global store's entries are settled only by the
   *  workspace that opened them. */
  readonly projectRoot: string;
  /** Learning stores whose audit outboxes this project reads, each anchored at
   *  the project or home root that owns its path. */
  readonly auditStores: readonly LearningJournalStore[];
  /** Commit one model-visible, system-produced user-role turn (the
   *  commitSystemTurn channel). A recommendation is an instruction the model
   *  must act on, so it never uses the transcript-only system-kind channel,
   *  which reaches no provider wire. */
  readonly appendSystemTurn: (content: string) => Promise<void>;
  /** Capability boundary this settlement admits against (ARCH-RUNTIME-068). Settling an
   *  audit fact or delivering a managed-skill recommendation is managed-learning
   *  work, so it needs Learning and Skills. Absent in a realm that owns no
   *  policy, where the obligations settle as before. */
  readonly capabilities?: Pick<CapabilityAccess, "admit">;
}

export interface LearningReconciliation {
  readonly auditsRecorded: number;
  readonly delivered: readonly string[];
}

/** The learning stores one project writes, each with the trusted root used to
 *  admit its repository-controlled path before audit recovery reads it. */
export function learningAuditStores(directories: ProjectDirectories): readonly LearningJournalStore[] {
  const memory = createMemoryStoreConfig(directories.projectRoot, directories.accountHome);
  const skills = ownedSkillStoreDirs(directories);
  const stores: readonly LearningJournalStore[] = [
    {
      dir: dirname(memoryStorePath(memory, "project")),
      baseDir: memory.locations.project.baseDir,
      relativeDir: dirname(memory.locations.project.relativePath),
    },
    {
      dir: dirname(memoryStorePath(memory, "global")),
      baseDir: memory.locations.global.baseDir,
      relativeDir: dirname(memory.locations.global.relativePath),
    },
    { dir: skills.project, baseDir: directories.projectRoot, relativeDir: ".flywheel/skills" },
    { dir: skills.user, baseDir: memory.locations.global.baseDir, relativeDir: ".flywheel/skills" },
  ];
  return [...new Map(stores.map((store) => [store.dir, store])).values()];
}

/** Settle both obligations. Safe to call on every turn: each pass records only
 *  what is still outstanding. */
export async function reconcileLearning(deps: LearningReconciliationDeps): Promise<LearningReconciliation> {
  let auditsRecorded = 0;
  if (deps.capabilities) {
    const admission = await deps.capabilities.admit({ operation: "learning reconciliation", required: ["skills", "learning"] });
    if (!admission.ok) {
      log.info("learning reconciliation skipped", { sessionId: deps.sessionId, reason: admission.reason });
      return { auditsRecorded: 0, delivered: [] };
    }
  }
  const writer = deps.writer;
  if (writer) {
    for (const store of deps.auditStores) {
      requireContainedDirectory(store.baseDir, store.relativeDir);
      auditsRecorded += await reconcilePendingAudits({ storeDir: store.dir, workspace: deps.projectRoot, writer, reader: deps.store });
    }
  }
  const delivered = await deliverSkillRecommendations(deps);
  if (delivered.length > 0) log.info("delivered skill recommendations", { sessionId: deps.sessionId, delivered });
  return { auditsRecorded, delivered };
}

/** Deliver every recorded recommendation the parent conversation does not hold
 *  yet, oldest first, and return the identities delivered now.
 *
 *  The recommendation identity is the delivery key: it is written into the
 *  message, so the conversation itself says what was delivered and no flag or
 *  side table can disagree with it. The fact is recorded before this runs, so a
 *  crash between the fact and the append leaves a recommendation this pass
 *  delivers, and a crash after the append leaves an identity this pass skips.
 *  A compaction or rewind that removes the notice makes it eligible again. */
async function deliverSkillRecommendations(deps: LearningReconciliationDeps): Promise<readonly string[]> {
  const index = await recommendationIndex(deps.store, deps.sessionId, deps.conversationId).replay();
  if (index.size === 0) return [];
  const conversation = createConversationTreeProjection(deps.store, deps.conversationId);
  const synchronize = async () => {
    const context = await conversation.replay();
    index.synchronize(currentContextIdentities(context));
  };
  await synchronize();
  const delivered: string[] = [];
  for (const recommendation of index.pendingRecommendations()) {
    await deps.appendSystemTurn(renderSkillRecommendationNotification(recommendation));
    delivered.push(recommendation.recommendationId);
  }
  if (delivered.length > 0) await synchronize();
  return delivered;
}

function recommendationIndex(reader: AsyncEventReadSurface, sessionId: string, conversationId: string) {
  return heldProjection(reader, `learning-recommendations:${sessionId}:${conversationId}`, () => createEventProjection(reader, {
    aggregateId: `session:${sessionId}`,
    factTypes: ["skill.recommendation.recorded"],
    initialState: () => new RecommendationIndex(),
    reduce(state, event) {
      state.record(parseProjectionFact(event, parseSessionFact<SkillRecommendationRecordedFact>).payload, event.position);
      return state;
    },
  }));
}

type Recommendation = SkillRecommendationRecordedFact["payload"];

class RecommendationIndex {
  private readonly records = new Map<string, { recommendation: Recommendation; position: number }>();
  private readonly pending = new Map<string, { recommendation: Recommendation; position: number }>();
  private context: ContextContentIdentities | undefined;

  get size(): number {
    return this.records.size;
  }

  record(recommendation: Recommendation, position: number): void {
    const { recommendationId } = recommendation;
    if (this.records.has(recommendationId)) return;
    const record = { recommendation, position };
    this.records.set(recommendationId, record);
    if (!this.context?.has(recommendationId)) this.pending.set(recommendationId, record);
  }

  pendingRecommendations(): readonly Recommendation[] {
    return [...this.pending.values()].sort((left, right) => left.position - right.position).map(record => record.recommendation);
  }

  synchronize(next: ContextContentIdentities): void {
    const changes = next.changesSince(this.context);
    for (const id of changes.removed) {
      const record = this.records.get(id);
      if (record) this.pending.set(id, record);
    }
    for (const id of changes.added) this.pending.delete(id);
    this.context = next;
  }
}

interface RecommendationNotice {
  readonly recommendationId: string;
  readonly name: string;
  readonly action: string;
  readonly reach: string;
  readonly summary: string;
}

/** One recommendation as one silent runtime notification. Both delivery paths
 *  use this exact text - the live enqueue between tool calls at review settle
 *  and the durable turn-head sweep - so the identity scan dedups across them
 *  and the model reads one format. */
export function renderSkillRecommendationNotification(recommendation: RecommendationNotice): string {
  return formatRuntimeNotification({
    tag: "skill_recommendation",
    handling: "The body is a durable-learning recommendation from the background learning review. Act on it at the next natural point in your work; do not interrupt an unfinished task for it.",
    body: escapeXml(renderSkillRecommendation(recommendation)),
  });
}

/** The recommendation as the next interactive turn reads it: the identity that
 *  keys the delivery, the writer's own summary, and the exact path to a
 *  decision. Concise on purpose - it is durable model context. */
function renderSkillRecommendation(recommendation: RecommendationNotice): string {
  return [
    `The learning review recommends a ${recommendation.reach} change it may not make itself (recommendation: ${recommendation.recommendationId}).`,
    recommendation.summary,
    `Nothing was written to the ${recommendation.reach} store. To apply it, call skill_manage with action "${recommendation.action}" and name "${recommendation.name}". The interactive call applies the change without a separate permission step.`,
  ].join("\n\n");
}
