import type { SkillRecommendation, SkillSemanticAuditResult } from "../../../agent-runtime/review-types.js";
/** The `skill_manage` write tool: the write surface of the managed skill
 *  library. A separate sibling of the read-only `skill` loader, so external
 *  packages stay untrusted read-only artifacts while managed packages have
 *  exactly one write path whoever the author is (the user's "save that as a
 *  skill", the agent mid-task, or the learning review). */

import type { LearningScope } from "../../../../infra/learning-scope.js";
import type { MutationEvidence } from "../../../../infra/mutation-evidence.js";
import { buildMutationDiffEvidence } from "../../../../infra/mutation-diff-evidence.js";
import { Log } from "../../../../infra/log.js";
import type { ToolResultAction } from "../../../../infra/tool-result-action.js";
import { normalizeSkillId } from "../../../../infra/skill-id.js";
import { errorMessage } from "../../../../infra/error-message.js";
import type { DefinitionReload } from "../../../../workflows/definition-registry.js";
import { NEW_SKILL_TRIGGER_MAX_CHARS, type SkillRegistryRevision } from "../../../../workflows/skill-schema.js";
import { skillRecommendationRecordedFact } from "../../../../workflows/skill-facts.js";
import type { AsyncEventStateReadSurface } from "../../../../infra/event-store-types.js";
import { discardPendingAudit, reconcilePendingAudits, settlePendingAudit, type PendingAudit } from "../learning-journal.js";
import { readConsentClaims, reconcileGlobalSkillOperations } from "../global-skill-mutation.js";
import type { SessionFactWriter } from "../../../session/session-fact-writer.js";
import { admitSkillMutationPlan, planSkillMutation, storeRootDirs } from "../skill-mutation-plan.js";
import { publishSkillMutation } from "../skill-mutation-publisher.js";
import { refuseBackgroundGlobalWrite, refuseUncontainedSkillStores } from "../skill-store.js";
import type { SkillMutation, SkillStoreConfig, SkillStoreResult, SkillWriteOrigin,  } from "../skill-store-types.js";

import type { RuntimeTool, RuntimeToolInput, ToolContext, ToolResult } from "../../../agent-runtime/tools/types.js";

const log = Log.create({ service: "skill-manage" });

const DESCRIPTION = `Create, update, and maintain managed skills: durable, user-visible packages of "how to do this class of task" instructions that future sessions load on demand through the skill tool.

Actions:
- save: create a skill (name, description, body, optional reach project|global) or fully rewrite an existing one. With path and content, writes one support file (references/*, templates/*, scripts/*, assets/*) instead.
- patch: targeted old_string/new_string replacement in SKILL.md (or path). PREFERRED for fixes; save's full rewrite is for major overhauls only.
- remove_file: delete one support file.
- archive: move a skill to the recoverable archive (restore reverses it).
- restore: bring an archived skill back.
- promote: move a project skill into the global store, keeping its id.
- recommend: background review only. Record a promotion the user should decide later, without writing anything global.

Write skills at the class level ("how to review database migrations"), never as one session's story. The description is the routing surface every future session sees; make it say when to load the skill. Prefer patching an existing skill over creating a near-duplicate. Skills the user hand-wrote (managed: user) and bundled packages refuse autonomous writes.

A project skill applies to this workspace. A global (reach: global) skill follows the user into every project. Interactive global changes apply in this call without a separate permission step.

Promotion moves the project package itself, so nothing is left behind in the project. One id names one package: promotion refuses an id the global store or a shared store already holds, and a distinct project specialization uses a distinct id.`;

const INPUT_SCHEMA = {
  type: "object",
  properties: {
    action: {
      type: "string",
      enum: ["save", "patch", "remove_file", "archive", "restore", "promote", "recommend"],
      description: "The management action.",
    },
    name: { type: "string", description: "Skill package name: a lowercase, class-level slug." },
    description: { type: "string", description: `Trigger description for save: one line saying when to load this skill. A NEW skill's description must fit ${NEW_SKILL_TRIGGER_MAX_CHARS} chars, because every agent's prompt catalog carries it.` },
    body: { type: "string", description: "Full SKILL.md body markdown for save (frontmatter is composed by the store)." },
    dependencies: { type: "array", items: { type: "string" }, description: "Ordered skill ids whose canonical context must be composed before this skill. A specialization names its canonical bundled skill first." },
    path: { type: "string", description: "Package-relative support-file path (references/*, templates/*, scripts/*, assets/*). For save/remove_file, and optionally patch." },
    content: { type: "string", description: "Support-file content for save with path." },
    old_string: { type: "string", description: "Exact text to replace for patch; must match exactly once." },
    new_string: { type: "string", description: "Replacement text for patch." },
    reach: { type: "string", enum: ["project", "global"], description: "Reach of a NEW skill: project (this workspace only) or global (every workspace). Defaults to project." },
    absorbed_into: { type: "string", description: "For archive from a review: the existing skill that absorbed this one's content." },
  },
  required: ["action", "name"],
} as const;

export interface SkillManageToolDeps {
  /** Who is writing; decides eligibility (managed: user refuses the review). */
  origin: SkillWriteOrigin;
  /** Live registry accessor; writes resolve against the published revision. */
  registry: () => SkillRegistryRevision;
  /** Publishes a landed write to this project's catalog before the call
   *  returns. Absent where no composition observes the skill roots. */
  publishDefinitions?: () => Promise<DefinitionReload | undefined>;
  /** Audits the exact writer-prepared package against the pinned revision. */
  onCandidate?: (candidate: import("../../../agent-runtime/review-types.js").PreparedPackage, revision: SkillRegistryRevision) => Promise<SkillSemanticAuditResult>;
  /** Reports each landed write with its bounded display evidence. */
  onWritten?: (action: { name: string; action: string; reach: LearningScope; mutationEvidence?: MutationEvidence }) => void;
  /** Reports each recorded recommendation; the review delivers it to the
   *  parent conversation, where an interactive turn can decide it. */
  onRecommended?: (recommendation: SkillRecommendation) => void;
  /** Read side of the workspace event store for historical recovery and journal replay. */
  store?: AsyncEventStateReadSurface;
  /** Session identity used by definition override approval. */
  sessionId?: string;
  /** Startup-selected account data root (ARCH-DIRECTORIES-001) that owns the user skill store. */
  userDataRoot: string;
}

export function createSkillManageTool(deps: SkillManageToolDeps): RuntimeTool {
  return {
    name: "skill_manage",
    action: "ui_meta",
    description: DESCRIPTION,
    promptSnippet: "Create, update, patch, archive, or restore a managed skill package",
    inputSchema: INPUT_SCHEMA,
    isConcurrencySafe: false,
    execute: async (input, context) => {
      const config: SkillStoreConfig = {
        // The project skill store belongs to the project, never to the
        // directory this call happens to execute in.
        projectRoot: context.projectRoot,
        userDataRoot: deps.userDataRoot,
        registry: deps.registry,
      };
      // One boundary normalizes and validates the package id, so the row a user
      // reads names exactly the package this call mutates.
      const name = normalizeSkillId(input.name);
      if (!name) return { content: "name is required as a lowercase, class-level slug of letters, digits, and hyphens, optionally qualified with dot-delimited family segments.", outcome: "error" };

      if (input.action === "recommend") return recommendPromotion(config, deps, name, context);

      const mutation = toMutation(name, input);
      if ("error" in mutation) return { content: mutation.error, outcome: "error" };
      const dispatched = await dispatch(config, deps, mutation.mutation, context);
      return render(dispatched, context, deps);
    },
  };
}

interface DispatchOutcome {
  readonly result: SkillStoreResult;
  /** Journalled audit evidence of the write this dispatch is about to publish,
   *  written before the bytes so a crash after them loses no fact. */
  readonly pending?: PendingAudit;
}

/** Route one planned mutation to its publication owner. */
async function dispatch(
  config: SkillStoreConfig,
  deps: SkillManageToolDeps,
  mutation: SkillMutation,
  context: ToolContext,
): Promise<DispatchOutcome> {
  const uncontainedStore = refuseUncontainedSkillStores(config);
  if (uncontainedStore) return { result: { kind: "refused", error: uncontainedStore } };
  const roots = storeRootDirs(config);
  const writer = context.sessionEventWriter;
  // An operation interrupted by another project hides or publishes a package
  // under this same id, so the plan is resolved against a settled store.
  // Historical consent-bound operations still need their origin's claim reader;
  // only the origin workspace records the audit evidence it owes.
  reconcileGlobalSkillOperations(roots.user, deps.store ? await readConsentClaims(deps.store, context.projectRoot, [roots.user]) : undefined);
  const auditReader = context.projectionReader ?? deps.store;
  if (writer && auditReader) {
    for (const dir of [roots.project, roots.user]) {
      await reconcilePendingAudits({ storeDir: dir, workspace: context.projectRoot, writer, reader: auditReader });
    }
  }
  const revision = config.registry();
  const planned = planSkillMutation(config, deps.origin, mutation);
  if (planned.kind === "refused") return { result: { kind: "refused", error: planned.error } };
  let plan = planned.plan;
  if (deps.origin.kind === "review" && plan.reach === "global") {
    return { result: { kind: "refused", error: refuseBackgroundGlobalWrite("review", plan.name) } };
  }
  if (plan.semanticAudit?.kind === "required") {
    const audit = deps.onCandidate ? await deps.onCandidate(plan.outcome.package, revision) : { kind: "uncertain" as const, reason: "this run has no semantic auditor to call" };
    const admitted = admitSkillMutationPlan(plan, revision, audit);
    if (admitted.kind === "refused") return { result: { kind: "refused", error: admitted.error } };
    plan = admitted.plan;
  }
  const publication = await publishSkillMutation({
    config,
    origin: deps.origin,
    plan,
    writer,
    currentRevision: config.registry,
    ...(writer && context.toolUseId && context.sessionId ? { global: { sessionId: context.sessionId, toolUseId: context.toolUseId, store: deps.store, projectionReader: context.projectionReader, writer } } : {}),
  });
  if (publication.kind === "refused" || publication.kind === "stale") return { result: { kind: "refused", error: publication.error } };
  return publication.kind === "published_unsettled"
    ? { result: publication.result, pending: publication.pending }
    : { result: publication.result };
}

/** Record one project-to-global promotion the user should decide later.
 *
 *  The background review cannot ask and cannot write globally, so this path
 *  plans the promotion, which reads bytes and writes none, and records its
 *  store-prepared identity as a fact. The global store is not touched, not
 *  even its operation area. A later interactive call publishes the same
 *  content-bound plan without a separate permission step. */
async function recommendPromotion(
  config: SkillStoreConfig,
  deps: SkillManageToolDeps,
  name: string,
  context: ToolContext,
): Promise<ToolResult> {
  if (deps.origin.kind !== "review") {
    return {
      content: `Only the background review records recommendations. Call skill_manage with action "promote" and name "${name}" to apply the promotion now.`,
      outcome: "error",
    };
  }
  const planned = planSkillMutation(config, deps.origin, { kind: "promote", name });
  if (planned.kind === "refused") return { content: planned.error, outcome: "error" };
  const plan = planned.plan;
  const writer = context.sessionEventWriter;
  if (!writer) {
    return { content: "This session cannot record a recommendation: it has no durable event store.", outcome: "error" };
  }

  const recommendation: SkillRecommendation = {
    recommendationId: plan.proposalId,
    name: plan.name,
    action: "promote",
    reach: plan.reach,
    packageIdentity: plan.outcome.package.identity,
    summary: plan.summary,
  };
  try {
    const stored = await writer.record(skillRecommendationRecordedFact({
      ...recommendation,
      origin: { kind: "review", reviewRunId: deps.origin.reviewRunId },
    }));
    // A writer that resolves null wrote nothing, so the recommendation exists
    // nowhere a later turn could read it.
    if (!stored) throw new Error("the session stopped recording");
  } catch (err) {
    log.warn("skill.recommendation.recorded fact failed", { name, err: String(err) });
    return { content: "The recommendation could not be recorded, so nobody would see it. Say it in your reply instead.", outcome: "error" };
  }
  deps.onRecommended?.(recommendation);
  return {
    content: [
      `Recommendation recorded (recommendation: ${recommendation.recommendationId}). Nothing was written to the global store.`,
      plan.summary,
      "The user decides this in a later interactive turn. Do not repeat the call.",
    ].join("\n\n"),
    outcome: "ok",
    details: skillResultDetails("recommended"),
  };
}

function toMutation(name: string, input: RuntimeToolInput): { mutation: SkillMutation } | { error: string } {
  // Absent stays absent: a field the model did not send is never manufactured
  // into a value, so the planner owns every default and every empty-field
  // refusal message.
  const text = (key: string): string | undefined => {
    const value = input[key];
    return typeof value === "string" ? value : undefined;
  };
  const reach: LearningScope | undefined = input.reach === "project" || input.reach === "global" ? input.reach : undefined;
  // Strict providers fill an omitted optional field with null; treat it as
  // absent, and refuse anything else so a typo never silently writes to the
  // project store.
  if (reach === undefined && input.reach !== undefined && input.reach !== null) {
    return { error: `Invalid reach ${JSON.stringify(input.reach)}. Use 'project' or 'global'.` };
  }
  const chosenReach = reach === undefined ? {} : { reach };

  switch (input.action) {
    case "save": {
      const path = text("path");
      if (path !== undefined) {
        const content = text("content");
        if (content === undefined) return { error: `content is required to write support file ${JSON.stringify(path)}.` };
        return { mutation: { kind: "support_file", name, path, content } };
      }
      const dependencies = input.dependencies;
      if (dependencies !== undefined && (!Array.isArray(dependencies) || dependencies.some((dependency) => typeof dependency !== "string"))) {
        return { error: "dependencies must be an array of skill ids." };
      }
      return { mutation: { kind: "save", name, description: text("description") ?? "", body: text("body") ?? "", ...(dependencies === undefined ? {} : { dependencies }), ...chosenReach } };
    }
    case "patch": {
      const path = text("path");
      return {
        mutation: {
          kind: "patch",
          name,
          ...(path === undefined ? {} : { path }),
          oldString: text("old_string") ?? "",
          newString: text("new_string") ?? "",
        },
      };
    }
    case "remove_file": {
      const path = text("path");
      if (path === undefined) return { error: "path is required for remove_file: name the declared support file to delete." };
      return { mutation: { kind: "remove_file", name, path } };
    }
    case "archive": {
      const absorbedInto = text("absorbed_into");
      return { mutation: { kind: "archive", name, ...(absorbedInto ? { absorbedInto } : {}) } };
    }
    case "restore":
      return { mutation: { kind: "restore", name, ...chosenReach } };
    case "promote":
      return { mutation: { kind: "promote", name } };
    default:
      return { error: `Unknown action ${JSON.stringify(input.action)}. Use save, patch, remove_file, archive, restore, or promote.` };
  }
}


async function render(dispatched: DispatchOutcome, context: ToolContext, deps: SkillManageToolDeps): Promise<ToolResult> {
  const result = dispatched.result;
  const pending = dispatched.pending;
  if (result.kind === "refused") {
    // Nothing was published, so the journalled fact describes nothing.
    if (pending) discardPendingAudit(pending);
    return { content: result.error, outcome: "error" };
  }
  const catalog = await publishWrite(result.name, deps);
  const auditFailure = await settleWriteEvidence(result, pending, context.sessionEventWriter);
  let mutationEvidence: MutationEvidence | undefined;
  let evidenceFailure = false;
  if (result.diff) {
    try {
      const stage = context.sessionEventWriter?.stageSessionContentNodes;
      if (!stage) throw new Error("Session content staging is unavailable");
      mutationEvidence = await buildMutationDiffEvidence(result.diff, context.toolUseId ?? result.name, stage.bind(context.sessionEventWriter));
    } catch {
      evidenceFailure = true;
    }
  }
  deps.onWritten?.({ name: result.name, action: result.action, reach: result.reach, ...(mutationEvidence ? { mutationEvidence } : {}) });
  if (auditFailure) return auditFailure;
  if (evidenceFailure) return { content: `${result.message} Reach: ${result.reach}. ${catalog} Change evidence is unavailable. The write is complete, do not repeat it.`, outcome: "error", details: skillResultDetails(result.action) };
  return {
    content: `${result.message} Reach: ${result.reach}. ${catalog} This update is complete, do not repeat it.`,
    outcome: "ok",
    details: skillResultDetails(result.action, mutationEvidence),
  };
}

/** Publish a landed write to this project's catalog and say truthfully where
 *  it is visible. The bytes are already on disk, so a failed publication is
 *  reported and never fails the write. */
async function publishWrite(name: string, deps: SkillManageToolDeps): Promise<string> {
  const elsewhere = "Other open projects see it when their skill watcher reports the change.";
  try {
    const reload = await deps.publishDefinitions?.();
    if (reload?.published) return `The change is live in this project's skill catalog now. ${elsewhere}`;
  } catch (err) {
    log.warn("skill catalog publication failed after a write", { name, error: errorMessage(err) });
  }
  // A consumer can fail after the registry published, so failure means unconfirmed, not unpublished.
  return "This project's skill catalog could not confirm the change. Open projects, this one included, see it when their skill watcher reports the change.";
}

function skillResultDetails(resultAction: ToolResultAction, mutationEvidence?: MutationEvidence) {
  return { resultAction, ...(mutationEvidence ? { mutationEvidence } : {}) };
}

/** Record the write's journalled audit evidence and wait for it. The package
 *  files are the artifact, but a mutation the event store never accepted is
 *  unattributable (ARCH-LEARNING-007), so a failed or dropped record is
 *  reported instead of success. Terminal for this call: the bytes are already
 *  published, so a retry would write them again, and the journalled fact is
 *  replayed by the next writer or the next session instead. */
async function settleWriteEvidence(
  result: Extract<SkillStoreResult, { kind: "written" }>,
  pending: PendingAudit | undefined,
  writer: SessionFactWriter | undefined,
): Promise<ToolResult | undefined> {
  if (!pending || !writer) return undefined;
  // A replay read the earlier run's terminal evidence and applied nothing, so
  // that run owns this fact: recording it again would double the audit trail.
  if (result.replayed) {
    discardPendingAudit(pending);
    return undefined;
  }
  if (await settlePendingAudit(pending, writer)) return undefined;
  log.warn("skill.written fact deferred to the audit journal", { name: result.name });
  return {
    content: `Skill "${result.name}" is written on disk. Reach: ${result.reach}. Its skill.written evidence is journalled for recovery, but this session could not record it, so the write is not attributable yet. Do not repeat the call - it would write the package again. Tell the user the audit record is pending.`,
    outcome: "error",
  };
}
