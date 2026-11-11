/** Build Flywheel's Claude plugin from the prompt sources that this release bundles.
 *
 *  The plugin makes Flywheel's chat agent the main agent of the host (`settings.json` names it), and ships each
 *  bundled skill and persona whose text the host can honor as a plugin skill or agent. It reads only bundled
 *  sources: the skill packages, the shared references, the personas, the engineering doctrine, the chat body, and
 *  package.json. It never reads AGENTS.md, memory, user or project overlays, or configuration, so the plugin is the
 *  same on every machine that builds one revision.
 *
 *  A skill or persona is left out when it drives Flywheel's own runtime, when its text names a Flywheel tool that
 *  the host lacks, or when it composes a skill or names a persona that is left out. Each exclusion is reported
 *  with its reason.
 *
 *  Usage:
 *    bun run build:claude-plugin                       # writes dist/claude-plugin/ and the release zip in dist/
 *    bun run build:claude-plugin --out <dir> [--zip <file>]
 *    bun run build:claude-plugin --marketplace <owner/repo>
 *                                  # also pins the zip in .claude-plugin/marketplace.json as that repository's release
 */

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import * as yaml from "js-yaml";

import { Log } from "../src/infra/log.js";
import { isRecord } from "../src/infra/record.js";
import { renderCapabilityText, type CapabilityCheck } from "../src/infra/capability-text.js";
import { parentRoleId } from "../src/orchestration/config/roles.js";
import { renderModelChatBody } from "../src/orchestration/agent-runtime/model-chat-body.js";
import { resolveModelInteractionProfile } from "../src/orchestration/agent-runtime/model-interaction-profile.js";
import { SYSTEM_PROMPT_SEPARATOR } from "../src/orchestration/agent-runtime/llm/system-prompt-tiers.js";
import { personaToolEntries } from "../src/orchestration/agent-runtime/tools/tool-registry.js";
import { roleModelDefault, ROLE_MODEL_DEFAULTS } from "../src/orchestration/config/role-model-defaults.js";
import { SHIPPED_MODULES } from "../src/orchestration/modules.js";
import { createToolRegistry } from "../src/orchestration/tool-catalog.js";
import type { AgentDefinition } from "../src/infra/agent-definition.js";
import { loadStandalonePersonaRegistry } from "../src/workflows/agents/registry.js";
import { resolveSkillClosure } from "../src/workflows/skill-closure.js";
import { resolveSkillBody } from "../src/workflows/skill-references.js";
import { publishSkillRevision, type SkillDefinition } from "../src/workflows/skill-schema.js";
import { BUNDLED_SKILL_DIR } from "../src/workflows/skill-source-inventory.js";
import { loadSkillDefinitions } from "../src/workflows/skills.js";
import { CLAUDE_MARKETPLACE_FILE, CLAUDE_PLUGIN, CLAUDE_PLUGIN_ARCHIVE, claudeMarketplace } from "./release-contract.js";
import { CLAUDE_PLUGIN_HOST, HOST_REWRITES, NATIVE_TOOLS, qualifyPluginNames, translateForHost } from "./claude-plugin-host.js";
import { zipArchive } from "./zip-archive.js";

const ROOT = join(import.meta.dir, "..");
const PERSONA_DIR = join(ROOT, "src", "workflows", "agents", "personas");
const DOCTRINE = join(ROOT, "src", "infra", "agent-assets", "engineering-doctrine.md");

/** Methods that drive Flywheel's own runtime: its publication delegate. The host has none of it, so the
 *  plugin leaves them out. A method that only one module runs ships in that module's definition bundle, which
 *  the plugin never reads. */
const RUNTIME_SKILLS: ReadonlyMap<string, string> = new Map([
  ["ship", "it is the method of Flywheel's publication delegate"],
]);
const RUNTIME_PERSONAS: ReadonlyMap<string, string> = new Map([
  ["ship", "it publishes through Flywheel's delegation and handoff contract"],
]);

/** The chat blocks of the chat body that the main agent carries: the body of Flywheel's default chat model. */
const CHAT_GUIDANCE = resolveModelInteractionProfile(ROLE_MODEL_DEFAULTS.chat.anthropic.model, "anthropic").modelGuidance?.chat;
/** The model families that the host names by alias; any other model goes by its full id. */
const MODEL_ALIASES = ["opus", "sonnet", "haiku"] as const;

export interface Exclusion {
  readonly kind: "skill" | "agent";
  readonly id: string;
  readonly reason: string;
}

export interface ClaudePlugin {
  /** Every plugin file, keyed by forward-slash path relative to the plugin root. */
  readonly files: ReadonlyMap<string, string>;
  readonly exclusions: readonly Exclusion[];
}

type Persona = Extract<AgentDefinition, { kind: "persona" }>;

function frontmatter(fields: { readonly [key: string]: unknown }, body: string): string {
  return `---\n${yaml.dump(fields, { lineWidth: -1 })}---\n\n${body.trim()}\n`;
}

/** The Flywheel tools that `text` still names after translation for the host: a backticked tool name, a tool name
 *  with an underscore anywhere, or "<name> tool" in prose. A tool that the host serves never remains, because the
 *  translation writes it as the host's tool. */
function flywheelOnlyTools(text: string, registered: readonly string[]): readonly string[] {
  return registered.filter((name) => !NATIVE_TOOLS.has(name)
    && (text.includes(`\`${name}\``) || new RegExp(name.includes("_") ? `\\b${name}\\b` : `\\b${name} tool\\b`).test(text)));
}

/** A Flywheel model id as the host names it: `claude-opus-5.5` is `opus`, and `claude-fable-5.1` is its API id. */
function hostModel(model: string): string {
  return MODEL_ALIASES.find((alias) => model.startsWith(`claude-${alias}-`)) ?? model.replaceAll(".", "-");
}

/** The plugin's skill body in Flywheel's words: the body of every composed dependency, then the skill's own, as
 *  Flywheel composes a skill invocation, and the agents it dispatches. */
function skillBody(skill: SkillDefinition, closure: readonly SkillDefinition[]): string {
  const sections: string[] = [];
  const dependencies = closure.slice(0, -1);
  if (dependencies.length > 0) {
    sections.push(`# Composed skills\n\nThese skills are part of this skill and are in your context in full: ${dependencies.map(({ id }) => `\`${id}\``).join(", ")}. Do not load them with the \`skill\` tool.`);
    for (const dependency of dependencies) sections.push(`# Skill: ${dependency.id}\n\n${resolveSkillBody(dependency).trim()}`);
  }
  sections.push(resolveSkillBody(skill).trim());
  if (skill.agents.length > 0) {
    sections.push(`## Available Agents\n\nDispatch these agents with the \`subagent\` tool where the skill body calls for agent dispatch: ${skill.agents.map((name) => `\`${name}\``).join(", ")}.`);
  }
  if (skill.directOutput !== undefined) sections.push(`## Direct Result\n\n${skill.directOutput}`);
  return sections.join("\n\n");
}

/** The native tools of a persona: the host's tools for each Flywheel tool that Flywheel grants it. */
function personaTools(persona: Persona): readonly string[] {
  return [...new Set(persona.tools.flatMap((identity) => NATIVE_TOOLS.get(identity)?.tools ?? []))];
}

/** Compose the plugin from the bundled sources. `version` is the release version that plugin.json states. */
export function buildClaudePlugin(version: string, author: string): ClaudePlugin {
  const load = loadSkillDefinitions({ roots: [{ authority: "bundled", dir: BUNDLED_SKILL_DIR, reach: "global", sourceKind: "agent" }] });
  const revision = publishSkillRevision(1, load.skills, load.bundledCorpus);
  const registry = createToolRegistry(SHIPPED_MODULES);
  const personas = [...loadStandalonePersonaRegistry(PERSONA_DIR, revision, personaToolEntries(registry)).values()]
    .filter((definition): definition is Persona => definition.kind === "persona");
  const skills = [...revision.skills.values()];
  const closures = new Map(skills.map((skill) => [skill.id, resolveSkillClosure([skill.id], revision, `Skill "${skill.id}"`)]));
  const registered = [...new Set([...registry.values()].map(({ tool }) => tool))];
  const skillSource = new Map(skills.map((skill) => [skill.id, skillBody(skill, closures.get(skill.id) ?? [])]));
  const skillIds = new Set(skills.map(({ id }) => id));
  const personaNames = new Set(personas.map(({ name }) => name));

  const excluded = new Map<string, Exclusion>();
  const isExcluded = (kind: Exclusion["kind"], id: string): boolean => excluded.has(`${kind}:${id}`);
  // The host serves its native tools, and the plugin's skills and agents while the export keeps them. Every
  // exported text renders its capability markers through this one check, so no marker and no passage about a
  // capability that the host lacks, such as workflow files, reaches the plugin.
  const has: CapabilityCheck = (term) => {
    if (term.startsWith("skill:")) return NATIVE_TOOLS.has("skill") && skillIds.has(term.slice("skill:".length)) && !isExcluded("skill", term.slice("skill:".length));
    if (term.startsWith("persona:")) return NATIVE_TOOLS.has("subagent") && personaNames.has(term.slice("persona:".length)) && !isExcluded("agent", term.slice("persona:".length));
    // An agent type holds while the plugin exports one of its personas, as it holds in Flywheel while one is available.
    if (term.startsWith("type:")) {
      const type = term.slice("type:".length);
      return NATIVE_TOOLS.has("subagent") && personas.some((persona) => (persona.role === type || parentRoleId(persona.role) === type) && !isExcluded("agent", persona.name));
    }
    return NATIVE_TOOLS.has(term);
  };
  const rendered = (source: string): string => renderCapabilityText(source, has);

  interface Unit {
    readonly kind: Exclusion["kind"];
    readonly id: string;
    readonly runtime: string | undefined;
    /** The unit's text in Flywheel's words, with its capability markers. */
    readonly source: string;
    readonly composes: readonly string[];
    readonly dispatches: readonly string[];
  }
  /** The unit's text as the host reads it for the current exclusions, before plugin names are qualified. */
  const draft = (unit: Unit): string => translateForHost(rendered(unit.source), new Set());
  const units: readonly Unit[] = [
    ...skills.map((skill): Unit => ({
      kind: "skill", id: skill.id, runtime: RUNTIME_SKILLS.get(skill.id), source: skillSource.get(skill.id) ?? "", composes: skill.dependencies, dispatches: skill.agents,
    })),
    ...personas.map((persona): Unit => ({
      kind: "agent", id: persona.name, runtime: RUNTIME_PERSONAS.get(persona.name), source: `${persona.description}\n\n${persona.systemPrompt}`, composes: persona.requiredSkills ?? [], dispatches: [],
    })),
  ];
  const reason = (unit: Unit): string | undefined => {
    if (unit.runtime !== undefined) return unit.runtime;
    const text = draft(unit);
    const lacked = flywheelOnlyTools(text, registered);
    if (lacked.length > 0) return `its text names ${lacked.join(", ")}, which the host lacks`;
    const left = [
      ...unit.composes.filter((id) => isExcluded("skill", id)).map((id) => `it composes ${id}`),
      ...unit.dispatches.filter((id) => isExcluded("agent", id)).map((id) => `it dispatches ${id}`),
      ...[...excluded.values()].filter(({ id }) => text.includes(`\`${id}\``)).map(({ id }) => `its text names ${id}`),
    ];
    return left.length === 0 ? undefined : `${left[0]}, which is left out`;
  };
  // An exclusion can exclude what composes, dispatches, or names it, so the exclusions settle in rounds. Each round
  // renders the texts again, because an exclusion also drops the passages that the check conditions on it.
  for (let changed = true; changed;) {
    changed = false;
    for (const unit of units) {
      if (isExcluded(unit.kind, unit.id)) continue;
      const why = reason(unit);
      if (why === undefined) continue;
      excluded.set(`${unit.kind}:${unit.id}`, { kind: unit.kind, id: unit.id, reason: why });
      changed = true;
    }
  }

  const exported = skills.filter((skill) => !isExcluded("skill", skill.id));
  const exportedPersonas = personas.filter((persona) => !isExcluded("agent", persona.name));
  const pluginNames = new Set([...exported.map(({ id }) => id), ...exportedPersonas.map(({ name }) => name)]);
  const rewritten = new Set<string>();
  const hostText = (text: string): string => qualifyPluginNames(translateForHost(text, rewritten), CLAUDE_PLUGIN.name, pluginNames);
  const files = new Map<string, string>();
  files.set(".claude-plugin/plugin.json", `${JSON.stringify({ name: CLAUDE_PLUGIN.name, version, description: CLAUDE_PLUGIN.description, author: { name: author } }, null, 2)}\n`);
  files.set("settings.json", `${JSON.stringify({ agent: CLAUDE_PLUGIN.name }, null, 2)}\n`);
  if (CHAT_GUIDANCE === undefined) throw new Error(`The default chat model ${ROLE_MODEL_DEFAULTS.chat.anthropic.model} has no chat guidance entry`);
  const chatBody = renderModelChatBody(CHAT_GUIDANCE, has, CLAUDE_PLUGIN_HOST);
  files.set(`agents/${CLAUDE_PLUGIN.name}.md`, frontmatter(
    { name: CLAUDE_PLUGIN.name, description: CLAUDE_PLUGIN.description },
    hostText([chatBody, rendered(readFileSync(DOCTRINE, "utf8")).trim()].join(SYSTEM_PROMPT_SEPARATOR)),
  ));
  for (const persona of exportedPersonas) {
    files.set(`agents/${persona.name}.md`, frontmatter({
      name: persona.name,
      description: hostText(rendered(persona.description)),
      tools: personaTools(persona).join(", "),
      model: hostModel(roleModelDefault(persona.role).anthropic.model),
      ...(persona.requiredSkills === undefined ? {} : { skills: persona.requiredSkills }),
    }, hostText(rendered(persona.systemPrompt))));
  }
  for (const skill of exported) {
    // A skill that Flywheel keeps from the model stays invocable here: the host preloads an agent's skills only
    // when the model may invoke them.
    files.set(`skills/${skill.id}/SKILL.md`, frontmatter({ name: skill.id, description: skill.trigger }, hostText(rendered(skillSource.get(skill.id) ?? ""))));
  }
  const stale = [...HOST_REWRITES.keys()].filter((phrase) => !rewritten.has(phrase));
  if (stale.length > 0) throw new Error(`No exported text holds the phrase "${stale[0]}" that the host rewrites: update HOST_REWRITES for the changed source`);
  return { files, exclusions: [...excluded.values()] };
}

/** Write the plugin as a directory, replacing what `dir` held. */
export function writePluginDirectory(plugin: ClaudePlugin, dir: string): void {
  rmSync(dir, { recursive: true, force: true });
  for (const [path, text] of plugin.files) {
    const target = join(dir, ...path.split("/"));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, text);
  }
}

if (import.meta.main) {
  Log.suppress();
  const { values } = parseArgs({ options: { out: { type: "string" }, zip: { type: "string" }, marketplace: { type: "string" } } });
  const manifest: unknown = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  const version = isRecord(manifest) ? manifest["version"] : undefined;
  const author = isRecord(manifest) ? manifest["author"] : undefined;
  if (typeof version !== "string" || typeof author !== "string") throw new Error("package.json states no version and author");
  const plugin = buildClaudePlugin(version, author);
  const out = values.out ?? join(ROOT, "dist", "claude-plugin");
  writePluginDirectory(plugin, out);
  const zipPath = values.zip ?? (values.out === undefined ? join(ROOT, "dist", CLAUDE_PLUGIN_ARCHIVE) : undefined);
  for (const { kind, id, reason } of plugin.exclusions) console.log(`claude plugin: left out ${kind} ${id}: ${reason}`);
  console.log(`claude plugin: ${plugin.files.size} files for version ${version} in ${out}${zipPath === undefined ? "" : ` and ${zipPath}`}`);
  if (zipPath !== undefined) {
    const zip = zipArchive(plugin.files);
    writeFileSync(zipPath, zip);
    if (values.marketplace !== undefined) {
      const sha256 = createHash("sha256").update(zip).digest("hex");
      mkdirSync(dirname(join(ROOT, CLAUDE_MARKETPLACE_FILE)), { recursive: true });
      writeFileSync(join(ROOT, CLAUDE_MARKETPLACE_FILE), claudeMarketplace(values.marketplace, version, author, sha256));
      console.log(`claude plugin: ${CLAUDE_MARKETPLACE_FILE} offers the ${values.marketplace} release v${version} archive ${sha256}`);
    }
  } else if (values.marketplace !== undefined) {
    throw new Error("--marketplace pins the digest of the zip, so it needs a zip: state --zip, or omit --out");
  }
}
