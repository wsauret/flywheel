/** Journal-before-publication boundary for managed skill mutations. */
import { randomUUID } from "node:crypto";
import type { FactRecorder } from "../../../infra/fact-recorder.js";
import type { AsyncEventReadSurface, AsyncEventStateReadSurface } from "../../../infra/event-store-types.js";
import { skillWrittenFact, type SkillWrittenFact } from "../../../workflows/skill-facts.js";
import { discardPendingAudit, openPendingAudit, settlePendingAudit, type AuditWriter, type PendingAudit } from "./learning-journal.js";
import { publishGlobalSkillMutation } from "./global-skill-mutation.js";
import { packageDigestAt } from "./skill-package-planning.js";
import { planStaleness } from "./skill-mutation-plan.js";
import { applyPlannedMutation } from "./skill-store.js";
import type { SkillMutationPlan, SkillStoreConfig, SkillStoreResult, SkillWriteOrigin } from "./skill-store-types.js";

export type SkillMutationPublication =
  | { readonly kind: "settled"; readonly result: Extract<SkillStoreResult, { kind: "written" }> }
  | { readonly kind: "published_unsettled"; readonly result: Extract<SkillStoreResult, { kind: "written" }>; readonly pending: PendingAudit }
  | { readonly kind: "stale"; readonly error: string }
  | { readonly kind: "refused"; readonly error: string };

export interface PublishSkillMutationInput {
  readonly config: SkillStoreConfig;
  readonly origin: SkillWriteOrigin;
  readonly plan: SkillMutationPlan;
  readonly writer?: Pick<FactRecorder<SkillWrittenFact>, "record">;
  readonly guard?: () => boolean | Promise<boolean>;
  readonly currentRevision?: () => ReturnType<SkillStoreConfig["registry"]>;
  readonly global?: { readonly sessionId: string; readonly toolUseId: string; readonly store?: AsyncEventStateReadSurface; readonly projectionReader?: AsyncEventReadSurface; readonly writer: AuditWriter };
}

/** Publishes one admitted plan only after its exact audit intent is durable. */
export async function publishSkillMutation(input: PublishSkillMutationInput): Promise<SkillMutationPublication> {
  if (!input.writer) return { kind: "refused", error: `Skill "${input.plan.name}" cannot publish without a durable attribution writer.` };
  if (input.plan.reach === "global" && !input.global) return { kind: "refused", error: "A global skill change requires a durable session writer and tool call id." };
  let pending: PendingAudit | undefined;
  const openAudit = (): PendingAudit | undefined => {
    if (!input.writer) return undefined;
    if (pending) return pending;
    const outcome = input.plan.outcome;
    const destination = outcome.destination.dir;
    const intended = outcome.kind === "archive" || outcome.kind === "restore"
      ? {
          kind: "archive" as const,
          source: outcome.source.dir,
          sourceSha256: input.plan.basePackageSha256 ?? outcome.package.identity.sha256,
          destination,
          destinationPrevious: packageDigestAt(destination) ?? null,
          destinationSha256: outcome.package.identity.sha256,
        }
      : {
          kind: "package" as const,
          dir: destination,
          sha256: outcome.package.identity.sha256,
          previous: packageDigestAt(destination) ?? null,
        };
    pending = openPendingAudit({
      storeDir: input.plan.root === "project" ? `${input.config.projectRoot}/.flywheel/skills` : `${input.config.userDataRoot}/skills`,
      workspace: input.config.projectRoot,
      fact: skillWrittenFact({
        name: input.plan.name,
        action: input.plan.action,
        reach: input.plan.reach,
        origin: factOrigin(input.origin),
        writeId: randomUUID(),
        proposalId: input.plan.proposalId,
        contentHash: input.plan.contentHash,
        packageIdentity: input.plan.outcome.package.identity,
        description: input.plan.description,
      }),
      intended,
    });
    return pending;
  };

  const result = input.plan.reach === "global" && input.global
    ? await publishGlobalSkillMutation({ config: input.config, origin: input.origin, plan: input.plan, ...input.global, openAudit })
    : await applyPlannedMutation(input.plan, input.guard, { currentRevision: input.currentRevision, openAudit });
  if (result.kind === "refused") {
    if (pending) discardPendingAudit(pending);
    return planStaleness(input.plan) ? { kind: "stale", error: result.error } : { kind: "refused", error: result.error };
  }
  if (!pending || !input.writer || result.replayed) return { kind: "settled", result };
  return await settlePendingAudit(pending, input.writer)
    ? { kind: "settled", result }
    : { kind: "published_unsettled", result, pending };
}

function factOrigin(origin: SkillWriteOrigin): SkillWrittenFact["payload"]["origin"] {
  return origin.kind === "review" ? { kind: "review", reviewRunId: origin.reviewRunId } : origin;
}
