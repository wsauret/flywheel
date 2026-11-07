import type { CapabilityCheck } from "../../../infra/capability-text.js";
import { errorMessage } from "../../../infra/error-message.js";
import type { PersonaMetadataIndex } from "../../../workflows/agents/persona-schema.js";
import { readSkillResource, renderSkillResourceWindow, type SkillResourceWindow } from "../../../workflows/skill-context.js";
import { assembleSkillInvocation, skillInvocationRefusal } from "../../../workflows/skill-invocation.js";
import type { SkillDefinition, SkillRegistryRevision } from "../../../workflows/skill-schema.js";
import type { DefinitionAvailabilitySnapshot } from "../../app-service/definition-availability.js";
import type { AdvertisedTool, RuntimeTool, RuntimeToolInput, ToolContext, ToolResult } from "./types.js";
import { formatToolInputProblems, validateToolInput } from "./validate-input.js";
import { withPackageRead } from "../../../infra/package-directory-lock.js";

/** How many ids an unknown-skill_id error names. The complete catalog is already
 *  in the prompt, so the error is a nudge back to it, not a listing surface. */
const UNKNOWN_ID_CANDIDATES = 20;

/** A package resource is third-party content of any size, so one call returns
 *  at most one window of it. The window is enforced at read time against the
 *  opened file, and a larger resource is paged through `offset` rather than
 *  handed to any other tool: a declared resource is only ever readable inside
 *  the package containment checks. */
const RESOURCE_WINDOW_BYTES = 64_000;

const BASE_DESCRIPTION = `Read installed skill packages. A skill is an authored package of instructions, plus optional files, for one kind of work. The complete catalog of installed skills sits in your system prompt as \`id: trigger\` rows.

- action:"load": return one skill's instructions verbatim, with its reach, source, write ownership, version, and content and package identities.
- action:"resource": return one file that the loaded skill declares, one ${RESOURCE_WINDOW_BYTES}-byte window at a time.
- action:"child-run": execute exactly one granted child package script with JSON input and output. Only an agent whose work grants a child skill can run it; any other call is refused.

Load and resource are read-only. Loading a skill does not activate it; you carry out its instructions yourself in this conversation.`;

const SCAN_THEN_LOAD_GUIDANCE = 'Scan the skill triggers before you start work and again whenever the work changes mode. A trigger is a pointer, never enough to act on: when one matches the work in front of you, call skill with action:"load" first and follow the loaded instructions, because the skill defines how that work is done here. A skill whose context already appears in this conversation (its `# Skill: <id>` block) needs no repeat load to follow it; load it again only when a tool refusal asks for that load. Read a file the instructions name with action:"resource".';

const INPUT_SCHEMA = {
  type: "object",
  properties: {
    action: {
      type: "string",
      enum: ["load", "resource", "child-run"],
      description: "load: return instructions. resource: return a declared file. child-run: execute a granted child package script with structured input.",
    },
    skill_id: {
      type: "string",
      description: "Skill package id, exactly as advertised in the catalog. Required for every action.",
    },
    path: {
      type: "string",
      description: "Package-relative resource path, exactly as listed by load. Required for resource.",
    },
    offset: {
      type: "number",
      description: "0-based byte offset for action:resource. Default 0. A resource larger than one window reports the offset to call next.",
    },
    script: { type: "string", description: "Declared executable resource path. Required for child-run." },
    input: { description: "JSON-compatible structured input passed to the child script. Required for child-run." },
  },
  required: ["action"],
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
  /** Definition availability of this agent's own module selection. A load
   *  that the agent check refuses names the modules its entry lacks. */
  readonly availability: Pick<DefinitionAvailabilitySnapshot, "skills">;
  /** Personas the loaded skill may dispatch, rendered as a catalog for this
   *  agent's own `subagent` tool. */
  readonly personaIndex: PersonaMetadataIndex;
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
  promptSnippet: "Load an installed skill package's instructions or files",
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
    promptGuidelines: buildPromptGuidelines(catalog),
    execute: async (input, context) => executeSkill(deps, catalog, input, context),
  };
}

function buildPromptGuidelines(catalog: readonly SkillDefinition[]): readonly string[] {
  const lines = catalog.map((skill) => `- ${skill.id}: ${skill.trigger}`);
  return [
    `Installed skills, trigger descriptions only:\n${lines.join("\n")}`,
    SCAN_THEN_LOAD_GUIDANCE,
  ];
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
      return skill.source.kind === "filesystem"
        ? withPackageRead(skill.source.canonicalDir, load)
        : load();
    });
  }
  if (input.action === "resource") {
    return withSkill(deps, catalog, context, input.skill_id, (skill) => readResource(skill, input.path, input.offset));
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
  // An entry with a reason lacks a module of the skill's closure; an available entry is refused only when the
  // skill or a dependency dispatches agents and this agent cannot call the subagent tool.
  const reason = (has(`skill:${invocable.id}`) ? undefined : deps.availability.skills.get(invocable.id)?.reason)
    ?? skillInvocationRefusal(invocable, deps.revision, has);
  if (reason) return { content: `Skill "${invocable.id}" is unavailable: ${reason}.`, outcome: "error" };
  return use(invocable, has);
}

/** The one direct-invocation assembly: a slash command renders the same text, so
 *  a skill reads identically however it was selected. */
function loadSkill(deps: SkillToolDeps, revision: SkillRegistryRevision, skill: SkillDefinition, has: CapabilityCheck): ToolResult {
  return {
    content: assembleSkillInvocation(skill, undefined, { skills: revision, personaIndex: deps.personaIndex, capabilities: has }),
    outcome: "ok",
  };
}

function readResource(skill: SkillDefinition, pathInput: unknown, offsetInput: unknown): ToolResult {
  const declared = skill.resources.find((resource) => resource.path === pathInput);
  if (!declared) {
    const paths = skill.resources.map((resource) => resource.path).join(", ");
    return {
      content: `Skill "${skill.id}" does not declare resource ${JSON.stringify(pathInput)}. Declared resources: ${paths || "(none)"}.`,
      outcome: "error",
    };
  }
  // Validation already admitted only a non-negative whole byte offset.
  const offset = typeof offsetInput === "number" ? offsetInput : 0;

  let resourceWindow: SkillResourceWindow;
  try {
    resourceWindow = readSkillResource(skill, declared.path, offset, RESOURCE_WINDOW_BYTES);
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
