import type { SkillRecommendation } from "../../agent-runtime/review-types.js";
/** The learning review: the turn-end fork that reads the completed
 * conversation and asks "should any skill or memory be saved or updated?". This
 * module owns the policy gate, counters, prompt selection, spawn bookkeeping,
 * model routing, and the `skill.review.completed` audit trail. The session host
 * owns building the fork runner because only the host owns replay context.
 *
 *  Counter semantics: the memory counter increments
 *  once per user turn and resets when the model writes memory itself; the
 *  skill counter increments once per LLM call, accumulates across turns with
 *  no turn-start reset, and resets when the model calls skill_manage or when
 *  the skill half fires. Both replay from the persisted conversation on
 *  session resume, so long-lived resumed sessions keep their cadence. The
 *  fork's own host wires no review, so a review can never spawn a review. */

import { randomUUID } from "node:crypto";
import type { LearningScope } from "../../../infra/learning-scope.js";
import { runInTaskSlices } from "../../../infra/task-scheduling.js";
import { buildMutationEvidence, readMutationEvidenceFiles, type MutationEvidence, type MutationEvidenceEntry } from "../../../infra/mutation-evidence.js";
import { copySessionContent, type ReadSessionContentNode, type StageSessionContentNodes } from "../../../infra/session-content.js";
import { Log } from "../../../infra/log.js";
import type { RuntimeEvent } from "../../../infra/runtime-event-types.js";
import { skillReviewCompletedFact, type SkillReviewCompletedFact } from "../../../workflows/skill-facts.js";
import type { ConversationMessage } from "../../agent-runtime/llm/types.js";
import { failureTerminal, type AgentRunResult } from "../../agent-runtime/types.js";
import { LEARNING_REVIEW_ROLE_ID, requireRole, type ResolvedRole, type ResolvedRoles } from "../../config/roles.js";
import { withCapabilityGrant, type CapabilityAccess } from "../../agent-runtime/tools/types.js";
import type { SessionFactWriter } from "../../session/session-fact-writer.js";

import { COMBINED_REVIEW_PROMPT, MEMORY_REVIEW_PROMPT, REVIEW_TOOL_RESTRICTION, SKILL_REVIEW_PROMPT } from "./learning-review-prompts.js";
import type { ModuleId, FirstPartyModuleComposition, FirstPartyModuleSnapshot } from "../../modules.js";
import { moduleRequirementsForContribution, hasModuleContribution } from "../../module-requirements.js";

import { canonicalModuleIds } from "../../../protocol/module-ids.js";
const log = Log.create({ service: "learning-review" });

/** The fork budget: the prompts direct multi-step sequences and
 *  the read-before-write guard adds a load per mutated skill, so half of this
 *  starves a review that patches two skills and writes memory. */
const REVIEW_MAX_LLM_CALLS = 16;

type ReviewHalf = "memory" | "skill";
interface ReviewHalfRequirements {
  readonly memory: readonly ModuleId[];
  readonly skill: readonly ModuleId[];
}

/** What each half of a review needs to hold to do its work: the memory half
 *  writes durable memory, the skill half writes managed skill packages. A
 *  review admits the union of the halves it fires in one request, so a write of
 *  an admitted half is never refused mid-run by a disable that landed after the
 *  review started. */
type SkillNotificationLevel = "off" | "on" | "verbose";

export interface LearningReviewConfig {
  /** Memory review fires every N user turns; 0 disables the half. */
  memoryIntervalTurns: number;
  /** Skill review fires at N accumulated LLM calls; 0 disables the half. */
  skillIntervalIterations: number;
  notifications: SkillNotificationLevel;
}

/** One landed write reported by the fork's tools. */
interface ReviewActionReport {
  surface: ReviewHalf;
  name: string;
  action: string;
  reach: LearningScope;
  /** Bounded display evidence staged by the write tool. */
  mutationEvidence?: MutationEvidence;
}

/** One review notification: the grouped summary a reader is shown, plus the
 *  individual skill writes that summary reports. */
export interface ReviewNotice {
  content: string;
  mutationEvidence?: MutationEvidence;
}

export interface ReviewRunSpec {
  reviewRunId: string;
  /** The selected review prompt with the tool-restriction suffix. */
  instruction: string;
  maxLLMCalls: number;
  /** This review's own scoped capability boundary (ARCH-RUNTIME-068): the grant it was
   *  admitted with, which fixes whether memory and managed-skill writes are
   *  available for the whole run. A disable that lands afterwards blocks the
   *  next review instead of refusing this one's advertised tools. */
  capabilityAccess: CapabilityAccess;
  /** Module snapshot admitted with this review. */
  moduleSelection: FirstPartyModuleComposition;
  learningReview: {
    reviewRunId: string;
    onWritten: (action: ReviewActionReport) => void;
    onRecommended: (recommendation: SkillRecommendation) => void;
  };
}

/** The fork's cumulative run totals, read after `done` settles from the last
 *  provider usage report the host observed on the fork's event stream. */
interface ReviewUsage {
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
}

export interface SpawnedReview {
  /** Settles with how the fork's run ended. A run that ends aborted or in a provider error resolves rather than
   *  rejects, so the review reads its terminal to tell a finished review from one that stopped. */
  done: Promise<AgentRunResult>;
  model: string;
  /** Absent (or returning undefined) when no usage report landed. */
  usage?: () => ReviewUsage | undefined;
  /** Persist one system transcript message in the reviewed conversation. */
  recordSystemMessage: (notice: ReviewNotice) => Promise<void>;
  /** The content store of the session `recordSystemMessage` writes to, when
   *  that is not the review's own session: a workflow review reads the
   *  workflow's content, and its notice lands in the agent's session. The
   *  notice's evidence closure is copied there, because a writer proves a
   *  fact's evidence only from its own session's content. */
  stageNoticeContent?: StageSessionContentNodes;
  /** Deliver one recorded recommendation to the live agent as a silent
   *  runtime notification (drained between tool calls). Optional, and a host
   *  with no active turn drops it: the turn-head reconciliation sweep is the
   *  durable delivery path and dedups by recommendation identity. */
  notifyRecommendation?: (recommendation: SkillRecommendation) => void;
}

type ReviewBudgetEvent =
  | Extract<RuntimeEvent, { type: "model.usage.measured" }>
  | Extract<RuntimeEvent, { type: "budget.stream.completed" }>;

export interface ReviewUsageAccounting {
  observe(event: RuntimeEvent): void;
  finish(): void;
  usage(): ReviewUsage | undefined;
}

/** Attribute each committed review usage delta to one independent session
 * budget stream. `finish` retires the stream after success, failure, or abort. */
export function createReviewUsageAccounting(
  reviewRunId: string,
  publish: (event: ReviewBudgetEvent) => void,
): ReviewUsageAccounting {
  const budgetStreamId = `learning-review:${reviewRunId}`;
  let latest: ReviewUsage | undefined;
  let finished = false;
  return {
    observe(event) {
      if (event.type !== "model.usage.measured") return;
      const entry = event.data.usage_entry;
      // Reported usage only: an unmeasured attempt and an unreported cache detail add nothing.
      if (entry.coverage !== "unmeasured") {
        latest ??= { costUsd: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 };
        latest = {
          costUsd: latest.costUsd + (entry.price.kind === "priced" ? entry.price.estimatedUsd : 0),
          inputTokens: latest.inputTokens + entry.tokens.input,
          outputTokens: latest.outputTokens + entry.tokens.output,
          cacheReadTokens: latest.cacheReadTokens + (entry.tokens.cacheRead ?? 0),
        };
      }
      publish({ ...event, data: { ...event.data, budget_stream_id: budgetStreamId } });
    },
    finish() {
      if (finished) return;
      finished = true;
      publish({ type: "budget.stream.completed", data: { budget_stream_id: budgetStreamId } });
    },
    usage: () => latest,
  };
}

export interface LearningReviewDeps {
  sessionId: string;
  config: LearningReviewConfig;
  sessionEventWriter?: SessionFactWriter;
  /** Reads content in the same session that owns the review's tool results. */
  readContentNode?: ReadSessionContentNode;
  /** Capability boundary of the host (ARCH-RUNTIME-068). Learning is what makes a review
   *  legal, so the counters advance only while it is held and every review
   *  admits its own grant before any model call. */
  capabilities: CapabilityAccess;
  moduleSelection: FirstPartyModuleSnapshot;
  /** Build and start the fork with the resolved Learning Review role and the
   * spec's review fields. Returns undefined when the host cannot spawn now; the
   * counters stay hot and the next turn retries. */
  spawnReview: (spec: ReviewRunSpec) => Promise<SpawnedReview | undefined>;
}



export interface LearningReview {
  /** One real user turn entered the conversation. */
  noteUserTurn(): void;
  /** One assistant message landed: an LLM call. Resets ride its tool_use blocks. */
  noteAssistantMessage(content: string | ReadonlyArray<{ type: string; name?: string }>): void;
  /** Derive counter state from a resumed session's persisted conversation. */
  replay(messages: ReadonlyArray<ConversationMessage>): Promise<void>;
  /** The turn delivered a final response and was not interrupted: fire when due under its captured request policy. */
  onTurnCompleted(config?: LearningReviewConfig): void;
  /** Manual combined review, immediately (the /learn command). */
  learn(): void;
  /** Settle of the in-flight review, for ordered disposal. */
  settled(): Promise<void>;
}

const UPDATED_SKILL_ACTIONS = new Set(["updated", "patched", "support_file", "file_removed"]);

function skillChangeMessage(actions: readonly ReviewActionReport[]): string | null {
  const changes = new Map<string, "created" | "updated">();
  for (const action of actions) {
    if (action.surface !== "skill") continue;
    if (action.action === "created") {
      changes.set(action.name, "created");
    } else if (UPDATED_SKILL_ACTIONS.has(action.action) && changes.get(action.name) !== "created") {
      changes.set(action.name, "updated");
    }
  }
  const clauses = (["created", "updated"] as const).flatMap((change) => {
    const names = [...changes].filter(([, value]) => value === change).map(([name]) => `\`${name}\``);
    if (names.length === 0) return [];
    const verb = change === "created" ? "Created" : "Updated";
    return [`${verb} skill${names.length === 1 ? "" : "s"}: ${names.join(", ")}.`];
  });
  return clauses.length === 0 ? null : clauses.join(" ");
}

function countPhrase(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** What the review tells the chat when it settles. An automatic review speaks
 *  only about the skills it changed, and only while notifications are on. A
 *  review the person asked for always answers, because the person waits for
 *  it and has no other place to see its result. */
function reviewNoticeText(
  trigger: SkillReviewCompletedFact["payload"]["trigger"],
  outcome: SkillReviewCompletedFact["payload"]["outcome"],
  report: { readonly actions: readonly ReviewActionReport[]; readonly recommendations: readonly SkillRecommendation[] },
  notifications: SkillNotificationLevel,
): string | null {
  const skills = outcome === "acted" ? skillChangeMessage(report.actions) : null;
  if (trigger !== "manual") return notifications === "off" ? null : skills;
  if (outcome === "failed") return "The learning review could not finish. Run /learn to try again.";
  if (outcome === "nothing_to_save") return "The learning review found nothing to save from this chat.";
  const memories = report.actions.filter((action) => action.surface === "memory").length;
  const clauses = [
    ...(skills === null ? [] : [skills]),
    ...(memories === 0 ? [] : [`Saved ${countPhrase(memories, "memory entry", "memory entries")}.`]),
    ...(report.recommendations.length === 0 ? [] : [`Recommended ${countPhrase(report.recommendations.length, "skill change", "skill changes")}.`]),
  ];
  return `The learning review finished. ${clauses.join(" ")}`;
}

/** Every skill write under one notice, in the order the fork made them. The
 *  notice text collapses repeated writes into one clause per skill; the
 *  evidence keeps each write and its artifact. Memory writes are never
 *  notified, so they are never evidence for a notice. */
async function noticeEvidence(actions: readonly ReviewActionReport[], deps: LearningReviewDeps, destination: StageSessionContentNodes | undefined): Promise<MutationEvidence | undefined> {
  const skills = actions.flatMap(action => action.surface === "skill" && action.mutationEvidence ? [{ action, evidence: action.mutationEvidence }] : []);
  if (skills.length === 0) return undefined;
  const writer = deps.sessionEventWriter;
  const stage = destination ?? writer?.stageSessionContentNodes?.bind(writer);
  const read = deps.readContentNode;
  if (!stage || !read) throw new Error("Session content storage is unavailable");
  const copied = new Set<string>();
  const entries: MutationEvidenceEntry[] = [];
  for (const { action, evidence } of skills) {
    let offset: number | null = 0;
    do {
      const page = await readMutationEvidenceFiles(evidence, offset, 64, read);
      if (page.kind === "unavailable") throw new Error("Change evidence is unavailable");
      if (destination) {
        for (const entry of page.files) {
          if ((entry.kind !== "applied" && entry.kind !== "display") || entry.file.patch.kind !== "retained") continue;
          const reference = entry.file.patch.reference;
          if (copied.has(reference.root)) continue;
          copied.add(reference.root);
          await copySessionContent(reference, read, destination);
        }
      }
      entries.push(...page.files.map((entry): MutationEvidenceEntry => {
        if (entry.kind === "applied") return { ...entry, file: { ...entry.file, name: action.name, action: action.action, reach: action.reach } };
        if (entry.kind === "display") return { ...entry, file: { ...entry.file, name: action.name, action: action.action, reach: action.reach } };
        return entry.kind === "omitted" ? { ...entry, name: action.name, action: action.action, reach: action.reach } : entry;
      }));
      offset = page.nextOffset;
    } while (offset !== null);
  }
  return buildMutationEvidence(entries, stage);
}

export function createLearningReview(deps: LearningReviewDeps): LearningReview {
  const halfRequirements: ReviewHalfRequirements = {
    memory: moduleRequirementsForContribution("tools", "memory"),
    skill: moduleRequirementsForContribution("tools", "skill_manage"),
  };

  const userTurns = createCadenceCounter();
  const skillIterations = createCadenceCounter();
  let inFlight: Promise<void> | undefined;

  const learningHeld = (): boolean => hasModuleContribution(deps.moduleSelection(), "memory");

  const fire = (trigger: SkillReviewCompletedFact["payload"]["trigger"], requested: ReviewHalf[], config: LearningReviewConfig): void => {
    // A half whose capabilities the selection no longer holds is not fired, so
    // one absent capability never starves the other half.
    const halves = requested.filter((half) => halfRequirements[half].every((capability) => deps.capabilities.available(capability)));
    if (halves.length === 0 || inFlight) return;
    const reviewRunId = randomUUID();
    const prompt = halves.length === 2 ? COMBINED_REVIEW_PROMPT : halves[0] === "memory" ? MEMORY_REVIEW_PROMPT : SKILL_REVIEW_PROMPT;
    const actions: ReviewActionReport[] = [];
    const recommendations: SkillRecommendation[] = [];
    const startedAt = Date.now();

    // Fired counters reset now: a review that fails does not retry on the
    // very next turn; the cadence restarts.
    if (halves.includes("memory")) userTurns.reset();
    if (halves.includes("skill")) skillIterations.reset();

    inFlight = (async () => {
      // A review is new optional work, so it admits for itself rather than
      // riding the host's grant, and carries the grant it admitted with for its
      // whole run.
      const required = canonicalModuleIds(halves.flatMap((half) => halfRequirements[half]));
      const admission = await deps.capabilities.admit({ operation: "the learning review", required });
      if (!admission.ok) {
        log.info("learning review refused", { sessionId: deps.sessionId, reviewRunId, reason: admission.reason });
        return;
      }
      const spec: ReviewRunSpec = {
        reviewRunId,
        instruction: `${prompt}\n\n${REVIEW_TOOL_RESTRICTION}`,
        maxLLMCalls: REVIEW_MAX_LLM_CALLS,
        capabilityAccess: withCapabilityGrant(deps.capabilities, admission.grant),
        moduleSelection: deps.moduleSelection(),
        learningReview: {
          reviewRunId,
          onWritten: (action) => { actions.push(action); },
          onRecommended: (recommendation) => { recommendations.push(recommendation); },
        },
      };
      // The review is a best-effort background side effect: no failure in
      // here may escape as an unhandled rejection, because the host runtime
      // treats those as fatal and tears shared resources down.
      let spawned: SpawnedReview | undefined;
      let outcome: SkillReviewCompletedFact["payload"]["outcome"] = "failed";
      try {
        spawned = await deps.spawnReview(spec);
      } catch (err) {
        log.warn("learning review spawn failed", { sessionId: deps.sessionId, reviewRunId, err: String(err) });
      }
      if (!spawned) return;
      log.debug("learning review started", { sessionId: deps.sessionId, reviewRunId, trigger, halves });
      // An aborted run is its owner ending it: the session or workflow host
      // closed, a workflow finished, or the runtime stopped. That is an
      // expected end, not a failure. The durable outcome has no aborted
      // member and older builds read it, so the fact still records "failed".
      let aborted = false;
      try {
        const { terminal } = await spawned.done;
        const failure = failureTerminal(terminal);
        aborted = failure?.kind === "aborted";
        if (failure && !aborted) log.warn("learning review failed", { sessionId: deps.sessionId, reviewRunId, terminal: failure.kind });
        else if (!failure) outcome = actions.length > 0 || recommendations.length > 0 ? "acted" : "nothing_to_save";
      } catch (err) {
        log.warn("learning review failed", { sessionId: deps.sessionId, reviewRunId, err: String(err) });
      }
      // The one record of a review, when it settles.
      log.info("learning review settled", {
        sessionId: deps.sessionId, reviewRunId, trigger, halves, outcome: aborted ? "aborted" : outcome, durationMs: Date.now() - startedAt,
        actions: actions.length, recommendations: recommendations.length,
      });
      const usage = spawned.usage?.();
      await deps.sessionEventWriter?.record(skillReviewCompletedFact({
        reviewRunId,
        sessionId: deps.sessionId,
        trigger,
        halves,
        model: spawned.model,
        // Identity only: the fact schema rejects excess keys.
        actions: actions.map(({ surface, name, action, reach }) => ({ surface, name, action, reach })),
        recommendations: recommendations.map(({ recommendationId, name, action, reach }) => ({ recommendationId, name, action, reach })),
        durationMs: Date.now() - startedAt,
        outcome,
        ...(usage ? {
          costUsd: usage.costUsd,
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          cacheReadTokens: usage.cacheReadTokens,
        } : {}),
      }));
      // Live half of delivery: reconciliation.ts owns the durable sweep and
      // dedups by the identity this notification carries.
      for (const recommendation of recommendations) spawned.notifyRecommendation?.(recommendation);
      const message = reviewNoticeText(trigger, outcome, { actions, recommendations }, config.notifications);
      if (message) {
        const mutationEvidence = await noticeEvidence(actions, deps, spawned.stageNoticeContent);
        await spawned.recordSystemMessage({ content: message, ...(mutationEvidence ? { mutationEvidence } : {}) });
      }
    })().catch((err) => {
      log.warn("learning review bookkeeping failed", { sessionId: deps.sessionId, reviewRunId, err: String(err) });
    }).finally(() => { inFlight = undefined; });
  };

  return {
    noteUserTurn() {
      if (!learningHeld()) return;
      userTurns.note();
    },
    noteAssistantMessage(content) {
      if (!learningHeld()) return;
      skillIterations.note();
      if (typeof content === "string") return;
      for (const block of content) {
        if (block.type !== "tool_use") continue;
        if (block.name === "skill_manage") skillIterations.reset();
        if (block.name === "memory") userTurns.reset();
      }
    },
    async replay(messages) {
      if (!learningHeld()) {
        userTurns.reset();
        skillIterations.reset();
        return;
      }
      const memoryInterval = deps.config.memoryIntervalTurns;
      const skillInterval = deps.config.skillIntervalIterations;
      // The derivation yields to the task queue, and the live session can note
      // turns meanwhile. Those notes are newer than the replayed messages, so
      // they merge onto the replayed position instead of being overwritten.
      const userTurnsMark = userTurns.mark();
      const skillIterationsMark = skillIterations.mark();
      const counted = await runInTaskSlices("learning-review:counters", deriveCounters(messages));
      userTurns.rebase(userTurnsMark, memoryInterval > 0 ? counted.userTurnsSinceMemoryWrite % memoryInterval : 0);
      skillIterations.rebase(skillIterationsMark, skillInterval > 0 ? counted.assistantSinceSkillManage % skillInterval : 0);
    },
    onTurnCompleted(config = deps.config) {
      const halves: ReviewHalf[] = [];
      if (config.memoryIntervalTurns > 0 && userTurns.count() >= config.memoryIntervalTurns) halves.push("memory");
      if (config.skillIntervalIterations > 0 && skillIterations.count() >= config.skillIntervalIterations) halves.push("skill");
      fire(halves.length === 1 && halves[0] === "memory" ? "turns" : "iterations", halves, config);
    },
    learn() {
      fire("manual", ["memory", "skill"], deps.config);
    },
    settled() {
      return inFlight ?? Promise.resolve();
    },
  };
}



/** A different model cannot reuse the completed parent's provider conversation.
 * The host replays a compact digest instead of the full warm-cache history. */
export function resolveReviewRoute(roles: ResolvedRoles, parent: ResolvedRole) {
  const role = requireRole(roles, LEARNING_REVIEW_ROLE_ID);
  return { role, routed: role.model !== parent.model };
}

/** The history a review replays: the parent's full conversation on the
 * parent's model, so the provider cache stays warm, and the digest on a routed
 * model, which cannot reuse that cache. */
export async function reviewReplay(route: { readonly routed: boolean }, messages: ReadonlyArray<ConversationMessage>): Promise<ReadonlyArray<ConversationMessage>> {
  return route.routed ? digestConversation(messages) : messages;
}

const DIGEST_TAIL = 24;
const DIGEST_USER_CHARS = 300;
const DIGEST_ASSISTANT_CHARS = 200;

/** Compact replay for the routed (different-model) review path. Keeps the recent
 *  `DIGEST_TAIL` messages verbatim, extending the tail past leading tool
 *  results so the replay never opens mid-tool-exchange, and collapses older
 *  turns into one synthetic user message of truncated user texts, truncated
 *  assistant texts, and assistant tool names. Tool arguments and old tool
 *  results never enter the digest. Never used on the unrouted path, where the
 *  full replay stays warm in the parent's cache. */
export function digestConversation(messages: ReadonlyArray<ConversationMessage>): Promise<ConversationMessage[]> {
  return runInTaskSlices("learning-review:digest", digestConversationWork(messages));
}

function* digestConversationWork(messages: ReadonlyArray<ConversationMessage>): Generator<void, ConversationMessage[]> {
  let tail = DIGEST_TAIL;
  if (messages.length <= tail) return [...messages];
  let keep = messages.slice(-tail);
  while (keep[0]?.kind === "toolResult") {
    tail += 1;
    if (messages.length <= tail) return [...messages];
    keep = messages.slice(-tail);
  }
  const lines: string[] = [];
  for (const message of messages.slice(0, -keep.length)) {
    yield;
    if (message.kind === "user") {
      const text = messageText(message.content);
      if (text) lines.push(`USER: ${text.slice(0, DIGEST_USER_CHARS)}`);
      continue;
    }
    if (message.kind !== "assistant") continue;
    const toolNames = typeof message.content === "string"
      ? []
      : message.content.filter((block) => block.type === "tool_use").map((block) => block.name);
    if (toolNames.length > 0) lines.push(`ASSISTANT[tools: ${toolNames.join(", ")}]`);
    const text = messageText(message.content);
    if (text) lines.push(`ASSISTANT: ${text.slice(0, DIGEST_ASSISTANT_CHARS)}`);
  }
  const digest: ConversationMessage = {
    kind: "user",
    origin: "system",
    content: "[Earlier conversation digest: older turns are summarised to bound the review's cold-write cost on the routed aux model. Recent turns follow verbatim below.]\n"
      + lines.join("\n"),
  };
  return [digest, ...keep];
}

/** Digest-line text: block texts joined and flattened to one line. */
function messageText(content: string | ReadonlyArray<{ type: string; text?: string }>): string {
  const text = typeof content === "string"
    ? content
    : content.map((block) => (block.type === "text" ? block.text ?? "" : "")).filter(Boolean).join(" ");
  return text.replaceAll("\n", " ").trim();
}

/** A position of a cadence counter, taken before a replay derives a new base. */
interface CadenceMark {
  readonly count: number;
  readonly resets: number;
}

/** One review cadence: the count of events since the last reset. The reset
 *  number lets a replay tell which live notes are newer than its base. */
function createCadenceCounter() {
  let count = 0;
  let resets = 0;
  return {
    count: () => count,
    note: () => { count += 1; },
    reset: () => { count = 0; resets += 1; },
    mark: (): CadenceMark => ({ count, resets }),
    /** Replace everything before `mark` with `base`. A reset after the mark
     *  already starts the count after the replayed messages, so it stays.
     *  Otherwise the notes since the mark add to `base`. */
    rebase: (mark: CadenceMark, base: number) => {
      if (resets === mark.resets) count = base + count - mark.count;
    },
  };
}

/** Counter positions implied by a persisted conversation: user turns since
 *  the model last wrote memory, and assistant messages (LLM calls) since it
 *  last called skill_manage. */
function* deriveCounters(messages: ReadonlyArray<ConversationMessage>): Generator<void, { userTurnsSinceMemoryWrite: number; assistantSinceSkillManage: number }> {
  let userTurnsSinceMemoryWrite = 0;
  let assistantSinceSkillManage = 0;
  for (const message of messages) {
    yield;
    if (message.kind === "user" && message.origin === undefined) {
      userTurnsSinceMemoryWrite += 1;
      continue;
    }
    if (message.kind !== "assistant") continue;
    assistantSinceSkillManage += 1;
    if (typeof message.content === "string") continue;
    for (const block of message.content) {
      if (block.type !== "tool_use") continue;
      if (block.name === "skill_manage") assistantSinceSkillManage = 0;
      if (block.name === "memory") userTurnsSinceMemoryWrite = 0;
    }
  }
  return { userTurnsSinceMemoryWrite, assistantSinceSkillManage };
}
