import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Schema } from "effect";
import type { AgentDefinition } from "../../infra/agent-definition.js";
import type { ToolAction } from "../../infra/workflow-types.js";
import { errorMessage } from "../../infra/error-message.js";
import { parseFrontmatter } from "../../infra/frontmatter.js";
import { Log } from "../../infra/log.js";
import type { SkillRegistryRevision } from "../skill-schema.js";
import { agents as manifestAgents } from "./manifest.js";
import { createPersonaDefinitionSchema } from "./persona-schema.js";
import { resolveDefinitionCandidates, shouldLogDefinitionMasking, type DefinitionCandidate, type DefinitionResolution } from "../../infra/definition-resolution.js";

const log = Log.create({ service: "agent-registry" });
const BUILT_IN_PERSONA_DIR = fileURLToPath(new URL("personas", import.meta.url));

/** Admission bounds for a persona tree. A persona directory is an external
 *  surface: the user's `~/.flywheel/agents` and the project's
 *  `.flywheel/agents` are arbitrary trees, so the walk that reads them is
 *  bounded in depth, in entries, and in bytes per file rather than trusting
 *  the filesystem to be small. Flywheel's own personas are far below every
 *  bound, so only an external tree can reach one. */
const MAX_PERSONA_DIR_DEPTH = 4;
const MAX_PERSONA_ENTRIES = 500;
const MAX_PERSONA_FILE_BYTES = 256 * 1024;

function isMissingDir(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && err.code === "ENOENT";
}
export interface PersonaToolRegistryEntry {
  readonly name: string;
  readonly action: ToolAction;
  readonly personaBaseline: boolean;
}

/** Resolves an exclusion-based persona grant from the runtime registry view. */
function resolvePersonaTools(
  exclusions: readonly ToolAction[],
  registryEntries: readonly PersonaToolRegistryEntry[],
): string[] {
  const excluded = new Set(exclusions);
  return registryEntries
    .filter(({ action, personaBaseline }) => personaBaseline && !excluded.has(action))
    .map(({ name }) => name);
}


/** Persona keys that once changed a child's stable system prompt. Every child
 *  now shares the stable prompt of an agent of a workflow and its prompt cache, so a file
 *  that still sets one loads without it and the load warns. Remove after
 *  2027-04-13. */
const RETIRED_PERSONA_KEYS = ["projectContext", "engineeringDoctrine"] as const;

interface ParsedPersonaFile {
  readonly value: AgentDefinition;
  readonly retiredKeys: readonly string[];
}

function parsePersonaFile(content: string, layer: "project" | "user" | "bundled", toolEntries?: readonly PersonaToolRegistryEntry[]): ParsedPersonaFile {
  const parsed = parseFrontmatter(content);
  if (!parsed) throw new Error("Invalid persona file: missing or malformed YAML frontmatter");

  const body = parsed.body.trim();
  const { projectContext: _projectContext, engineeringDoctrine: _engineeringDoctrine, ...authored } = parsed.frontmatter;
  const retiredKeys = RETIRED_PERSONA_KEYS.filter((key) => Object.hasOwn(parsed.frontmatter, key));
  const frontmatter = Schema.decodeUnknownSync(createPersonaDefinitionSchema(toolEntries?.map(({ name }) => name)), { onExcessProperty: "error" })(authored);
  const tools = frontmatter.tools ?? resolvePersonaTools(frontmatter.excludeActions, toolEntries ?? []);

  const value: AgentDefinition = {
    kind: "persona",
    name: frontmatter.name,
    description: frontmatter.description,
    systemPrompt: body,
    tools,
    role: frontmatter.role,
    maxTurns: frontmatter.maxTurns ?? 50,
    ...(frontmatter.subagentRoles ? { subagentRoles: frontmatter.subagentRoles } : {}),
    ...(frontmatter.requiredSkills ? { requiredSkills: frontmatter.requiredSkills } : {}),
    ...(frontmatter.allowFork !== undefined ? { allowFork: frontmatter.allowFork } : {}),
    ...(layer === "bundled" ? { bundled: true as const } : {}),
  };
  return { value, retiredKeys };
}

function warnRetiredPersonaKeys(filePath: string, retiredKeys: readonly string[]): void {
  if (retiredKeys.length > 0) log.warn("persona file sets retired keys; they are ignored", { filePath, retiredKeys: retiredKeys.join(",") });
}

/** Read one persona tree under the admission bounds. An entry the bounds
 *  refuse is skipped with a warning, exactly like an unreadable or invalid
 *  persona file: one oversized user file must not disable every built-in
 *  persona.
 *
 *  A skipped persona is not silent for a workflow. Identity and dispatch read
 *  the same registry, and a persona absent from it changes the workflow's
 *  persona identity, so a resumed run reports definition drift instead of
 *  running a different composition. */
interface PersonaLayerLoad {
  readonly candidates: ReadonlyMap<string, readonly DefinitionCandidate<AgentDefinition>[]>;
}

function loadPersonaDirectory(dirPath: string, layer: "project" | "user" | "bundled", toolEntries?: readonly PersonaToolRegistryEntry[], strict = false): PersonaLayerLoad {
  const candidates = new Map<string, DefinitionCandidate<AgentDefinition>[]>();
  let entriesVisited = 0;

  function listPersonaFiles(currentDir: string, depth: number): string[] {
    if (depth > MAX_PERSONA_DIR_DEPTH) {
      log.warn("persona directory exceeds the admitted depth; subtree skipped", { dir: currentDir, maxDepth: MAX_PERSONA_DIR_DEPTH });
      return [];
    }
    let entries: Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>;
    try {
      entries = readdirSync(currentDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    } catch (err) {
      if (!isMissingDir(err)) log.warn("could not read persona directory", { dir: currentDir, reason: errorMessage(err) });
      return [];
    }
    const files: string[] = [];
    for (const entry of entries) {
      entriesVisited++;
      if (entriesVisited > MAX_PERSONA_ENTRIES) {
        log.warn("persona tree exceeds the admitted entry count; remaining entries skipped", { dir: dirPath, maxEntries: MAX_PERSONA_ENTRIES });
        return files;
      }
      const filePath = join(currentDir, entry.name);
      if (entry.isDirectory() && entry.name !== ".base") files.push(...listPersonaFiles(filePath, depth + 1));
      // README.md is the installer-written directory documentation, never a persona.
      else if (entry.isFile() && entry.name.endsWith(".md") && !entry.name.endsWith(".base.md") && entry.name !== "README.md") files.push(filePath);
    }
    return files;
  }

  for (const path of listPersonaFiles(dirPath, 1)) {
    const fallbackId = basename(path, ".md");
    try {
      const bytes = statSync(path).size;
      if (bytes > MAX_PERSONA_FILE_BYTES) throw new Error(`persona file is ${bytes} bytes, over the ${MAX_PERSONA_FILE_BYTES}-byte limit`);
      const raw = readFileSync(path, "utf8");
      const source = { path, layer, identity: createHash("sha256").update(raw).digest("hex") };
      try {
        const { value, retiredKeys } = parsePersonaFile(raw, layer, toolEntries);
        warnRetiredPersonaKeys(path, retiredKeys);
        candidates.set(value.name, [...(candidates.get(value.name) ?? []), { kind: "valid", source, value }]);
      } catch (err) {
        if (strict) throw new Error(`Bundled persona ${path}: ${errorMessage(err)}`, { cause: err });
        const reason = errorMessage(err);
        candidates.set(fallbackId, [...(candidates.get(fallbackId) ?? []), { kind: "rejected", source, reason }]);
        log.warn("skipping unreadable persona file", { filePath: path, reason });
      }
    } catch (err) {
      if (strict) throw new Error(`Bundled persona ${path}: ${errorMessage(err)}`, { cause: err });
      const reason = errorMessage(err);
      candidates.set(fallbackId, [...(candidates.get(fallbackId) ?? []), { kind: "rejected", source: { path, layer }, reason }]);
      log.warn("skipping unreadable persona file", { filePath: path, reason });
    }
  }
  return { candidates };
}

function loadBundledPersonas(fallbackDir: string, toolEntries?: readonly PersonaToolRegistryEntry[]): PersonaLayerLoad {
  if (existsSync(fallbackDir) || Object.keys(manifestAgents).length === 0) {
    return loadPersonaDirectory(fallbackDir, "bundled", toolEntries, fallbackDir === BUILT_IN_PERSONA_DIR);
  }
  const candidates = new Map<string, DefinitionCandidate<AgentDefinition>[]>();
  for (const [file, raw] of Object.entries(manifestAgents)) {
    try {
      const { value, retiredKeys } = parsePersonaFile(raw, "bundled", toolEntries);
      warnRetiredPersonaKeys(`manifest:${file}`, retiredKeys);
      const source = { path: `manifest:${file}`, layer: "bundled" as const, identity: createHash("sha256").update(raw).digest("hex") };
      candidates.set(value.name, [{ kind: "valid", source, value }]);
    } catch (err) {
      throw new Error(`Bundled persona ${file}: ${errorMessage(err)}`, { cause: err });
    }
  }
  return { candidates };
}

function resolvePersonas(layers: readonly PersonaLayerLoad[]): readonly DefinitionResolution<AgentDefinition>[] {
  const ids = new Set(layers.flatMap((layer) => [...layer.candidates.keys()]));
  return [...ids].map((id) => {
    const resolution = resolveDefinitionCandidates("persona", id, `agents/${id}.md`, layers.flatMap((layer) => layer.candidates.get(id) ?? []));
    for (const diagnostic of resolution.diagnostics) {
      if (diagnostic.kind === "masking" && shouldLogDefinitionMasking(diagnostic)) log.warn("persona override masks bundled definition", { winner: diagnostic.winner.path, bundled: diagnostic.displaced.path });
    }
    return resolution;
  });
}

/** Built-in dispatchable clone of the parent agent. Its model and system prompt
 * inputs come from the dispatching agent. The runtime derives registry-approved
 * parent tools, child handoff, and declared nested-role grants at dispatch. */
const GENERAL_AGENT: AgentDefinition = {
  kind: "general",
  name: "general",
  description:
    "A clone of the dispatching agent that uses your model and system instructions with registry-approved tools derived from your current surface. It also receives its child handoff and declared nested-role tools. Use it when a subtask needs your full intelligence and judgment but you want only its conclusion in your context. Set fork: true to also copy your conversation. Prefer explorer for cheap read-only searches and a persona agent for a named specialty.",
  maxTurns: 200,
  // The clone carries the parent's task contract and may dispatch the granted
  // explorer and reviewer roles. Those roles grant no further nesting.
  subagentRoles: ["explorer", "reviewer"],
};

/** A persona's `requiredSkills` compose into its system prompt with no model in
 *  the loop, so an id that names no installed package is a load error, like a
 *  brief's. The assembled registry is the one place where built-in, user, and
 *  project personas are all present, so all three are checked here, against the
 *  revision the caller supplied and no other. A workflow validates against the
 *  revision it pinned, so the check and the composition can never disagree. */
function validateRequiredSkills(
  agents: ReadonlyMap<string, AgentDefinition>,
  skills: SkillRegistryRevision,
): void {
  const errors: string[] = [];
  for (const agent of agents.values()) {
    if (agent.kind !== "persona") continue;
    const missing = (agent.requiredSkills ?? []).filter((id) => !skills.skills.has(id));
    if (missing.length > 0) {
      errors.push(`Persona "${agent.name}" requires uninstalled skill(s): ${missing.join(", ")}`);
    }
  }
  if (errors.length > 0) throw new Error(`Persona definition errors:\n${errors.join("\n")}`);
  // A delegated package leaves the chat catalog on the promise that its persona
  // composes it. A missing or non-composing delegate makes the method
  // unreachable in this composition, which a benchmark's reduced persona set
  // or a third-party package may legitimately produce, so it warns rather than
  // refusing the assembly.
  for (const skill of skills.skills.values()) {
    if (skill.delegate === undefined) continue;
    const persona = agents.get(skill.delegate);
    if (persona?.kind !== "persona" || !(persona.requiredSkills ?? []).includes(skill.id)) {
      log.warn("delegated skill has no composing persona", { skill: skill.id, delegate: skill.delegate });
    }
  }
}

interface AgentRegistryLoad {
  readonly agents: ReadonlyMap<string, AgentDefinition>;
  readonly resolutions: readonly DefinitionResolution<AgentDefinition>[];
}

function resolvePersonaLayers(
  bundled: PersonaLayerLoad,
  skills: SkillRegistryRevision,
  toolEntries?: readonly PersonaToolRegistryEntry[],
  userDir?: string,
  projectDir?: string,
): AgentRegistryLoad {
  const layers = [
    ...(projectDir ? [loadPersonaDirectory(projectDir, "project", toolEntries)] : []),
    ...(userDir ? [loadPersonaDirectory(userDir, "user", toolEntries)] : []),
    bundled,
  ];
  const resolutions = resolvePersonas(layers);
  const agents = new Map(resolutions.flatMap((resolution) => resolution.selected ? [[resolution.id, resolution.selected.value] as const] : []));
  validateRequiredSkills(agents, skills);
  if (agents.has(GENERAL_AGENT.name)) log.warn("persona file named 'general' is ignored; the built-in general agent cannot be shadowed");
  agents.set(GENERAL_AGENT.name, GENERAL_AGENT);
  return { agents: sealPersonaMap(agents), resolutions: Object.freeze([...resolutions]) };
}

export function loadStandalonePersonaRegistry(
  builtInDir: string,
  skills: SkillRegistryRevision,
  toolEntries?: readonly PersonaToolRegistryEntry[],
  userDir?: string,
  projectDir?: string,
): ReadonlyMap<string, AgentDefinition> {
  return resolvePersonaLayers(loadPersonaDirectory(builtInDir, "bundled", toolEntries, builtInDir === BUILT_IN_PERSONA_DIR), skills, toolEntries, userDir, projectDir).agents;
}


export interface PersonaRegistryRevision {
  readonly revision: string;
  readonly personas: ReadonlyMap<string, AgentDefinition>;
  readonly resolutions: readonly DefinitionResolution<AgentDefinition>[];
}

export interface PersonaRegistryOwner {
  /** Re-resolve external persona overlays against current skills while retaining
   *  the built-in definitions captured with this runtime's code revision. */
  load(skills: SkillRegistryRevision, userDir?: string, projectDir?: string): PersonaRegistryRevision;
}

/** Capture built-in persona definitions once for a runtime code revision.
 * User and project overlays remain reloadable through load(). */
export function createPersonaRegistryOwner(
  builtInDir: string,
  toolEntries?: readonly PersonaToolRegistryEntry[],
): PersonaRegistryOwner {
  const bundled = loadBundledPersonas(builtInDir, toolEntries);
  return Object.freeze({
    load(skills: SkillRegistryRevision, userDir?: string, projectDir?: string): PersonaRegistryRevision {
      const loaded = resolvePersonaLayers(bundled, skills, toolEntries, userDir, projectDir);
      return Object.freeze({ revision: personaRevision(loaded.agents), personas: loaded.agents, resolutions: loaded.resolutions });
    },
  });
}


/** Content identity of a persona tree: every definition, in name order. */
function personaRevision(personas: ReadonlyMap<string, AgentDefinition>): string {
  const rows = [...personas.entries()].sort(([a], [b]) => a.localeCompare(b));
  return createHash("sha256").update(JSON.stringify(rows)).digest("hex");
}

function sealPersonaMap(source: ReadonlyMap<string, AgentDefinition>): ReadonlyMap<string, AgentDefinition> {
  const entries = new Map([...source].map(([name, persona]) => [name, freezeDefinition(persona)] as const));
  const view: ReadonlyMap<string, AgentDefinition> = Object.freeze({
    size: entries.size,
    get: (key: string) => entries.get(key),
    has: (key: string) => entries.has(key),
    keys: () => entries.keys(),
    values: () => entries.values(),
    entries: () => entries.entries(),
    forEach: (visit: (value: AgentDefinition, key: string, map: ReadonlyMap<string, AgentDefinition>) => void, thisArg?: unknown) => {
      for (const [key, value] of entries) visit.call(thisArg, value, key, view);
    },
    [Symbol.iterator]: () => entries[Symbol.iterator](),
  });
  return view;
}

function freezeDefinition<T>(value: T): T {
  if (Array.isArray(value)) {
    for (const entry of value) freezeDefinition(entry);
    return Object.freeze(value);
  }
  if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    for (const entry of Object.values(value)) freezeDefinition(entry);
    return Object.freeze(value);
  }
  return value;
}
