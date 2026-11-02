/** Staged global publication and recovery. Current operations are authorized by
 * their originating tool call. Historical operations retain their consent
 * requirement and can never acquire authority through a format conversion. */
import type { AsyncEventReadSurface, AsyncEventStateReadSurface } from "../../../infra/event-store-types.js";
import { Log } from "../../../infra/log.js";
import type { ProjectDirectories } from "../../../infra/directory-authorities.js";
import { projectSkillStoreDir, skillStoreRoots } from "../../../workflows/skills.js";
import { canonicalMutationPath } from "../../../infra/file-mutation-queue.js";
import { reconcilePendingAudits, settlePendingAudit, type AuditWriter, type PendingAudit } from "./learning-journal.js";
import { forgetOperation, forgetProposal, runOperation } from "./global-skill-mutation-protocol.js";
import { loadAgentInputProjection, type AgentInputEntry } from "../../session/agent-input-projection.js";
import { planLockPaths, storeRootDirs } from "./skill-mutation-plan.js";
import {
  activeOperationIds, advanceOperationManifest, isTerminalState, operationIdentity,
  quarantineManifest, readOperationManifest, readProposalRecordsForReconciliation,
  writeOperationManifest, type OperationManifest, type OperationOrigin,
} from "./skill-operation-manifest.js";
import { tryWithPackageLocksSync, withPackageLocks } from "../../../infra/package-directory-lock.js";
import { refuseBackgroundGlobalWrite, refuseUncontainedSkillStores, resultOfPlan } from "./skill-store.js";
import type { SkillMutationPlan, SkillStoreConfig, SkillStoreResult, SkillWriteOrigin } from "./skill-store-types.js";

const log = Log.create({ service: "global-skill-mutation" });
const UNCONFIRMED_TTL_MS = 24 * 60 * 60 * 1000;

/** Claims from one workspace can authorize only that workspace's historical operations. */
export interface ConsentClaims {
  readonly workspace: string;
  readonly consumed: (origin: OperationOrigin, operationId: string) => boolean;
}

/** The same claims read through the async boundary. Only version 1
 *  operations ask for consent, so the decisions of the sessions they name
 *  under `globalRoots` are read first, and reconciliation stays synchronous. */
export async function readConsentClaims(reader: AsyncEventReadSurface, projectRoot: string, globalRoots: readonly string[]): Promise<ConsentClaims> {
  const entries = new Map<string, ReadonlyMap<string, AgentInputEntry>>();
  for (const sessionId of legacyConsentSessions(globalRoots)) entries.set(sessionId, await loadAgentInputProjection(reader, sessionId));
  return {
    workspace: canonicalMutationPath(projectSkillStoreDir(projectRoot)),
    consumed: (origin, operationId) => {
      const entry = entries.get(origin.sessionId)?.get(origin.interactionId);
      return entry?.kind === "answered" && entry.consumedBy === operationId;
    },
  };
}

function legacyConsentSessions(globalRoots: readonly string[]): ReadonlySet<string> {
  const sessionIds = new Set<string>();
  for (const globalRoot of globalRoots) {
    for (const operationId of activeOperationIds(globalRoot)) {
      const read = readOperationManifest(globalRoot, operationId);
      if (read.kind === "ok" && read.manifest.version !== 2) sessionIds.add(read.manifest.origin.sessionId);
    }
  }
  return sessionIds;
}

export interface PublishGlobalMutationInput {
  readonly config: SkillStoreConfig;
  readonly origin: SkillWriteOrigin;
  readonly plan: SkillMutationPlan;
  readonly sessionId: string;
  readonly toolUseId: string;
  readonly store?: AsyncEventStateReadSurface;
  readonly projectionReader?: AsyncEventReadSurface;
  readonly writer: AuditWriter;
  readonly openAudit: () => PendingAudit | undefined;
}

/** Publish an interactive mutation under package locks. The retained manifest
 * makes interrupted publication recoverable without another user decision. */
export async function publishGlobalSkillMutation(input: PublishGlobalMutationInput): Promise<SkillStoreResult> {
  const uncontained = refuseUncontainedSkillStores(input.config);
  if (uncontained) return { kind: "refused", error: uncontained };
  const plan = input.plan;
  if (plan.reach !== "global") return { kind: "refused", error: "This operation requires a global skill plan." };
  if (input.origin.kind === "review" || input.origin.kind === "pruner") {
    return { kind: "refused", error: refuseBackgroundGlobalWrite(input.origin.kind, plan.name) };
  }
  const roots = storeRootDirs(input.config);
  const globalRoot = roots.user;
  reconcileGlobalSkillOperations(globalRoot, input.store ? await readConsentClaims(input.store, input.config.projectRoot, [globalRoot]) : undefined);
  const auditReader = input.projectionReader ?? input.store;
  if (auditReader) {
    await reconcilePendingAudits({ storeDir: globalRoot, workspace: input.config.projectRoot, reader: auditReader, writer: input.writer });
  }
  const origin = { sessionId: input.sessionId, interactionId: input.toolUseId };
  const operationId = operationIdentity(origin, plan.proposalId);
  const run = await withPackageLocks(planLockPaths(plan), async () => {
    const read = readOperationManifest(globalRoot, operationId);
    if (read.kind === "unusable") {
      quarantineManifest(globalRoot, operationId, read.reason);
      return { outcome: { kind: "refused" as const, error: `The global skill operation is unreadable (${read.reason}); nothing was applied.` }, pending: [] };
    }
    if (read.kind === "ok") {
      const current = read.manifest;
      if (current.version !== 2) return { outcome: { kind: "refused" as const, error: "A previous consent-bound operation owns this identity." }, pending: [] };
      if (isTerminalState(current.state)) return { outcome: { kind: "replayed" as const, manifest: current }, pending: [] };
      return runOperation(globalRoot, current);
    }
    const now = Date.now();
    const manifest: OperationManifest = {
      version: 2, state: "claimed", operationId, transition: 2,
      createdAt: now, updatedAt: now, globalStoreDir: roots.user,
      projectStoreDir: roots.project, origin, plan,
    };
    input.openAudit();
    writeOperationManifest(globalRoot, manifest);
    return runOperation(globalRoot, manifest);
  });
  for (const pending of run.pending) {
    if (!await settlePendingAudit(pending, input.writer)) break;
  }
  if (run.outcome.kind === "refused") return { kind: "refused", error: run.outcome.error };
  if (run.outcome.kind === "replayed") {
    const manifest = run.outcome.manifest;
    if (manifest.state === "refused") return { kind: "refused", error: manifest.outcomeDetail ?? `The change to "${manifest.plan.name}" was refused.` };
    const applied = resultOfPlan(manifest.plan);
    return applied.kind === "written" ? { ...applied, replayed: true } : applied;
  }
  return resultOfPlan(plan);
}

function authorize(manifest: OperationManifest, claims: ConsentClaims | undefined): "confirmed" | "unconfirmed" | "unverifiable" {
  if (manifest.version === 2) return "confirmed";
  // Compatibility: retain version 1 consent checks until after 2027-09-24.
  // Never upgrade an unconfirmed historical manifest into tool-call authority.
  if (!claims || claims.workspace !== canonicalMutationPath(manifest.projectStoreDir)) return "unverifiable";
  return claims.consumed(manifest.origin, manifest.operationId) ? "confirmed" : "unconfirmed";
}

/** Recover authorized staged operations. A legacy operation whose consent
 * belongs to another workspace stays untouched; unconfirmed records never run. */
export function reconcileGlobalSkillOperations(globalRoot: string, claims?: ConsentClaims): void {
  for (const proposal of readProposalRecordsForReconciliation(globalRoot)) {
    if (Date.now() - proposal.createdAt > UNCONFIRMED_TTL_MS) forgetProposal(globalRoot, proposal.proposalId);
  }
  for (const operationId of activeOperationIds(globalRoot)) {
    const read = readOperationManifest(globalRoot, operationId);
    if (read.kind === "absent") continue;
    if (read.kind === "unusable") {
      quarantineManifest(globalRoot, operationId, read.reason);
      continue;
    }
    const manifest = read.manifest;
    const authorization = authorize(manifest, claims);
    if (authorization === "unverifiable") {
      log.info("global skill operation left for the workspace that holds its consent", { operationId, state: manifest.state });
      continue;
    }
    if (authorization === "unconfirmed") {
      if (manifest.state === "claiming") {
        if (Date.now() - manifest.createdAt > UNCONFIRMED_TTL_MS) forgetOperation(globalRoot, operationId);
      } else {
        quarantineManifest(globalRoot, operationId, "no durable consent claim authorizes this operation");
      }
      continue;
    }
    log.info("resuming interrupted global skill operation", { operationId, state: manifest.state });
    const ran = tryWithPackageLocksSync(planLockPaths(manifest.plan), () => {
      const fresh = readOperationManifest(globalRoot, operationId);
      if (fresh.kind !== "ok" || isTerminalState(fresh.manifest.state)) return;
      const current = fresh.manifest;
      const claimed = current.state === "claiming" ? advanceOperationManifest(current, "claimed") : current;
      if (claimed !== current) writeOperationManifest(globalRoot, claimed);
      runOperation(globalRoot, claimed);
    });
    if (!ran) log.info("global skill operation is held by another owner", { operationId });
  }
}

/** Settle every owned global store before a registry admits its packages. */
export function reconcileGlobalSkillStores(directories: ProjectDirectories, claims?: ConsentClaims): void {
  for (const root of skillStoreRoots(directories)) {
    if (root.owned && root.reach === "global") reconcileGlobalSkillOperations(root.dir, claims);
  }
}
