import type { CapabilityCheck } from "../../../../infra/capability-text.js";
import { errorMessage } from "../../../../infra/error-message.js";
import { offeredSkillResources, readSkillResource, type SkillResourceWindow } from "../../../../workflows/skills/skill-context.js";
import { renderSkillResourceWindow } from "../../../../workflows/skills/skill-render.js";
import { assembleSkillInvocation, skillInvocationRefusal } from "../../../../workflows/skills/skill-invocation.js";
import type { SkillDefinition, SkillRegistryRevision } from "../../../../workflows/skills/skill-schema.js";
import type { DefinitionAvailabilitySnapshot } from "../../../app-service/definition-availability.js";
import type { AdvertisedTool, RuntimeTool, RuntimeToolInput, ToolContext, ToolResult } from "../types.js";
import { formatToolInputProblems, validateToolInput } from "../input/validate-input.js";
import { withPackageRead } from "../../../../infra/package-directory-lock.js";

/** How many ids an unknown-skill_id error names. The complete catalog is already
 *  in the prompt, so the error is a nudge back to it, not a listing surface. */
const UNKNOWN_ID_CANDIDATES = 20;

/** A package resource is third-party content of any size, so one call returns
 *  at most one window of it. The window is enforced at read time against the
 *  opened file, and a larger resource is paged through `offset` rather than
 *  handed to any other tool: a declared resource is only ever readable inside
 *  the package containment checks. */
const RESOURCE_WINDOW_BYTES = 64_000;

const BASE_DESCRIPTION = `Read an installed skill: instructions, plus optional files, for one kind of work.

- action:"load": return the skill's instructions. Loading does not run the skill; you follow its instructions yourself.
- action:"resource": return one file that the loaded skill declares, one window at a time.
- action:"child-run": run one script of a child skill that your work grants, with JSON input and output.`;

const SCAN_THEN_LOAD_GUIDANCE = 'Scan the skill triggers before you start work and again whenever the work changes mode. A trigger is a pointer, never enough to act on: when one matches the work, load the skill with action:"load" first and follow it, because it defines how that work is done here. A skill whose `# Skill: <id>` block is already in this conversation needs no load, unless a tool refusal asks for one.';

const INPUT_SCHEMA = {
  type: "object",
  properties: {
    action: {
      type: "string",
      enum: ["load", "resource", "child-run"],
    },
    skill_id: {
      type: "string",
      description: "Skill id, exactly as the catalog lists it.",
    },
    path: {
      type: "string",
      description: "Resource path, exactly as load lists it. Required for resource.",
    },
    offset: {
      type: "number",
      description: "Byte offset for resource. Default 0.",
    },
    script: { type: "string", description: "Granted script path. Required for child-run." },
    input: { description: "JSON input for the script. Required for child-run." },
  },
  required: ["action", "skill_id"],
} as const;

interface StringListsByName {
  [name: string]: readonly string[];
}

interface NumbersByName {
  [name: string]: number;
}

/** The controls each action accepts. Anything else is a model-visible refusal,
 *  so no action silently ignores a parameter meant for another one. */
const ACTION_CONTROLS: StringListsByName = {
  load: ["skill_id"],
  resource: ["skill_id", "path", "offset"],
  "child-run": ["skill_id", "script", "input"],
};

/** Smallest accepted value of each range control. */
const RANGE_MINIMUMS: NumbersByName = { offset: 0 };

export interface ExternalSkillChildRunInput {
  readonly skillId: string;
  readonly script: string;
  readonly input: unknown;
}

export interface ExternalSkillChildRunResult {
  readonly skillId: string;
  readonly output: unknown;
}

export interface ExternalSkillChildGrant {
  readonly skillIds: readonly string[];
  run(input: ExternalSkillChildRunInput): Promise<ExternalSkillChildRunResult>;
}

export interface SkillToolDeps {
  /** Complete skill revision advertised by this request. Load and resource calls
   *  resolve only from this revision, even after the registry publishes newer definitions. */
  readonly revision: SkillRegistryRevision;
  /** The tree check (ARCH-CONTEXT-033). The catalog lists a model-invocable
   *  skill only while `skill:<id>` holds, so every agent of a chat tree
   *  advertises the same rows. */
  readonly treeCapabilities: CapabilityCheck;
  /** Definition availability of this agent's own module selection and configuration. A load that the agent check
   *  refuses names what its entry lacks, and a loaded skill names the personas it may dispatch from the available
   *  ones, as a catalog for this agent's own `subagent` tool. */
  readonly availability: Pick<DefinitionAvailabilitySnapshot, "skills" | "availablePersonas">;
  /** Records a successful body load before the load leaves its shared hold on
   *  the package, so a writer that archives the package sees the load. */
  readonly onLoad?: (skill: SkillDefinition) => void | Promise<void>;
  /** Per-attempt authority for child package scripts: captured external
   *  packages in an agent of a workflow, or the bundled experiment finalizer. */
  readonly childGrant?: ExternalSkillChildGrant;
}

/** The skill tool as an agent with no skill revision sees it. Its catalog
 *  guidelines are absent, because they render the revision. Every agent of a
 *  chat tree shares one agent host keyed by the tool list byte for byte, so
 *  the description never varies per agent: a child grant narrows only at
 *  execution, and the skill that grants a child script names it. */
export const SKILL_TOOL_DEFINITION: AdvertisedTool = {
  name: "skill",
  action: "ui_meta",
  description: BASE_DESCRIPTION,
  inputSchema: INPUT_SCHEMA,
  // Validation is per action: a parameter meant for the other action is a
  // model-visible refusal, which the central schema validator cannot express.
  validatesOwnInput: true,
  // Skill bodies are author-bounded package text, like briefs:
  // head+tail truncation would corrupt the procedure instead of trimming
  // noise. Resource output is bounded by the read window instead.
  uncappedOutput: true,
  isConcurrencySafe: true,
};

export function createSkillTool(deps: SkillToolDeps): RuntimeTool {
  const catalog = deps.revision.modelInvocable.filter((skill) => deps.treeCapabilities(`skill:${skill.id}`));
  return {
    ...SKILL_TOOL_DEFINITION,
    ...(catalog.length > 0 ? { promptCatalog: `Installed skills:\n${catalog.map((skill) => `- ${skill.id}: ${skill.trigger}`).join("\n")}` } : {}),
    promptGuidelines: [SCAN_THEN_LOAD_GUIDANCE],
    execute: async (input, context) => executeSkill(deps, catalog, input, context),
  };
}

async function executeSkill(deps: SkillToolDeps, catalog: readonly SkillDefinition[], input: RuntimeToolInput, context: ToolContext): Promise<ToolResult> {
  const problems = validateSkillInput(input);
  if (problems.length > 0) return { content: formatToolInputProblems("skill", problems), outcome: "error" };

  const revision = deps.revision;

  if (input.action === "load") {
    return withSkill(deps, catalog, context, input.skill_id, async (skill, has) => {
      const load = async (): Promise<ToolResult> => {
        const result = loadSkill(deps, revision, skill, has);
        await deps.onLoad?.(skill);
        return result;
      };
      // Writers lock only a package that is in an owned store and not linked (resolveWritable). Any other package is
      // read without the shared hold, which would create a `.locks` folder beside a package that may be read-only.
      return skill.source.kind === "filesystem" && skill.source.owned && !skill.source.linked
        ? withPackageRead(skill.source.canonicalDir, load)
        : load();
    });
  }
  if (input.action === "resource") {
    return withSkill(deps, catalog, context, input.skill_id, (skill, has) => readResource(skill, input.path, input.offset, has));
  }
  if (!deps.childGrant) return { content: 'action:"child-run" is unavailable to this agent now: no child skill is granted to it. Do not call it again.', outcome: "error" };
  if (typeof input.skill_id !== "string" || !deps.childGrant.skillIds.includes(input.skill_id)) {
    return { content: `Child skill ${JSON.stringify(input.skill_id)} is not granted. Granted child skills: ${deps.childGrant.skillIds.join(", ") || "(none)"}.`, outcome: "error" };
  }
  try {
    const result = await deps.childGrant.run({ skillId: String(input.skill_id), script: String(input.script), input: input.input });
    return { content: JSON.stringify(result), outcome: "ok" };
  } catch (err) {
    return { content: errorMessage(err), outcome: "error" };
  }
}

/** Complete validation of one call: the executable schema, then the controls
 *  the named action accepts, then the range each control has to stay inside. */
function validateSkillInput(input: RuntimeToolInput): string[] {
  const structural = validateToolInput(input, INPUT_SCHEMA);
  if (structural.length > 0) return structural;

  const action = String(input.action);
  const accepted = ACTION_CONTROLS[action] ?? [];
  const problems: string[] = [];
  for (const key of Object.keys(input)) {
    if (key === "action" || accepted.includes(key)) continue;
    problems.push(`The parameter \`${key}\` is not accepted by action:"${action}"`);
  }
  for (const [key, minimum] of Object.entries(RANGE_MINIMUMS)) {
    const value = input[key];
    if (value === undefined || !accepted.includes(key)) continue;
    if (typeof value !== "number" || !Number.isInteger(value) || value < minimum) {
      problems.push(`The parameter \`${key}\` is expected as an integer of at least ${minimum} but provided as ${String(value)}`);
    }
  }
  return problems;
}

/** Resolve one id against the revision. A package the model may not invoke is
 *  unavailable to it, exactly like an id that is not installed. An installed
 *  package that the agent check refuses (ARCH-STRUCTURE-031) is refused with
 *  the reason, so the agent can tell the person which module to turn on. */
async function withSkill(
  deps: SkillToolDeps,
  catalog: readonly SkillDefinition[],
  context: ToolContext,
  skillId: unknown,
  use: (skill: SkillDefinition, has: CapabilityCheck) => ToolResult | Promise<ToolResult>,
): Promise<ToolResult> {
  const invocable = typeof skillId === "string"
    ? deps.revision.modelInvocable.find((candidate) => candidate.id === skillId)
    : undefined;
  if (!invocable) {
    const available = catalog.slice(0, UNKNOWN_ID_CANDIDATES).map((candidate) => candidate.id).join(", ");
    return {
      content: `Unknown or unavailable skill_id ${JSON.stringify(skillId)}. Installed skills: ${available || "(none)"}. The complete catalog is in your system prompt.`,
      outcome: "error",
    };
  }
  // Every agent loop sets the agent check; only a context built without a request surface lacks it.
  const has = context.capabilities;
  if (!has) throw new Error("the skill tool loads a package only inside a request that carries the agent capability check");
  // An entry with a reason lacks a module of the skill's closure; an available entry is refused when the skill or a
  // dependency dispatches agents and this agent cannot call the subagent tool, or when the agent check refuses the
  // skill because it declares agents outside this agent's dispatch set.
  const held = has(`skill:${invocable.id}`);
  const reason = (held ? undefined : deps.availability.skills.get(invocable.id)?.reason)
    ?? skillInvocationRefusal(invocable, deps.revision, has)
    ?? (held ? undefined : "it dispatches agents that the agent that reads it may not dispatch");
  if (reason) return { content: `Skill "${invocable.id}" is unavailable: ${reason}.`, outcome: "error" };
  return use(invocable, has);
}

/** The one direct-invocation assembly: a slash command renders the same text, so
 *  a skill reads identically however it was selected. */
function loadSkill(deps: SkillToolDeps, revision: SkillRegistryRevision, skill: SkillDefinition, has: CapabilityCheck): ToolResult {
  return {
    content: assembleSkillInvocation(skill, undefined, { skills: revision, agents: deps.availability.availablePersonas, capabilities: has }),
    outcome: "ok",
  };
}

/** One window of a resource that the loaded skill offers to this agent (`offeredSkillResources`). */
function readResource(skill: SkillDefinition, pathInput: unknown, offsetInput: unknown, has: CapabilityCheck): ToolResult {
  const offered = offeredSkillResources(skill, has);
  const declared = offered.find((resource) => resource.path === pathInput);
  if (!declared) {
    const paths = offered.map((resource) => resource.path).join(", ");
    return {
      content: `Skill "${skill.id}" does not declare resource ${JSON.stringify(pathInput)}. Declared resources: ${paths || "(none)"}.`,
      outcome: "error",
    };
  }
  // Validation already admitted only a non-negative whole byte offset.
  const offset = typeof offsetInput === "number" ? offsetInput : 0;

  let resourceWindow: SkillResourceWindow;
  try {
    resourceWindow = readSkillResource(skill, declared.path, offset, RESOURCE_WINDOW_BYTES, has);
  } catch (err) {
    return { content: errorMessage(err), outcome: "error" };
  }

  const end = resourceWindow.endOffset;
  const remainder = end < resourceWindow.totalBytes
    ? `\n\nBytes ${end}-${resourceWindow.totalBytes} of this resource are not shown. Call skill again with action:"resource" and offset:${end}.`
    : "";
  // The paging note is Flywheel's own instruction, so it stays outside the
  // frame the package's own bytes are rendered in.
  return {
    content: `${renderSkillResourceWindow(skill, declared.path, resourceWindow, offset)}${remainder}`,
    outcome: "ok",
  };
}
