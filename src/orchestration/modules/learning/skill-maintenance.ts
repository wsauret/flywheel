import type { PreparedPackage, SkillSemanticAuditResult } from "../../agent-runtime/review-types.js";
/** One maintenance pass, end to end.
 *
 *  The survey decided the units. This performs them: for each unit it sends only
 *  that unit's packages, checks the result against what went in, and applies it.
 *  A merge writes the receiving package and archives what it absorbed; a repair
 *  writes one package back over itself. The store work is the same either way.
 *
 *  Origin is `review`, which is what this is: model-authored content with no
 *  user reading each result. That origin brings the two rules this pass wants
 *  anyway. Every content-adding write carries its own semantic audit, and an
 *  archive must name the package that absorbed it, so a merge can never quietly
 *  become a prune.
 *
 *  A unit is applied whole or not at all. A unit the guards refuse wrote
 *  nothing, so the pass records it and moves to the next one: units are
 *  independent, and stopping at the first refusal would mean learning one
 *  outcome per run instead of all of them. A failure that is not about this
 *  unit does stop the pass, because a request that could not be made or a write
 *  that failed partway says nothing about whether the next unit is safe. */

import { randomUUID } from "node:crypto";
import type { FactRecorder } from "../../../infra/fact-recorder.js";
import { Log } from "../../../infra/log.js";
import type { SkillWrittenFact } from "../../../workflows/skill-facts.js";
import { SKILL_FILE, type SkillRegistryRevision } from "../../../workflows/skill-schema.js";
import { admitSkillMutationPlan, planSkillMutation } from "./skill-mutation-plan.js";
import { publishSkillMutation } from "./skill-mutation-publisher.js";

import type { SkillMutation, SkillStoreConfig, SkillWriteOrigin } from "./skill-store-types.js";
import { unitReceiver, type SkillMaintenanceUnit } from "./skill-maintenance-survey.js";
import {
  decodeSkillUnitResult,
  packSkillUnitRequest,
  skillUnitMutations,
  type SkillUnitPackage,
  type SkillUnitRequest,
} from "./skill-maintenance-unit.js";

const log = Log.create({ service: "skill-maintenance" });

export interface SkillMaintenanceInput {
  readonly config: SkillStoreConfig;
  readonly units: readonly SkillMaintenanceUnit[];
  /** The complete packages one unit touches, read at the moment it is performed
   *  rather than when the survey ran, so a unit cannot be applied to bytes that
   *  moved underneath it. */
  readonly packagesFor: (unit: SkillMaintenanceUnit) => readonly SkillUnitPackage[];
  readonly maxInstructionBytes: number;
  /** One model request for one unit, answered as the model's raw text. */
  readonly perform: (request: SkillUnitRequest) => Promise<string>;
  readonly audit: (candidate: PreparedPackage, revision: SkillRegistryRevision) => Promise<SkillSemanticAuditResult>;
  readonly record: FactRecorder<SkillWrittenFact>["record"];
  /** Republish the registry after a write, so an archive can see its receiver. */
  readonly reloadRegistry: () => void;
  readonly dryRun?: boolean;
}

interface PerformedUnit {
  readonly kind: "merge" | "repair";
  readonly into: string;
  readonly absorbed: readonly string[];
  readonly references: readonly string[];
  readonly removed: readonly { readonly what: string; readonly why: string }[];
  readonly bodyChars: number;
}

/** A unit the guards would not admit. It wrote nothing. */
interface RefusedUnit {
  readonly unit: string;
  readonly error: string;
}

/** A unit that stopped partway: some of its mutations published, then one
 *  failed. It is not performed and not refused; what landed is real. */
interface PartialUnit {
  readonly unit: PerformedUnit;
  readonly landed: number;
  readonly of: number;
}

export type SkillMaintenanceResult =
  | { readonly kind: "completed"; readonly runId: string; readonly performed: readonly PerformedUnit[]; readonly refused: readonly RefusedUnit[] }
  /** The dry run: every decision made and checked, nothing written. */
  | { readonly kind: "planned"; readonly performed: readonly PerformedUnit[]; readonly refused: readonly RefusedUnit[] }
  | { readonly kind: "nothing-to-do" }
  /** Stopped for a reason that was not about one unit. */
  | { readonly kind: "stopped"; readonly runId: string; readonly performed: readonly PerformedUnit[]; readonly refused: readonly RefusedUnit[]; readonly partial?: PartialUnit; readonly error: string };

/** Plan, audit when the store demands it, and publish one mutation. */
async function applyMutation(
  input: SkillMaintenanceInput,
  origin: SkillWriteOrigin,
  mutation: SkillMutation,
): Promise<{ readonly ok: true } | { readonly ok: false; readonly error: string }> {
  const revision = input.config.registry();
  const planned = planSkillMutation(input.config, origin, mutation);
  if (planned.kind === "refused") return { ok: false, error: planned.error };
  let plan = planned.plan;
  if (plan.semanticAudit?.kind === "required") {
    const admitted = admitSkillMutationPlan(plan, revision, await input.audit(plan.outcome.package, revision));
    if (admitted.kind === "refused") return { ok: false, error: admitted.error };
    plan = admitted.plan;
  }
  const publication = await publishSkillMutation({
    config: input.config,
    origin,
    plan,
    writer: { record: input.record },
    currentRevision: input.config.registry,
  });
  if (publication.kind === "stale" || publication.kind === "refused") return { ok: false, error: publication.error };
  input.reloadRegistry();
  return { ok: true };
}

/** Run one maintenance pass. Never throws: a pass that dies partway must still
 *  be able to say what it wrote. */
export async function runSkillMaintenance(input: SkillMaintenanceInput): Promise<SkillMaintenanceResult> {
  if (input.units.length === 0) return { kind: "nothing-to-do" };

  const runId = randomUUID();
  const performed: PerformedUnit[] = [];
  const refused: RefusedUnit[] = [];
  // The store lets a review change only content it read in this run, and this
  // pass reads every package of every unit it performs. Ids are added as their
  // unit is reached, never before, so a unit cannot write to a package no
  // request ever opened.
  const readSkillIds = new Set<string>();
  const origin = (): SkillWriteOrigin => ({ kind: "review", reviewRunId: runId, loadedSkillIds: readSkillIds });
  // A dry run reports its failures too. Returning a clean plan when a unit
  // could not be produced would hide exactly what the dry run exists to find.
  const stop = (error: string, partial?: PartialUnit): SkillMaintenanceResult => ({ kind: "stopped", runId, performed, refused, ...(partial === undefined ? {} : { partial }), error });

  for (const unit of input.units) {
    const name = unitReceiver(unit);
    const packages = input.packagesFor(unit);
    if (packages.length === 0) return stop(`Unit "${name}" touches no installed package.`);
    for (const entry of packages) readSkillIds.add(entry.id);

    let request: SkillUnitRequest;
    try {
      request = packSkillUnitRequest(unit, packages, input.maxInstructionBytes);
    } catch (error) {
      return stop(error instanceof Error ? error.message : String(error));
    }

    let output: string;
    try {
      output = await input.perform(request);
    } catch (error) {
      return stop(`Unit "${name}" was not performed: ${error instanceof Error ? error.message : String(error)}`);
    }

    const decoded = decodeSkillUnitResult(unit, packages, output);
    // A refused unit wrote nothing, so the next one is unaffected.
    if (decoded.kind === "refused") {
      refused.push({ unit: name, error: decoded.error });
      continue;
    }

    const summary: PerformedUnit = {
      kind: unit.kind,
      into: decoded.into,
      absorbed: decoded.absorb,
      references: decoded.references.map((file) => file.path),
      removed: decoded.removed,
      bodyChars: decoded.bodyChars,
    };
    if (input.dryRun === true) {
      performed.push(summary);
      continue;
    }

    // A receiving package that does not exist yet is created by the first write,
    // so it counts as read once this run authored its bytes.
    readSkillIds.add(decoded.into);
    const mutations = skillUnitMutations(decoded);
    let landed = 0;
    for (const mutation of mutations) {
      const applied = await applyMutation(input, origin(), mutation);
      if (!applied.ok) {
        // Whatever landed before the failure is real and is reported as a
        // partial unit, not as performed: some writes published, one did not.
        return stop(`Unit "${name}" stopped partway: ${applied.error}`, { unit: summary, landed, of: mutations.length });
      }
      landed += 1;
    }
    performed.push(summary);
  }

  if (input.dryRun === true) return { kind: "planned", performed, refused };
  log.info("skill maintenance applied", { runId, units: performed.length, refused: refused.length });
  return { kind: "completed", runId, performed, refused };
}

/** Read the complete packages a unit touches from the live registry. */
export function skillUnitPackages(
  revision: SkillRegistryRevision,
  ids: readonly string[],
  findings: ReadonlyMap<string, readonly string[]>,
  packageOf: (id: string) => PreparedPackage | undefined,
): readonly SkillUnitPackage[] {
  const packages: SkillUnitPackage[] = [];
  for (const id of ids) {
    const definition = revision.skills.get(id);
    const prepared = packageOf(id);
    if (!definition || !prepared) continue;
    packages.push({
      id,
      trigger: definition.trigger,
      body: definition.body,
      dependencies: definition.dependencies,
      references: prepared.files
        .filter((file) => file.path !== SKILL_FILE && file.path.startsWith("references/"))
        .map((file) => ({ path: file.path, content: file.content })),
      findings: findings.get(id) ?? [],
    });
  }
  return packages;
}
