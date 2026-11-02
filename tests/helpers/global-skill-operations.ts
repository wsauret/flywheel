/** Historical producer fixtures for global skill recovery tests. Plans and
 * records use the production planner and strict manifest codec, while the
 * retired consent flow exists only here to reproduce version 1 history. */

import { asAsyncEventReadSurface, asAsyncEventWriter, type EventReader, type LocalSqliteEventStore } from "../../src/infra/event-store-types.js";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { createSqliteEventStore } from "../../src/infra/sqlite-event-store.js";
import {
  readConsentClaims,
  reconcileGlobalSkillOperations,
  type ConsentClaims,
} from "../../src/orchestration/modules/learning/global-skill-mutation.js";
import { agentInputConsumedFact } from "../../src/orchestration/session/agent-input-facts.js";
import { createSessionFactWriter, type SessionFactWriter } from "../../src/orchestration/session/session-fact-writer.js";
import {
  operationIdentity,
  advanceOperationManifest,
  readOperationManifest,
  readProposalRecord,
  writeOperationManifest,
  proposalPath,
  isTerminalState,
  type OperationManifest,
  type OperationState,
} from "../../src/orchestration/modules/learning/skill-operation-manifest.js";
import type { SkillMutation, SkillStoreConfig, SkillStoreResult, SkillWriteOrigin } from "../../src/orchestration/modules/learning/skill-store-types.js";
import { publishSkillRevision } from "../../src/workflows/skill-schema.js";
import { loadSkillDefinitions, ownedSkillStoreDirs } from "../../src/workflows/skills.js";
import type { ProjectDirectories } from "../../src/infra/directory-authorities.js";
import { planSkillMutation, planLockPaths, storeRootDirs } from "../../src/orchestration/modules/learning/skill-mutation-plan.js";
import { resultOfPlan } from "../../src/orchestration/modules/learning/skill-store.js";
import { claimAnsweredDecision } from "../../src/orchestration/session/agent-input-decision.js";
import { withPackageLocks } from "../../src/infra/package-directory-lock.js";
import { forgetOperation, runOperation } from "../../src/orchestration/modules/learning/global-skill-mutation-protocol.js";
import { reconcilePendingAudits, settlePendingAudit } from "../../src/orchestration/modules/learning/learning-journal.js";

/** Historical producer fixture, not a supported publication API. */
export function readGlobalMutationProposal(globalRoot: string, proposalId: string) {
  const read = readProposalRecord(globalRoot, proposalId);
  return read.kind === "ok" ? { summary: read.proposal.plan.summary } : undefined;
}

/** Reproduce the old producer so recovery tests retain real version 1 records. */
export async function commitGlobalSkillMutation(input: {
  config: SkillStoreConfig; origin: SkillWriteOrigin; mutation: SkillMutation;
  sessionId: string; interactionId: string; store: EventReader; writer: SessionFactWriter;
  /** Runs after the plan and its manifest exist and before the claim, so
   *  concurrent committers that planned against one pre-state race over the
   *  claim and the publication alone. */
  beforeClaim?: () => Promise<void>;
}): Promise<SkillStoreResult> {
  const roots = storeRootDirs(input.config);
  const claims = await readConsentClaims(asAsyncEventReadSurface(input.store), input.config.projectRoot, [roots.user]);
  reconcileGlobalSkillOperations(roots.user, claims);
  await reconcilePendingAudits({ storeDir: roots.user, workspace: input.config.projectRoot, reader: asAsyncEventReadSurface(input.store), writer: input.writer });
  const planned = planSkillMutation(input.config, input.origin, input.mutation);
  if (planned.kind === "refused") return planned;
  const plan = planned.plan;
  const origin = { sessionId: input.sessionId, interactionId: input.interactionId };
  const operationId = operationIdentity(origin, plan.proposalId);
  const read = readOperationManifest(roots.user, operationId);
  if (read.kind === "unusable") return { kind: "refused", error: read.reason };
  const existing = read.kind === "ok" ? read.manifest : undefined;
  const terminal = (manifest: OperationManifest): SkillStoreResult => {
    if (manifest.state === "refused") return { kind: "refused", error: manifest.outcomeDetail ?? "refused" };
    const result = resultOfPlan(manifest.plan);
    return result.kind === "written" ? { ...result, replayed: true } : result;
  };
  if (existing && isTerminalState(existing.state)) return terminal(existing);
  const manifest: OperationManifest = existing ?? {
    version: 1, state: "claiming", operationId, transition: 1, createdAt: Date.now(), updatedAt: Date.now(),
    globalStoreDir: roots.user, projectStoreDir: roots.project, origin, plan,
  };
  if (!existing) writeOperationManifest(roots.user, manifest);
  await input.beforeClaim?.();
  const claim = await claimAnsweredDecision({
    store: asAsyncEventReadSurface(input.store), writer: input.writer, sessionId: input.sessionId, interactionId: input.interactionId,
    claimId: operationId, consumption: "replayable",
    verify: (decision) => decision.kind === "global_skill_mutation" && decision.proposalId === plan.proposalId ? undefined : "mismatched legacy approval",
  });
  if (claim.kind === "refused") {
    if (manifest.state === "claiming" && !claims.consumed(origin, operationId)) forgetOperation(roots.user, operationId);
    return { kind: "refused", error: claim.reason.kind === "writer-disposed" ? "The session stopped recording" : claim.reason.kind };
  }
  return withPackageLocks(planLockPaths(plan), async () => {
    const fresh = readOperationManifest(roots.user, operationId);
    if (fresh.kind !== "ok") throw new Error("missing historical manifest");
    if (isTerminalState(fresh.manifest.state)) return terminal(fresh.manifest);
    const claimed = fresh.manifest.state === "claiming" ? advanceOperationManifest(fresh.manifest, "claimed") : fresh.manifest;
    writeOperationManifest(roots.user, claimed);
    const run = runOperation(roots.user, claimed);
    for (const pending of run.pending) if (!await settlePendingAudit(pending, input.writer)) break;
    return run.outcome.kind === "refused" ? { kind: "refused", error: run.outcome.error } : resultOfPlan(plan);
  });
}

type InterruptedOperationState = "claimed" | "staged" | "hidden" | "published"

function interruptedManifestAt(claiming: OperationManifest, state: InterruptedOperationState): OperationManifest {
  const claimed = advanceOperationManifest(claiming, "claimed")
  if (state === "claimed") return claimed
  const staged = advanceOperationManifest(claimed, "staged")
  if (state === "staged") return staged
  const hidden = advanceOperationManifest(staged, "hidden")
  return state === "hidden" ? hidden : advanceOperationManifest(hidden, "published")
}
/** The two stable choice labels the ask_user tool binds a global proposal to. */
const APPROVE_LABEL = "Approve the global skill change";
const REJECT_LABEL = "Reject the global skill change";

export interface GlobalSkillHarnessInput {
  /** Directory authorities the harness selects the two owned stores from. */
  readonly directories: ProjectDirectories;
  readonly dbPath: string;
  readonly sessionId: string;
}

export interface GlobalSkillHarness {
  readonly config: SkillStoreConfig;
  readonly origin: SkillWriteOrigin;
  readonly globalRoot: string;
  readonly projectRoot: string;
  readonly store: LocalSqliteEventStore;
  readonly writer: SessionFactWriter;
  /** Reproduce a historical proposal with the current canonical planner. */
  prepare(mutation: SkillMutation): string;
  /** Record the bound question and its affirmative answer. */
  approve(proposalId: string, interactionId: string): Promise<void>;
  /** Append the guarded consumed claim that authorizes recovery. */
  claim(operationId: string, interactionId: string): Promise<void>;
  /** The identity of the operation one confirmation of one proposal authorizes,
   *  computed the way the commit path computes it. */
  operationId(proposalId: string, interactionId: string): string;
  /** The decoded and fully verified manifest, or a failure naming the reason. */
  manifest(operationId: string): OperationManifest;
  /** Open the operation one confirmation authorizes and leave it in the in-flight
   *  state a crash would have left, with the plan the production prepare path
   *  persisted for that proposal. */
  interrupt(proposalId: string, interactionId: string, state: InterruptedOperationState): OperationManifest;
  commit(mutation: SkillMutation, interactionId: string, writer?: SessionFactWriter): Promise<SkillStoreResult>;
  claims(): Promise<ConsentClaims>;
  consumedClaimCount(): number;
  /** The states of the operation audit trail, in recorded order. */
  auditedTransitions(): readonly string[];
  close(): void;
}

export function createGlobalSkillHarness(input: GlobalSkillHarnessInput): GlobalSkillHarness {
  const dirs = ownedSkillStoreDirs(input.directories);
  const registry = () => {
    const load = loadSkillDefinitions({
      roots: [
        { authority: "external", dir: dirs.project, reach: "project" },
        { authority: "external", dir: dirs.user, reach: "global" },
      ],
    });
    return publishSkillRevision(1, load.skills);
  };
  const config: SkillStoreConfig = { projectRoot: input.directories.projectRoot, userDataRoot: input.directories.userDataRoot, registry };
  const origin: SkillWriteOrigin = { kind: "agent", sessionId: input.sessionId };
  const store = createSqliteEventStore(input.dbPath);
  const writer = createSessionFactWriter({ sessionId: input.sessionId, writer: asAsyncEventWriter(store) });

  function manifest(operationId: string): OperationManifest {
    const read = readOperationManifest(dirs.user, operationId);
    if (read.kind === "ok") return read.manifest;
    throw new Error(`manifest ${operationId} is ${read.kind}${read.kind === "unusable" ? `: ${read.reason}` : ""}`);
  }

  function operationId(proposalId: string, interactionId: string): string {
    return operationIdentity({ sessionId: input.sessionId, interactionId }, proposalId);
  }

  return {
    config,
    origin,
    globalRoot: dirs.user,
    projectRoot: dirs.project,
    store,
    writer,
    prepare(mutation) {
      const planned = planSkillMutation(config, origin, mutation);
      if (planned.kind === "refused") throw new Error(planned.error);
      const record = { version: 1 as const, proposalId: planned.plan.proposalId, createdAt: Date.now(), globalStoreDir: dirs.user, projectStoreDir: dirs.project, plan: planned.plan };
      const path = proposalPath(dirs.user, record.proposalId);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, JSON.stringify(record));
      return record.proposalId;
    },
    async approve(proposalId, interactionId) {
      const proposal = readGlobalMutationProposal(dirs.user, proposalId);
      if (!proposal) throw new Error(`no prepared proposal ${proposalId}`);
      const question = `Apply this global skill change?\n\n${proposal.summary}`;
      await writer.record({
        type: "agent_input.requested",
        version: 3,
        actor: "agent",
        payload: {
          interactionId,
          conversationId: "conv-1",
          toolUseId: interactionId,
          request: [{
            question,
            header: "Global",
            choices: [
              { kind: "option", choiceId: "approve", label: APPROVE_LABEL },
              { kind: "option", choiceId: "reject", label: REJECT_LABEL },
              { kind: "freeform", label: "Other" },
            ],
            multiSelect: false,
          }],
          decision: {
            kind: "global_skill_mutation",
            proposalId,
            question,
            approve: { choiceId: "approve", label: APPROVE_LABEL },
            reject: { choiceId: "reject", label: REJECT_LABEL },
          },
        },
      });
      await writer.record({
        type: "agent_input.answered",
        version: 3,
        actor: "user",
        payload: { interactionId, answers: { [question]: { kind: "choice", selections: [{ choiceId: "approve" }], text: APPROVE_LABEL } } },
      });
    },
    async claim(claimedOperationId, interactionId) {
      const stored = await writer.recordGuarded(
        agentInputConsumedFact({ interactionId, claimId: claimedOperationId }),
        store.aggregateSeq(`session:${input.sessionId}`) + 1,
      );
      if (!stored) throw new Error(`the consumed claim for ${claimedOperationId} was not recorded`);
    },
    manifest,
    operationId,
    interrupt(proposalId, interactionId, state) {
      const read = readProposalRecord(dirs.user, proposalId);
      if (read.kind !== "ok") throw new Error(`proposal ${proposalId} is ${read.kind}`);
      const proposal = read.proposal;
      const claiming: OperationManifest = {
        version: 1,
        state: "claiming",
        operationId: operationId(proposalId, interactionId),
        transition: 1,
        createdAt: proposal.createdAt,
        updatedAt: Date.now(),
        globalStoreDir: proposal.globalStoreDir,
        projectStoreDir: proposal.projectStoreDir,
        origin: { sessionId: input.sessionId, interactionId },
        plan: proposal.plan,
      };
      const interrupted = interruptedManifestAt(claiming, state);
      writeOperationManifest(dirs.user, interrupted);
      return interrupted;
    },
    commit(mutation, interactionId, override) {
      return commitGlobalSkillMutation({
        config,
        origin,
        mutation,
        sessionId: input.sessionId,
        interactionId,
        store,
        writer: override ?? writer,
      });
    },
    claims: () => readConsentClaims(asAsyncEventReadSurface(store), input.directories.projectRoot, [dirs.user]),
    consumedClaimCount() {
      return [...store.read({ aggregateId: `session:${input.sessionId}`, types: ["agent_input.consumed"] })].length;
    },
    auditedTransitions() {
      return [...store.read({ aggregateId: `session:${input.sessionId}`, types: ["skill.operation.transitioned"] })]
        .map((event) => String(Reflect.get(event.payload, "state")));
    },
    close() {
      writer.dispose();
      store.close();
    },
  };
}
