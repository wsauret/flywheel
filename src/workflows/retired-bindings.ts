/** The retired workflow binding, and the conversion of saved workflow files
 *  that still state it, as the step-content cutover designed it.
 *
 *  Before the step-content cutover a workflow file had a `bindings` record,
 *  which joined each graph position to a catalog skill and a handoff type by
 *  name, and an array `steps` that held the graph. Project and account
 *  folders can still hold such a file, including a copy that masks a
 *  built-in workflow. The loader converts it in memory to the `steps` and
 *  `flow` form and keeps each original binding as provenance, so the
 *  identity migration can prove that a paused run from the previous build
 *  names the same policy.
 *
 *  The binding shape here is frozen as the last pre-cutover build decoded
 *  it. A later change to the current step schema must not change it.
 *
 *  Remove after 2027-04-30. */

import { Schema } from "effect";
import { isRecord } from "../infra/record.js";
import { isQualifiedSkillId } from "../infra/skill-id.js";
import { ToolScopingSchema, type ToolScoping } from "../infra/workflow-types.js";
import { ArtifactContractsFrontmatterSchema } from "./artifact-contracts.js";
import { hashDefinition } from "./definition-hash.js";
import { retiredHandoffContract, RETIRED_SPEC_HANDOFF, SHIPPED_PLAN_CONTRACT } from "./retired-handoff-contracts.js";
import type { SkillRegistryRevision } from "./skill-schema.js";
import type { OutputObject } from "./output-contract/grammar.js";
import type { WorkflowStep } from "./retired-step-grammar/schema.js";

/** The briefs that retired with their workflows on 2026-10-16, each mapped
 *  to the id of the workflow that it retired with. A person's model setting
 *  for one of them stays for a workflow file whose brief has the same id. */
export const RETIRED_BRIEFS: ReadonlyMap<string, string> = new Map([
  ["debug.fix", "debug"],
  ["debug.investigate", "debug"],
  ["debug.verify", "debug"],
  ["fly.implement", "implement"],
  ["fly.raindrop-audit", "raindrop-audit"],
  ["fly.spec-create", "implement"],
  ["fly.spec-review", "implement"],
  ["qa.review-fixes", "qa"],
  ["qa.surface-map", "qa"],
  ["qa.test-fix-surface", "qa"],
]);

/** The ids of former step packages, not the skills that a brief composes. */
export const FORMER_STEP_SKILLS: ReadonlySet<string> = new Set([...RETIRED_BRIEFS.keys(), "bench.seed-plan"]);

const REASSESSMENT_HANDOFF = "reassessment-handoff";

const RetiredSkillIdSchema = Schema.NonEmptyString.check(Schema.makeFilter((id) =>
  isQualifiedSkillId(id) || `skill id must be a dot-delimited lowercase slug ([a-z0-9-]): ${JSON.stringify(id)}`));

const RetiredRelativePathSchema = Schema.NonEmptyString.check(Schema.makeFilter((path) =>
  (!path.startsWith("/") && !path.includes("\\") && !path.split("/").some((segment) => segment === "" || segment === "." || segment === ".."))
  || `must be a normalized package-relative path: ${JSON.stringify(path)}`));

/** One authored binding as the last pre-cutover build decoded it. */
const RetiredBindingSchema = Schema.Struct({
  skill: RetiredSkillIdSchema,
  name: Schema.optionalKey(Schema.String),
  handoff: Schema.optionalKey(Schema.String),
  writes: Schema.optionalKey(ArtifactContractsFrontmatterSchema),
  toolScoping: Schema.optionalKey(ToolScopingSchema),
  external: Schema.optionalKey(Schema.Literal(true)),
  arguments: Schema.optionalKey(Schema.Array(Schema.String)),
  artifactRedirect: Schema.optionalKey(Schema.Struct({ fromPath: RetiredRelativePathSchema, toDir: RetiredRelativePathSchema })),
  allowedChildSkills: Schema.optionalKey(Schema.Array(RetiredSkillIdSchema)),
}).check(Schema.makeFilter((binding) => {
  if (binding.external === undefined) {
    return (binding.arguments === undefined && binding.artifactRedirect === undefined && binding.allowedChildSkills === undefined)
      || "arguments, artifactRedirect, and allowedChildSkills need external: true";
  }
  if (binding.handoff === undefined) return "an external binding must name a handoff";
  const children = binding.allowedChildSkills ?? [];
  if (new Set(children).size !== children.length) return "allowedChildSkills must not contain duplicate ids";
  return !children.includes(binding.skill) || "allowedChildSkills must not contain the root skill id";
}));

export type RetiredBinding = typeof RetiredBindingSchema.Type;

const decodeBindingRecord = Schema.decodeUnknownSync(RetiredBindingSchema, { onExcessProperty: "error", errors: "all" });

/** Decode one authored binding strictly, as the last pre-cutover build did,
 *  after it drops the keys that build had already retired: `selfReview`, and
 *  the `ask_user` grant. The provenance record holds what that build
 *  recorded, which had neither. */
export function decodeRetiredBinding(authored: unknown): RetiredBinding {
  if (!isRecord(authored)) return decodeBindingRecord(authored);
  const { selfReview: _selfReview, ...kept } = authored;
  if (!isRecord(kept.toolScoping) || !("ask_user" in kept.toolScoping)) return decodeBindingRecord(kept);
  const { ask_user: _askUser, ...toolScoping } = kept.toolScoping;
  return decodeBindingRecord({ ...kept, toolScoping });
}

/** The hash the last pre-cutover build recorded for one binding: its
 *  canonical record, with the `writes` and `allowedChildSkills` defaults
 *  filled and its id added. */
export function retiredBindingSha256(bindingId: string, binding: RetiredBinding): string {
  return hashDefinition({
    ...binding,
    writes: binding.writes ?? [],
    ...(binding.external ? { allowedChildSkills: binding.allowedChildSkills ?? [] } : {}),
    bindingId,
  }).sha256;
}

/** Rebuild the binding one converted step replaced, from the skill, the
 *  handoff type, and the tool scope it named, and the policy the step
 *  keeps. A current step holds no tool scope, so the caller passes the one
 *  the binding recorded. */
export function retiredBindingOf(step: WorkflowStep, skill: string, handoff: string | undefined, toolScoping: ToolScoping | undefined): RetiredBinding {
  return {
    skill,
    ...(step.name === undefined ? {} : { name: step.name }),
    ...(handoff === undefined ? {} : { handoff }),
    ...(step.writes === undefined ? {} : { writes: step.writes }),
    ...(toolScoping === undefined ? {} : { toolScoping }),
    ...(step.external === undefined ? {} : {
      external: true as const,
      ...(step.external.arguments === undefined ? {} : { arguments: step.external.arguments }),
      ...(step.external.artifactRedirect === undefined ? {} : { artifactRedirect: step.external.artifactRedirect }),
      allowedChildSkills: step.external.allowedChildSkills,
    }),
  };
}

type RawDocument = { readonly [key: string]: unknown };

/** One converted step record, before the current step schema decodes it.
 *  It keeps `writes` as authored and drops the retired policy keys. */
interface ConvertedStep {
  readonly file?: string;
  readonly instructions?: string;
  readonly external?: {
    readonly skill: string;
    readonly arguments?: readonly string[];
    readonly artifactRedirect?: { readonly fromPath: string; readonly toDir: string };
    readonly allowedChildSkills?: readonly string[];
  };
  readonly name?: string;
  readonly dependencies?: readonly string[];
  readonly agents?: readonly string[];
  readonly output?: RetiredOutput;
  readonly writes?: unknown;
  readonly toolScoping?: unknown;
  readonly selfReview?: unknown;
}

/** What a converted step reads in place of a retired handoff type: the path
 *  of the shipped plan contract, or a frozen grammar. */
type RetiredOutput = typeof SHIPPED_PLAN_CONTRACT | OutputObject;

/** One saved file in the current form, with the evidence of what changed. */
export interface RetiredWorkflowConversion {
  readonly document: RawDocument;
  /** The original bindings, keyed by step id, for the identity migration. */
  readonly bindings: ReadonlyMap<string, RetiredBinding>;
  /** Steps whose content is a custom skill package keep that skill's id as
   *  their content id, so the model seat `brief.<skill id>` still applies. */
  readonly contentIds: ReadonlyMap<string, string>;
  /** Every key the conversion changed, for the one warning per file. */
  readonly notes: readonly string[];
}

/** Steps that a `for` node runs after each item, keyed by step id. */
function forFollowUps(flow: readonly unknown[]): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const node of flow) {
    if (isRecord(node) && typeof node.for === "string" && typeof node.then === "string") ids.add(node.then);
  }
  return ids;
}

/** Convert one saved workflow document, or return undefined when it states
 *  no `bindings` and so is already in the current form. Throws with a
 *  message that names the binding at fault when the file cannot convert:
 *  the loader then reports a load error, and the person's file stays as it
 *  is. */
export function convertRetiredWorkflow(raw: RawDocument, skills: SkillRegistryRevision | undefined): RetiredWorkflowConversion | undefined {
  if (!("bindings" in raw)) return undefined;
  const { bindings: rawBindings, steps: rawFlow, ...rest } = raw;
  if (!isRecord(rawBindings)) throw new Error("bindings must be a record of binding id to binding");
  if (!Array.isArray(rawFlow)) throw new Error("a file with bindings keeps its graph in an array steps");
  const reassessing = forFollowUps(rawFlow);
  const bindings = new Map<string, RetiredBinding>();
  const contentIds = new Map<string, string>();
  const notes: string[] = ["bindings became steps", "steps became flow"];
  const reassessSteps = new Set<string>();
  const steps = new Map<string, ConvertedStep>();
  for (const [stepId, value] of Object.entries(rawBindings)) {
    const authored = isRecord(value) ? value : {};
    let binding: RetiredBinding;
    try {
      binding = decodeRetiredBinding(authored);
    } catch (error) {
      throw new Error(`binding "${stepId}": ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
    bindings.set(stepId, binding);
    const isReassess = binding.handoff === REASSESSMENT_HANDOFF && reassessing.has(stepId);
    if (isReassess) reassessSteps.add(stepId);
    steps.set(stepId, convertBinding(stepId, binding, authored, isReassess, skills, contentIds, notes));
  }
  const flow = rawFlow.map((node) => {
    if (!isRecord(node) || typeof node.for !== "string" || typeof node.then !== "string" || !reassessSteps.has(node.then)) return node;
    const { then, ...kept } = node;
    notes.push(`for ${node.for}: "then: ${then}" became "reassess: ${then}"`);
    return { ...kept, reassess: then };
  });
  return { document: { ...rest, steps: Object.fromEntries(steps), flow }, bindings, contentIds, notes };
}

function convertBinding(
  stepId: string,
  binding: RetiredBinding,
  authored: RawDocument,
  reassess: boolean,
  skills: SkillRegistryRevision | undefined,
  contentIds: Map<string, string>,
  notes: string[],
): ConvertedStep {
  const where = `step "${stepId}"`;
  // A converted step states only current keys, so its file earns the one
  // conversion warning. Steps no longer read a tool scope or self-review.
  const policy = authored.writes === undefined ? {} : { writes: authored.writes };
  const retired = ["toolScoping", "selfReview"].filter((key) => authored[key] !== undefined);
  if (retired.length > 0) notes.push(`${where}: the retired ${retired.join(" and ")} ${retired.length === 1 ? "key was" : "keys were"} dropped`);
  // The last pre-cutover build accepted an empty name. A current step name
  // is never empty, so an empty name reads as no name.
  const name = binding.name === "" ? undefined : binding.name;
  // A step in a reassess slot gets the VM's reassessment contract, so it
  // states no output of its own.
  const output = reassess ? undefined : retiredOutput(stepId, binding.handoff, notes);
  if (reassess) notes.push(`${where}: ${REASSESSMENT_HANDOFF} became the reassess slot's contract`);
  if (binding.external) {
    notes.push(`${where}: the external binding became an external step`);
    return {
      external: {
        skill: binding.skill,
        ...(binding.arguments === undefined ? {} : { arguments: binding.arguments }),
        ...(binding.artifactRedirect === undefined ? {} : { artifactRedirect: binding.artifactRedirect }),
        ...(binding.allowedChildSkills === undefined ? {} : { allowedChildSkills: binding.allowedChildSkills }),
      },
      name: name ?? binding.skill,
      ...(output === undefined ? {} : { output }),
      ...policy,
    };
  }
  if (FORMER_STEP_SKILLS.has(binding.skill)) {
    throw new Error(`${where} names the former step skill "${binding.skill}", which Flywheel no longer ships`);
  }
  const pkg = skills?.skills.get(binding.skill);
  if (!pkg) throw new Error(`${where} names skill "${binding.skill}", which is not installed`);
  contentIds.set(stepId, pkg.id);
  notes.push(`${where}: the body of skill ${pkg.id} became its instructions`);
  return {
    instructions: pkg.body,
    name: name ?? pkg.name,
    ...(pkg.dependencies.length === 0 ? {} : { dependencies: pkg.dependencies }),
    ...(pkg.agents.length === 0 ? {} : { agents: pkg.agents }),
    ...(output === undefined ? {} : { output }),
    ...policy,
  };
}

/** The output a converted step reads in place of a retired handoff type. */
function retiredOutput(stepId: string, handoff: string | undefined, notes: string[]): RetiredOutput | undefined {
  if (handoff === undefined) return undefined;
  const where = `step "${stepId}"`;
  if (handoff === RETIRED_SPEC_HANDOFF) {
    notes.push(`${where}: handoff ${handoff} became output ${SHIPPED_PLAN_CONTRACT}`);
    return SHIPPED_PLAN_CONTRACT;
  }
  const contract = retiredHandoffContract(handoff);
  if (contract === undefined) throw new Error(`${where} names handoff type "${handoff}", which never existed`);
  notes.push(`${where}: handoff ${handoff} became its frozen output contract`);
  if (handoff === "review-handoff") notes.push(`${where}: blocking_findings is now a list the step fills, not one Flywheel derives`);
  if (handoff === "definition-improvement-proposal") notes.push(`${where}: no lane records definition-improvement proposals from this output any more`);
  return contract;
}

/** C3: a project or account skill that still uses the id of a former step
 *  skill. Before the cutover it replaced the bundled step; now Flywheel
 *  ships no such brief, so the package changes nothing. One message for
 *  each such package, naming where it is installed. */
export function formerStepSkillWarnings(skills: SkillRegistryRevision): readonly string[] {
  return [...skills.skills.values()].flatMap((skill) => FORMER_STEP_SKILLS.has(skill.id)
    ? [`Skill "${skill.id}" (${skill.source.kind === "filesystem" ? skill.source.packageDir : "bundled"}) has the id of a former workflow step. Flywheel no longer ships this brief. Write your own workflow brief to replace it.`]
    : []);
}
