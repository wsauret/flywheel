import type { FactRecorder } from "../../../infra/fact-recorder.js";
import { resolveSkillSpecializationCanonical } from "./skill-semantic-audit.js";
import type { SkillWrittenFact } from "../../../workflows/skill-facts.js";
import type { BundledCorpusIdentity, SkillPackageIdentity, SkillRegistryRevision } from "../../../workflows/skill-schema.js";
import { decodeSkillCorpusCleanupResponse, isSkillCorpusCleanupRequestFor, type CoreSkillCleanupClassification, type SkillCorpusCleanupCandidate, type SkillCorpusCleanupRequest } from "./skill-corpus-cleanup-classifier.js";
import { SKILL_CORPUS_CLEANUP_LEASE_MS, type CoreManifest, type SkillCorpusCleanupState } from "./skill-corpus-cleanup-state.js";
import { eligibleLearnedSkill, eligibleLearnedSkills } from "./learned-skill-eligibility.js";
import { planSkillMutation } from "./skill-mutation-plan.js";
import { publishSkillMutation, type PublishSkillMutationInput, type SkillMutationPublication } from "./skill-mutation-publisher.js";
import type { SkillStoreConfig } from "./skill-store-types.js";

export interface SkillCorpusCleanupWorkResult {
  readonly request: SkillCorpusCleanupRequest;
  readonly output: string | undefined;
}

export interface SkillCorpusCleanupInput {
  readonly config: SkillStoreConfig;
  readonly state: SkillCorpusCleanupState;
  readonly classify: (revision: SkillRegistryRevision, corePackageIds: readonly string[], candidates: readonly SkillCorpusCleanupCandidate[], signal: AbortSignal) => Promise<readonly SkillCorpusCleanupWorkResult[]>;
  readonly publish?: (input: PublishSkillMutationInput) => Promise<SkillMutationPublication>;
  readonly eligibleOne?: typeof eligibleLearnedSkill;
  readonly eligibleAll?: typeof eligibleLearnedSkills;
  readonly record: FactRecorder<SkillWrittenFact>["record"];
  readonly force?: boolean;
  readonly renewalIntervalMs?: number;
  readonly signal?: AbortSignal;
}

export type SkillCorpusCleanupResult =
  | { readonly kind: "completed"; readonly corePackages: number; readonly candidates: number; readonly archived: readonly string[] }
  | { readonly kind: "already-complete" | "leased" | "deferred" }
  | { readonly kind: "campaign-deferred"; readonly reason: string };

function sameIdentity(left: SkillPackageIdentity, right: SkillPackageIdentity): boolean {
  return left.sha256 === right.sha256 && left.bytes === right.bytes;
}

function sameCorpus(left: BundledCorpusIdentity, right: BundledCorpusIdentity): boolean {
  return left.version === right.version && sameIdentity(left, right);
}

function sameManifest(left: CoreManifest, right: CoreManifest): boolean {
  return left.length === right.length && left.every((row, index) => {
    const expected = right[index];
    return expected !== undefined && row.id === expected.id && sameIdentity(row.packageIdentity, expected.packageIdentity);
  });
}

function captureCandidates(revision: SkillRegistryRevision, input: SkillCorpusCleanupInput): readonly SkillCorpusCleanupCandidate[] {
  return (input.eligibleAll ?? eligibleLearnedSkills)({ revision, projectRoot: `${input.config.projectRoot}/.flywheel/skills`, reach: "project" })
    .map(({ definition, package: prepared }) => ({ id: definition.id, package: prepared }));
}

function sameCandidates(left: readonly SkillCorpusCleanupCandidate[], right: readonly SkillCorpusCleanupCandidate[]): boolean {
  return left.length === right.length && left.every((candidate, index) => {
    const expected = right[index];
    return expected !== undefined && candidate.id === expected.id && sameIdentity(candidate.package.identity, expected.package.identity);
  });
}

function abortReason(message: string): DOMException {
  return new DOMException(message, "AbortError");
}

/** Runs one fenced core-corpus cleanup campaign without holding storage ownership across provider work. */
export async function runSkillCorpusCleanup(input: SkillCorpusCleanupInput): Promise<SkillCorpusCleanupResult> {
  const capturedRevision = input.config.registry();
  const coreIdentity = capturedRevision.coreIdentity;
  const coreManifest = capturedRevision.coreManifest;
  const claim = await input.state.claim(coreIdentity, coreManifest, input.force);
  if (claim.kind !== "claimed") return { kind: claim.kind };
  const defer = async (reason: string): Promise<SkillCorpusCleanupResult> => {
    await input.state.defer(coreIdentity, claim.token, reason);
    return { kind: "campaign-deferred", reason };
  };
  const cancel = async (reason: string): Promise<SkillCorpusCleanupResult> => {
    await input.state.cancel(coreIdentity, claim.token, reason);
    return { kind: "campaign-deferred", reason };
  };
  const completeIfLive = async (expectedCandidates: readonly SkillCorpusCleanupCandidate[], archived: readonly string[]): Promise<SkillCorpusCleanupResult> => {
    const finalRevision = input.config.registry();
    let finalCandidates: readonly SkillCorpusCleanupCandidate[];
    try { finalCandidates = captureCandidates(finalRevision, input); } catch (error) { return defer(String(error)); }
    if (!sameCorpus(finalRevision.coreIdentity, coreIdentity) || !sameManifest(finalRevision.coreManifest, coreManifest) || !sameCandidates(finalCandidates, expectedCandidates) || !await input.state.renew(coreIdentity, claim.token)) return defer("cleanup final retained set, workflow protection, corpus, or lease changed");
    return await input.state.complete(coreIdentity, coreManifest, claim.token)
      ? { kind: "completed", corePackages: captured.length === 0 ? 0 : claim.changedPackageIds.length, candidates: claim.changedPackageIds.length === 0 ? 0 : captured.length, archived }
      : { kind: "campaign-deferred", reason: "cleanup lease was lost before completion" };
  };

  let captured: readonly SkillCorpusCleanupCandidate[];
  try { captured = captureCandidates(capturedRevision, input); } catch (error) { return defer(String(error)); }
  if (claim.changedPackageIds.length === 0 || captured.length === 0) return completeIfLive(captured, []);

  const campaign = new AbortController();
  const signal = input.signal ? AbortSignal.any([campaign.signal, input.signal]) : campaign.signal;
  const renewalIntervalMs = input.renewalIntervalMs ?? Math.max(1, Math.floor(SKILL_CORPUS_CLEANUP_LEASE_MS / 3));
  let leaseLost = false;
  let renewal: Promise<void> | undefined;
  const renew = (): void => {
    renewal = input.state.renew(coreIdentity, claim.token).then((owned) => {
      if (!owned) { leaseLost = true; campaign.abort(abortReason("Cleanup lease was lost")); }
    }).catch(() => { leaseLost = true; campaign.abort(abortReason("Cleanup lease renewal failed")); });
  };
  const timer = setInterval(renew, renewalIntervalMs);
  let work: readonly SkillCorpusCleanupWorkResult[];
  try {
    work = await input.classify(capturedRevision, claim.changedPackageIds, captured, signal);
  } catch (error) {
    clearInterval(timer);
    await renewal;
    if (!leaseLost && signal.aborted) return cancel(`cleanup campaign aborted: ${String(signal.reason)}`);
    return defer(leaseLost ? "cleanup lease was lost during provider work" : `cleanup provider failed: ${String(error)}`);
  }
  clearInterval(timer);
  await renewal;
  if (leaseLost) return defer("cleanup lease was lost during provider work");
  if (signal.aborted) return cancel(`cleanup campaign aborted: ${String(signal.reason)}`);

  const expectedCells = new Set<string>();
  for (const corePackageId of claim.changedPackageIds) for (const candidate of captured) expectedCells.add(`${corePackageId}\0${candidate.id}`);
  const classifications: Array<CoreSkillCleanupClassification & { corePackageId: string }> = [];
  for (const item of work) {
    if (!isSkillCorpusCleanupRequestFor(capturedRevision, captured, item.request) || !claim.changedPackageIds.includes(item.request.corePackageId)) return defer("cleanup coordinator returned work for unexpected request evidence");
    const decoded = decodeSkillCorpusCleanupResponse(item.request, item.output);
    if (!decoded) return defer("cleanup provider output was incomplete or invalid");
    for (const classification of decoded) {
      const key = `${item.request.corePackageId}\0${classification.candidateId}`;
      if (!expectedCells.delete(key)) return defer("cleanup provider output contained duplicate or unexpected coverage");
      classifications.push({ ...classification, corePackageId: item.request.corePackageId });
    }
  }
  if (expectedCells.size !== 0) return defer("cleanup provider output did not cover the complete core and candidate matrix");

  const candidatesById = new Map(captured.map((candidate) => [candidate.id, candidate]));
  const archiveById = new Map<string, SkillCorpusCleanupCandidate>();
  for (const classification of classifications) {
    const candidate = candidatesById.get(classification.candidateId);
    if (!candidate) return defer("cleanup provider output referenced an unknown candidate");
    const specializationCanonical = classification.outcome === "specialization" && classification.canonicalSkillId !== undefined
      ? resolveSkillSpecializationCanonical(candidate.package, classification.canonicalSkillId, capturedRevision)
      : undefined;
    const archive = classification.outcome === "conflict"
      || (classification.outcome === "specialization" && (classification.canonicalSkillId !== classification.corePackageId || specializationCanonical?.id !== classification.corePackageId));
    if (archive) archiveById.set(`${candidate.id}\0${candidate.package.identity.sha256}\0${candidate.package.identity.bytes}`, candidate);
  }
  const archiveTargets = [...archiveById.values()].sort((left, right) => left.id.localeCompare(right.id));

  const beforeMutation = input.config.registry();
  let liveCandidates: readonly SkillCorpusCleanupCandidate[];
  try { liveCandidates = captureCandidates(beforeMutation, input); } catch (error) { return defer(String(error)); }
  if (!sameCorpus(beforeMutation.coreIdentity, coreIdentity) || !sameManifest(beforeMutation.coreManifest, coreManifest) || !sameCandidates(liveCandidates, captured) || !await input.state.renew(coreIdentity, claim.token)) return defer("cleanup corpus, candidates, workflow protection, or lease changed before mutation");

  const archived: string[] = [];
  for (const target of archiveTargets) {
    const planned = planSkillMutation(input.config, { kind: "pruner" }, { kind: "archive", name: target.id });
    if (planned.kind === "refused") return defer(planned.error);
    const publication = await (input.publish ?? publishSkillMutation)({
      config: input.config,
      origin: { kind: "pruner" },
      plan: planned.plan,
      writer: { record: input.record },
      currentRevision: input.config.registry,
      guard: async () => {
        if (!await input.state.owns(coreIdentity, claim.token)) return false;
        const revision = input.config.registry();
        if (!sameCorpus(revision.coreIdentity, coreIdentity) || !sameManifest(revision.coreManifest, coreManifest)) return false;
        const live = (input.eligibleOne ?? eligibleLearnedSkill)({ revision, projectRoot: `${input.config.projectRoot}/.flywheel/skills`, reach: "project" }, target.id);
        return live !== undefined && sameIdentity(live.package.identity, target.package.identity);
      },
    });
    if (publication.kind !== "settled") return defer(`cleanup archive for "${target.id}" did not settle: ${publication.kind}`);
    archived.push(target.id);
  }

  const archivedIds = new Set(archived);
  const expectedRetained = captured.filter((candidate) => !archivedIds.has(candidate.id));
  return completeIfLive(expectedRetained, archived);
}