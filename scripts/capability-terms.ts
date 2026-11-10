import * as fs from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import type { Node } from "web-tree-sitter";
import { loadTreeSitterParser } from "../src/infra/tree-sitter-parser.js";
import type { AgentDefinition } from "../src/infra/agent-definition.js";
import { agentTypeOf, createDefinitionAvailability } from "../src/orchestration/app-service/definition-availability.js";
import { parentRoleId } from "../src/orchestration/config/roles.js";
import { decodeModuleState } from "../src/orchestration/config/module-descriptor.js";
import { installedDefinitionBundles } from "../src/orchestration/module-catalog.js";
import type { FirstPartyModule } from "../src/orchestration/modules.js";
import { installedPersonaToolEntries } from "../src/orchestration/tool-catalog.js";
import { createProjectDefinitionRegistry } from "../src/workflows/definition-registry.js";
import { isUnderAny, moduleHomes } from "./module-homes.js";

// A module's vocabulary in model text is its tool names and its capability
// phrases (ARCH-STRUCTURE-020). Flywheel-owned text that a model reads names an
// optional capability only in that capability's own text, or where it renders
// from a check that holds it (ARCH-CONTEXT-033). This rule finds every such
// name and passes it only where one of these holds:
// - the file is in the owning module's home, which holds its definition bundle;
// - the file belongs to a bundled skill or persona whose availability closure
//   requires the module, so the text never reaches a reader without it;
// - the line is in the first branch of a `{{if:}}` block whose terms need the
//   module (an `{{else}}` branch renders exactly when they do not hold);
// - the TypeScript literal is a branch of a conditional (`?:`, `&&`, `||`,
//   `if`) whose condition names a capability term or a guard of the module, or
//   is the initializer of a file-local constant whose every use is so guarded.
//   Both branches pass, because the negative branch is where a refusal or a
//   stop statement names the module that is off.
//
// What it cannot see: a reference that names no table term (a sentence that
// needs a background launch without saying so), a guard spelled through a
// helper, and the polarity of a condition. The owner tests pin the known
// implied references; the render matrix checks the rendered bytes.

/** How a module's capability is spelled in model text, beyond its tool names. */
interface CapabilityPhrases {
  readonly phrases: readonly RegExp[];
  /** Identifiers that hold this module's capability in code, for a module whose check is not a tool term. */
  readonly guards?: readonly string[];
  /** Files outside the module's home that hold its own text: the sources of its tools and of the results that
   *  only its own instances produce. */
  readonly sources?: readonly string[];
  /** Directories in the module's home that drive a live run of Flywheel the way a person does: their literals are
   *  the person's messages and the stub results of a fixed module selection, whose subject is a capability, not
   *  guidance that Flywheel gives a reader. */
  readonly harnesses?: readonly string[];
}

/** The phrases of every module, by module id. */
interface CapabilityPhraseTable {
  readonly [moduleId: string]: CapabilityPhrases;
}

const TOOLS = "src/orchestration/agent-runtime/tools";

/** The phrase table, keyed by module id and seeded from the forms the prompt inventory found. Every module that
 *  contributes a tool has an entry; the drift check keeps the keys and the installed catalog in step, and keeps
 *  every listed source on disk. */
export const CAPABILITY_PHRASES: CapabilityPhraseTable = {
  "ask-user": { phrases: [], guards: ["askUserAvailable"], sources: [`${TOOLS}/ask-user.ts`] },
  "background-commands": {
    phrases: [/\bbackground commands?\b/i, /\bbackground(?:=|: )true\b/, /\bpersistent processes\b/i, /\bservers? and services\b/i],
    guards: ["background", "backgroundCommands", "advertisesBackground", "persistence", "persists", "backgroundShellModuleRequirements"],
    // The notices of one managed command, which exist only for a command that runs.
    sources: [`${TOOLS}/managed-command.ts`],
  },
  bash: {
    phrases: [/\b(?:in|through|via|with|to|no|use) Bash\b/, /\bBash (?:commands?|results?|scratch)\b/, /\buse bash\b/i],
    // The command-evidence envelope reaches a reader only in the postamble variant that a reader with Bash gets.
    sources: [`${TOOLS}/bash.ts`, `${TOOLS}/bash-guidance.ts`, `${TOOLS}/bash-command-policy.ts`, "src/workflows/output-contract/envelope.ts"],
  },
  "code-mode": { phrases: [/\bCode Mode\b/], sources: [`${TOOLS}/nested-tool-dispatch.ts`] },
  "definition-overrides": { phrases: [], sources: [`${TOOLS}/definition-overrides.ts`] },
  development: { phrases: [], harnesses: ["src/orchestration/modules/development/benchmark", "src/orchestration/modules/development/claude-sdk"] },
  discovery: { phrases: [], sources: [`${TOOLS}/list.ts`, `${TOOLS}/search.ts`] },
  experiments: { phrases: [/(?:^|[\s`(])\/experiment\b/], sources: [`${TOOLS}/experiment-schemas.ts`] },
  "file-tools": {
    phrases: [/\bfile-edit\b/i],
    sources: [`${TOOLS}/apply-patch.ts`, `${TOOLS}/edit.ts`, `${TOOLS}/read.ts`, `${TOOLS}/write.ts`, `${TOOLS}/streaming-edit-validator.ts`],
  },
  learning: { phrases: [/\b(?:to|in) memory\b/] },
  mcp: { phrases: [/\bMCP\b/], sources: ["src/orchestration/agent-runtime/mcp-result.ts", "src/orchestration/agent-runtime/mcp-stdio-client-transport.ts"] },
  papercuts: { phrases: [] },
  recall: { phrases: [/\brecall ids?\b/i], guards: ["recallAvailable"], sources: [`${TOOLS}/recall.ts`] },
  skills: { phrases: [], sources: [`${TOOLS}/skill.ts`] },
  subagents: {
    phrases: [
      /\b(?:dispatch|launch|start|use|delegate to)(?:es|s|ed|ing)? (?:a |an |one |the |parallel |bounded |implementer |explorer |reviewer )*subagents?\b/i,
      /\bsubagents? (?:tool|dispatch)\b/i,
      /\bas subagents\b/i,
    ],
  },
  web: { phrases: [], sources: [`${TOOLS}/web.ts`] },
  "web-exa": { phrases: [/\bExa\b/], sources: ["src/orchestration/agent-runtime/web-search/exa.ts"] },
  workflows: {
    phrases: [
      /\bworkflow files?\b/i,
      /\b(?:launch|start)(?:s|ed|ing)? (?:a|the|one) workflow\b/i,
      /\bsubagents and workflows\b/i,
      /\bchild or workflow\b/i,
      /\bWorkflow Agent default\b/,
    ],
    guards: ["workflowLaunch"],
    sources: [`${TOOLS}/workflow.ts`, `${TOOLS}/workflow-tool.ts`],
  },
};

/** How an agent type is spelled in model text, keyed by type: the word for a reader that works without the type.
 *  Each role under a listed parent role also gets its own entry, spelled by the names of its personas and its role
 *  id, so a text that names one reviewer persona needs that role.
 *
 *  `general` and `ship` are ordinary English words, so their entries spell a reference to the type and not the
 *  word: the name in backticks or quotes or as a persona value, a roster line, the name beside a noun for an agent
 *  ("the general agent", "the Ship agent"), and the name as the object of a dispatch ("dispatch general", "ask
 *  Ship"). Ship as a name is capitalized, so a capitalized "Ship" that no object follows names the agent ("Ship
 *  returns", "to Ship."), while "Ship it" and "Ship the change" are the verb. Forked conversation history belongs to
 *  `general`: a fork makes a clone of the dispatcher, the general agent's own method, and the dispatch tool offers
 *  `fork` only while the general agent is available. So the fork field and a fork of an agent's conversation are
 *  references to it, and a fork of a repository is not. */
export const AGENT_TYPE_PHRASES = {
  advisor: [/\badvisors?\b/i],
  explorer: [/\bexplorers?\b/i],
  general: [
    /`general`/,
    /(["'])general\1/,
    /\bpersona:\s*["']?general\b/,
    /^\s*- general:/m,
    /\bgeneral (?:agent|subagent|persona)s?\b/i,
    /\b(?:dispatch|send|prefer|delegate to)(?:es|s|ed|ing)? (?:the )?general\b/i,
    /`fork`|\bfork:\s*true\b|\b(?:use|uses|using) fork\b/i,
    /\bfork(?:s|ed|ing)?\b[^.\n]{0,40}\bconversation\b/i,
    /\bfork(?:ed)? (?:history|child|children|subagents?|dispatch(?:es)?|work)\b/i,
  ],
  implementer: [/\bimplementers?\b/i],
  reviewer: [/\breviewers?\b/i],
  ship: [
    /`ship`/,
    /(["'])ship\1/,
    /\bpersona:\s*["']?ship\b/,
    /^\s*- ship:/m,
    /\bShip\b(?! (?:it|them|the|this|that|these|those|a|an|your|our|each|every|all|to)\b)/,
    /\bship(?:'s)? (?:agent|subagent|persona|phase)s?\b/i,
    /\b(?:dispatch|send|use|ask|wait for)(?:es|s|ed|ing)? (?:the )?ship\b/i,
  ],
} satisfies { readonly [type: string]: readonly RegExp[] };

/** A type's own text outside a definition file, as `CapabilityPhrases` gives it for a module: the general agent is
 *  defined in code, and a `fork` value holds only where the dispatch tool offered the field, which it does only while
 *  the general agent is available. */
const AGENT_TYPE_TEXT = new Map<string, Pick<CapabilityPhrases, "guards" | "sources">>([
  ["general", { guards: ["fork"], sources: ["src/workflows/agents/registry.ts"] }],
]);

/** One optional module's model-text vocabulary. */
export interface CapabilityModuleTerms {
  readonly id: string;
  /** Logical tool identities and exposed registration names that the module contributes. */
  readonly tools: readonly string[];
  /** Ids of the skills that the module's definition bundle ships. */
  readonly skills: readonly string[];
  readonly phrases: readonly RegExp[];
  readonly guards: readonly string[];
  /** The module's home and its own text outside the home. */
  readonly homes: readonly string[];
  /** The module's harness directories (`CapabilityPhrases.harnesses`). */
  readonly harnesses: readonly string[];
}

export interface CapabilityVocabulary {
  readonly modules: readonly CapabilityModuleTerms[];
  /** The agent types whose spelling `AGENT_TYPE_PHRASES` gives, each as a capability with the id `type:<id>`, no
   *  tools, skills, guards, or homes: a type's own text is a definition that needs it. */
  readonly types: readonly CapabilityModuleTerms[];
  /** The capabilities that one capability term needs, modules and `type:<id>` alike: a tool identity, `skill:<id>`,
   *  `persona:<name>`, or `type:<id>`. Undefined for a name that is no term. */
  readonly termModules: (term: string) => readonly string[] | undefined;
  /** Bundled definition files and directories, each with the capabilities its availability closure requires. A path
   *  that ends in "/" names a directory. */
  readonly definitions: readonly { readonly path: string; readonly requires: readonly string[] }[];
}

export interface CapabilityTermViolation {
  readonly path: string;
  readonly line: number;
  /** The text that names the capability. */
  readonly literal: string;
  readonly module: string;
}

/** A call whose first argument is a capability term: a capability check, `has("bash")`, or the reason that a
 *  capture leaves the tool of a term off. A tool term that shares a module's spelling is a term there, not a
 *  module id, so the module-id rule and this rule both accept it (ARCH-CONTEXT-033). */
const CAPABILITY_TERM_CALL = /\b(?:has|disabledToolReason)\(\s*$/;

/** Whether the quoted literal at `index` of `source` is the term argument of a capability call. */
export function isCapabilityTermArgument(source: string, index: number): boolean {
  return CAPABILITY_TERM_CALL.test(source.slice(Math.max(0, index - 40), index));
}

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** One code span, or an enumeration of them joined by commas, "or", and "and". */
const CODE_SPANS = String.raw`\`[^\`\n]+\`(?:(?:,\s*(?:(?:or|and)\s+)?|\s+(?:or|and)\s+)\`[^\`\n]+\`)*`;
/** The nouns that say a code span names a key, a field, a value, a type, or a command, and not a tool. */
const GRAMMAR_KIND = String.raw`(?:keys?|fields?|values?|types?|command|reducer)`;
const KIND_NAMED_SPANS = new RegExp(String.raw`${CODE_SPANS}(?=\s+${GRAMMAR_KIND}\b)|(?<=\b(?:${GRAMMAR_KIND}|one of)\s+)${CODE_SPANS}`, "g");
const GRAMMAR_HEADING = /^(?:types?|keys?|fields?|values?)$/i;
const TABLE_SEPARATOR = /^\|(?:\s*:?-+:?\s*\|)+\s*$/;
const MASK = "`·`";

const tableCells = (row: string): string[] => row.trim().replace(/^\||\|$/g, "").split("|");

/** `text` with each code span masked, except the name of an agent type: "the `general` type" names the type, which
 *  is what its vocabulary looks for. */
const maskSpans = (text: string): string => text.replace(/`([^`\n]+)`/g, (span, name: string) => Object.hasOwn(AGENT_TYPE_PHRASES, name) ? span : MASK);

/** `text` with each code span that its syntax names as grammar, not as a tool, masked: a span that a kind noun
 *  follows or that "one of" or a kind noun introduces (the `write` key, one of `subagent` or `headless`), and a
 *  span in a table column whose heading is a grammar heading (Type, Keys). A workflow file's `write` and `list`
 *  keys share a spelling with tools. */
export function maskGrammarNames(text: string): string {
  const lines = text.split("\n");
  let grammarColumns: ReadonlySet<number> | undefined;
  for (const [index, line] of lines.entries()) {
    if (!line.trimStart().startsWith("|")) {
      grammarColumns = undefined;
    } else if (TABLE_SEPARATOR.test(line.trim())) {
      continue;
    } else if (TABLE_SEPARATOR.test(lines[index + 1]?.trim() ?? "")) {
      grammarColumns = new Set(tableCells(line).flatMap((cell, column) => GRAMMAR_HEADING.test(cell.trim()) ? [column] : []));
    } else if (grammarColumns && grammarColumns.size > 0) {
      const columns = grammarColumns;
      lines[index] = `|${tableCells(line).map((cell, column) => columns.has(column) ? maskSpans(cell) : cell).join("|")}|`;
    }
    lines[index] = (lines[index] ?? "").replace(KIND_NAMED_SPANS, maskSpans);
  }
  return lines.join("\n");
}

const modulePatterns = new WeakMap<CapabilityModuleTerms, readonly RegExp[]>();

function patternsOf(module: CapabilityModuleTerms): readonly RegExp[] {
  let patterns = modulePatterns.get(module);
  if (!patterns) {
    patterns = [
      ...module.tools.flatMap((tool) => {
        const name = escapeRegExp(tool);
        // "The X tool" or a code span names a tool; a name with an underscore is distinctive as a whole word.
        return [new RegExp(`\\b${name} tools?\\b`, "i"), new RegExp(`\`${name}[\`(]`), ...(tool.includes("_") ? [new RegExp(`\\b${name}\\b`)] : [])];
      }),
      ...module.skills.map((id) => new RegExp(`(?<![\\w/-])${escapeRegExp(id)}(?![\\w-])`)),
      ...module.phrases,
    ];
    modulePatterns.set(module, patterns);
  }
  return patterns;
}

/** One place where a text names a module's capability. */
export interface CapabilityMention {
  readonly module: string;
  readonly mention: string;
}

/** Each way that `text` names the capability of one of `modules`: a tool name, a skill id, or a phrase of the
 *  table, after `maskGrammarNames`. */
export function capabilityMentions(text: string, modules: readonly CapabilityModuleTerms[]): CapabilityMention[] {
  const masked = maskGrammarNames(text);
  return modules.flatMap((module) => patternsOf(module).flatMap((pattern) => {
    const found = pattern.exec(masked)?.[0];
    return found === undefined ? [] : [{ module: module.id, mention: found }];
  }));
}

/** The table's drift: a tool-contributing module with no entry, an entry for a module the catalog does not
 *  install, a listed source that is not on disk under `repoRoot`, or a listed harness that is not on disk in its
 *  module's home. */
export function findCapabilityTableDrift(repoRoot: string, table: CapabilityPhraseTable, modules: readonly { readonly id: string; readonly tools: readonly string[] }[]): readonly string[] {
  const installed = new Set(modules.map((module) => module.id));
  return [
    ...modules.filter((module) => module.tools.length > 0 && table[module.id] === undefined).map((module) => `capability phrase table has no entry for module "${module.id}", which contributes tools`),
    ...Object.keys(table).filter((id) => !installed.has(id)).map((id) => `capability phrase table names "${id}", which is not an installed module`),
    ...Object.entries(table).flatMap(([id, entry]) => (entry.sources ?? []).filter((source) => !fs.existsSync(path.join(repoRoot, source))).map((source) => `capability phrase table lists ${source} as text of "${id}", and it does not exist`)),
    ...Object.entries(table).flatMap(([id, entry]) => (entry.harnesses ?? []).filter((harness) => !fs.existsSync(path.join(repoRoot, harness)) || !isUnderAny(`${harness}/`, moduleHomes(id))).map((harness) => `capability phrase table lists ${harness} as a harness of "${id}", and it is not a directory in that module's home`)),
  ].toSorted();
}

/** Bundled markdown and YAML that a model reads, and the TypeScript roots whose literals hold model text. */
const MARKDOWN_ROOTS = ["src/agent-skills", "src/workflows/agents/personas", "src/infra/agent-assets", "src/orchestration/modules"];
const TEXT_ROOTS = ["src/orchestration/agent-runtime", "src/infra/agent-assets", "src/workflows/output-contract", "src/workflows/agents", "src/orchestration/modules"];
const TEXT_FILES = /^src\/workflows\/skill-[^/]+\.ts$/;
const MARKDOWN_FILE = /\.(?:md|ya?ml)$/;
const MODULE_DEFINITIONS = /^src\/orchestration\/modules\/[^/]+\/definitions\//;
/** A file of a bundled skill package, whatever its extension: the skill tool offers every file that the package
 *  holds outside dot-named entries as a resource and renders its markers for the reader. */
const BUNDLED_SKILL_FILE = /^src\/(?:agent-skills|orchestration\/modules\/[^/]+\/definitions\/skills)\/(?:[^./][^/]*\/)+[^./][^/]*$/;
/** Text that no Flywheel reader is guided by: the Claude engine's own text, which Flywheel copies byte for byte so
 *  that history can find it. */
const UNSCANNED: readonly string[] = ["src/orchestration/modules/provider-claude-agent-sdk/agent-host/engine-text.ts"];

function listFiles(dir: string, out: string[]): void {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) listFiles(full, out);
    else if (entry.isFile()) out.push(full);
  }
}

const IF_MARKER = /^\{\{if:([^}]*)\}\}$/;

/** The first mention of each module of `modules` in `text` that `covered` does not pass. */
function lineFindings(relPath: string, line: number, text: string, modules: readonly CapabilityModuleTerms[], covered: (module: string) => boolean): CapabilityTermViolation[] {
  const seen = new Set<string>();
  return capabilityMentions(text, modules.filter((module) => !covered(module.id))).flatMap(({ module, mention }) => {
    if (seen.has(module)) return [];
    seen.add(module);
    return [{ path: relPath, line, literal: mention, module }];
  });
}

/** What every one of `sets` holds. */
function intersection(sets: readonly ReadonlySet<string>[]): Set<string> {
  const [first, ...rest] = sets;
  return new Set([...first ?? []].filter((item) => rest.every((set) => set.has(item))));
}

/** The frontmatter fields that a reader is shown: a definition's name and description, in the skill header, the skill
 *  catalog, and the roster. Every other field is configuration, such as `related:`, whose skills the header names only
 *  while they hold (renderSkillContext), or a grant such as `subagentRoles:`, which drops a type that is off. */
const MODEL_TEXT_FRONTMATTER = /^(?:name|description):/;

function markdownFindings(relPath: string, source: string, vocabulary: CapabilityVocabulary, fileCovers: (module: string) => boolean): CapabilityTermViolation[] {
  const findings: CapabilityTermViolation[] = [];
  const capabilities = [...vocabulary.modules, ...vocabulary.types];
  let block: { readonly modules: ReadonlySet<string>; inElse: boolean } | undefined;
  const lines = maskGrammarNames(source).split("\n");
  let frontmatter = lines[0] === "---";
  for (const [index, line] of lines.entries()) {
    if (frontmatter && index > 0 && line === "---") frontmatter = false;
    if (frontmatter && !MODEL_TEXT_FRONTMATTER.test(line)) continue;
    const marker = line.trim();
    const opened = IF_MARKER.exec(marker);
    if (opened) {
      // `{{if:a&!b|c}}` renders when every condition of any one alternative holds, so it guarantees only what every
      // alternative needs; an alternative needs what each of its terms needs, and a negated term guarantees nothing.
      const alternatives = (opened[1] ?? "").split("|").map((alternative) => new Set(alternative.split("&").map((term) => term.trim()).flatMap((term) => term.startsWith("!") ? [] : vocabulary.termModules(term) ?? [])));
      block = { modules: intersection(alternatives), inElse: false };
      continue;
    }
    if (marker === "{{else}}" && block) {
      block.inElse = true;
      continue;
    }
    if (marker === "{{end}}") {
      block = undefined;
      continue;
    }
    const open = block;
    findings.push(...lineFindings(relPath, index + 1, line, capabilities, (module) => fileCovers(module) || (open !== undefined && !open.inElse && open.modules.has(module))));
  }
  return findings;
}

function within(node: Node, ancestor: Node | null): boolean {
  return ancestor !== null && node.startIndex >= ancestor.startIndex && node.endIndex <= ancestor.endIndex;
}

/** Whether a statement always leaves its block: a return or a throw, or a block that ends with one. */
function exits(statement: Node | null): boolean {
  if (!statement) return false;
  if (statement.type === "return_statement" || statement.type === "throw_statement") return true;
  return statement.type === "statement_block" && exits(statement.namedChildren.at(-1) ?? null);
}

function descendants(node: Node, visit: (node: Node) => void): void {
  visit(node);
  for (const child of node.namedChildren) if (child) descendants(child, visit);
}

/** What holds at one point of the code: the modules whose capability a condition there proved on, and those whose
 *  capability it proved off. */
interface Guarantee {
  readonly held: ReadonlySet<string>;
  readonly refuted: ReadonlySet<string>;
}

const NOTHING: Guarantee = { held: new Set(), refuted: new Set() };
const both = (a: Guarantee, b: Guarantee): Guarantee => ({ held: new Set([...a.held, ...b.held]), refuted: new Set([...a.refuted, ...b.refuted]) });
const either = (a: Guarantee, b: Guarantee): Guarantee => ({ held: intersection([a.held, b.held]), refuted: intersection([a.refuted, b.refuted]) });

const TRANSPARENT = new Set(["parenthesized_expression", "as_expression", "non_null_expression", "satisfies_expression"]);
const NULLISH = new Set(["undefined", "null"]);

/** The guard analysis of one parsed TypeScript file: what holds where a literal is evaluated. */
function typescriptGuards(root: Node, vocabulary: CapabilityVocabulary) {
  const declarators = new Map<string, Node>();
  const references = new Map<string, Node[]>();
  descendants(root, (node) => {
    if (node.type === "variable_declarator" || node.type === "function_declaration") {
      const name = node.childForFieldName("name");
      if (name?.type === "identifier") declarators.set(name.text, node);
    }
    if (node.type === "identifier" || node.type === "shorthand_property_identifier") {
      const parent = node.parent;
      const declares = (parent?.type === "variable_declarator" || parent?.type === "function_declaration") && parent.childForFieldName("name")?.id === node.id;
      if (!declares) references.set(node.text, [...references.get(node.text) ?? [], node]);
    }
  });
  const guardModules = new Map<string, string>([...vocabulary.modules, ...vocabulary.types].flatMap((module) => module.guards.map((guard) => [guard, module.id] as const)));

  /** The modules that the capability terms and guards an expression spells need. With `followBindings`, a name that
   *  the file binds counts for what its value needs. */
  function named(expression: Node, seen: ReadonlySet<string>, followBindings: boolean): Set<string> {
    const modules = new Set<string>();
    descendants(expression, (node) => {
      if (node.type === "string_fragment") {
        // A quoted skill id is the term of that skill. A `skill:` or `persona:` term whose id is spelled elsewhere,
        // as in has(`skill:${WORKTREE_LIFECYCLE_SKILL_ID}`), still holds only with the skill or subagent tool.
        // A quoted type id, as in roles.has("advisor"), is the term of that type.
        const prefixTool = node.text.startsWith("skill:") ? "skill" : node.text.startsWith("persona:") || node.text.startsWith("type:") ? "subagent" : undefined;
        for (const module of [...vocabulary.termModules(node.text) ?? vocabulary.termModules(`skill:${node.text}`) ?? vocabulary.termModules(`type:${node.text}`) ?? [], ...prefixTool ? vocabulary.termModules(prefixTool) ?? [] : []]) modules.add(module);
      }
      if (node.type === "identifier" || node.type === "property_identifier" || node.type === "shorthand_property_identifier") {
        for (const module of vocabulary.termModules(node.text) ?? []) modules.add(module);
        const guarded = guardModules.get(node.text);
        if (guarded) modules.add(guarded);
        const declared = followBindings && node.type === "identifier" && !seen.has(node.text) ? declarators.get(node.text)?.childForFieldName("value") : undefined;
        if (declared) for (const module of named(declared, new Set([...seen, node.text]), true)) modules.add(module);
      }
    });
    return modules;
  }

  /** What holds when `condition` evaluates to `truth`. A positive test holds its terms only where it is true; a
   *  disjunction holds only what each of its sides holds. */
  function guarantee(condition: Node, truth: boolean, seen: ReadonlySet<string>, followBindings: boolean): Guarantee {
    if (TRANSPARENT.has(condition.type)) {
      const inner = condition.namedChildren[0];
      return inner ? guarantee(inner, truth, seen, followBindings) : NOTHING;
    }
    if (condition.type === "unary_expression" && condition.childForFieldName("operator")?.text === "!") {
      const argument = condition.childForFieldName("argument");
      return argument ? guarantee(argument, !truth, seen, followBindings) : NOTHING;
    }
    if (condition.type === "binary_expression") {
      const operator = condition.childForFieldName("operator")?.text;
      const left = condition.childForFieldName("left");
      const right = condition.childForFieldName("right");
      if (left && right) {
        const side = (node: Node, value: boolean) => guarantee(node, value, seen, followBindings);
        if (operator === "&&") return truth ? both(side(left, true), side(right, true)) : either(side(left, false), side(right, false));
        if (operator === "||") return truth ? either(side(left, true), side(right, true)) : both(side(left, false), side(right, false));
        if (operator === "===" || operator === "==" || operator === "!==" || operator === "!=") {
          const negated = operator.startsWith("!");
          const tested = NULLISH.has(right.text) || right.text === "false" ? left : NULLISH.has(left.text) || left.text === "false" ? right : undefined;
          // `x === undefined` and `x === false` are true where `x` is absent.
          if (tested) return side(tested, negated ? truth : !truth);
          const affirmed = right.text === "true" ? left : left.text === "true" ? right : undefined;
          if (affirmed) return side(affirmed, negated ? !truth : truth);
        }
      }
    }
    if (condition.type === "identifier" && followBindings && !seen.has(condition.text)) {
      const declared = declarators.get(condition.text)?.childForFieldName("value");
      if (declared) return both(atom(condition, truth, seen, false), guarantee(declared, truth, new Set([...seen, condition.text]), true));
    }
    return atom(condition, truth, seen, followBindings);
  }

  function atom(condition: Node, truth: boolean, seen: ReadonlySet<string>, followBindings: boolean): Guarantee {
    const modules = named(condition, seen, followBindings);
    return truth ? { held: modules, refuted: new Set() } : { held: new Set(), refuted: modules };
  }

  /** What holds where `node` is evaluated: what its enclosing conditionals and guard clauses prove on the path to
   *  it, and what every use of its enclosing file-local constant proves. */
  function covered(node: Node, seen: ReadonlySet<string>): Guarantee {
    let result = NOTHING;
    for (let child = node, parent = node.parent; parent; child = parent, parent = parent.parent) {
      if (parent.type === "ternary_expression" || parent.type === "if_statement") {
        const condition = parent.childForFieldName("condition");
        const truth = within(child, parent.childForFieldName("consequence")) ? true : within(child, parent.childForFieldName("alternative")) ? false : undefined;
        if (condition && truth !== undefined) result = both(result, guarantee(condition, truth, new Set(), true));
      }
      if (parent.type === "binary_expression" && within(child, parent.childForFieldName("right"))) {
        const operator = parent.childForFieldName("operator")?.text;
        const left = parent.childForFieldName("left");
        // `a && x` evaluates x where a is true, `a || x` where a is false; `a ?? x` proves nothing about a.
        if (left && (operator === "&&" || operator === "||")) result = both(result, guarantee(left, operator === "&&", new Set(), true));
      }
      // A guard clause, `if (!has("x")) return ...`, conditions every statement after it in its block on its test
      // being false. Only the terms it spells count: a computed name before a return says nothing.
      if (parent.type === "statement_block" || parent.type === "program") {
        for (const statement of parent.namedChildren) {
          if (!statement || statement.startIndex >= child.startIndex) break;
          const condition = statement.type === "if_statement" && !statement.childForFieldName("alternative") && exits(statement.childForFieldName("consequence")) ? statement.childForFieldName("condition") : null;
          if (condition) result = both(result, guarantee(condition, false, new Set(), false));
        }
      }
      if ((parent.type === "variable_declarator" || parent.type === "function_declaration") && parent.parent?.parent?.type !== "export_statement" && parent.parent?.type !== "export_statement") {
        const name = parent.childForFieldName("name")?.text;
        const uses = name === undefined || seen.has(name) ? [] : references.get(name) ?? [];
        if (name !== undefined && uses.length > 0) result = both(result, uses.map((use) => covered(use, new Set([...seen, name]))).reduce(either));
      }
    }
    return result;
  }
  return (node: Node) => covered(node, new Set());
}

const LOGGERS = new Set(["log", "logger", "console", "Log"]);

/** How a literal reaches a reader. `silent`: no model reads it (a log record, a settings label that a person
 *  reads, or a configuration schema annotation, which describes a key to the person who edits flywheel.toml). `refusal`: a thrown error, a constructed refusal, the `error` of a result, a tool result whose outcome is
 *  an error, or the text of a function named for a refusal, which may also name a capability that a guard on its
 *  path found off. */
function literalRole(node: Node): "silent" | "refusal" | "text" {
  let role: "refusal" | "text" = "text";
  for (let child = node, parent = node.parent; parent; child = parent, parent = parent.parent) {
    if (parent.type === "call_expression" && child.type === "arguments") {
      const callee = parent.childForFieldName("function");
      const receiver = callee?.type === "member_expression" ? callee.childForFieldName("object") : undefined;
      if (receiver && LOGGERS.has(receiver.text)) return "silent";
      if (callee?.text === "Schema.annotate") return "silent";
    }
    if (parent.type === "pair" && parent.childForFieldName("key")?.text === "label" && within(node, parent.childForFieldName("value"))) return "silent";
    if (parent.type === "throw_statement") role = "refusal";
    if (parent.type === "new_expression" && /(?:Error|Refusal)$/.test(parent.childForFieldName("constructor")?.text ?? "")) role = "refusal";
    if (parent.type === "pair" && parent.childForFieldName("key")?.text === "error" && within(node, parent.childForFieldName("value"))) role = "refusal";
    // A tool result whose outcome is an error.
    if (parent.type === "object" && parent.namedChildren.some((pair) => pair?.type === "pair" && pair.childForFieldName("key")?.text === "outcome" && pair.childForFieldName("value")?.text === '"error"')) role = "refusal";
    if ((parent.type === "function_declaration" || parent.type === "method_definition" || parent.type === "variable_declarator") && /refus/i.test(parent.childForFieldName("name")?.text ?? "")) role = "refusal";
  }
  return role;
}

/** The prose pieces of a string or template literal: its fragments, without substitutions. */
function literalPieces(node: Node): readonly Node[] {
  return node.namedChildren.filter((child): child is Node => child?.type === "string_fragment" && /\s/.test(child.text) && /[A-Za-z]/.test(child.text));
}

async function typescriptFindings(relPath: string, source: string, vocabulary: CapabilityVocabulary, fileCovers: (module: string) => boolean): Promise<CapabilityTermViolation[]> {
  const parser = await loadTreeSitterParser(relPath.endsWith(".tsx") ? "tsx" : "typescript");
  const tree = parser.parse(source);
  if (!tree) throw new Error(`${relPath}: cannot parse`);
  try {
    const coveredAt = typescriptGuards(tree.rootNode, vocabulary);
    const uncovered = [...vocabulary.modules, ...vocabulary.types].filter((module) => !fileCovers(module.id));
    const findings: CapabilityTermViolation[] = [];
    descendants(tree.rootNode, (node) => {
      if (node.type !== "string" && node.type !== "template_string") return;
      const pieces = literalPieces(node);
      if (pieces.length === 0) return;
      const role = literalRole(node);
      if (role === "silent") return;
      for (const piece of pieces) {
        const text = piece.text.replaceAll("\\`", "`");
        if (capabilityMentions(text, uncovered).length === 0) continue;
        const guarantee = coveredAt(node);
        // A refusal names the capability that its guard found off; guidance names only what its guard found on.
        const allowed = role === "refusal" ? new Set([...guarantee.held, ...guarantee.refuted]) : guarantee.held;
        findings.push(...lineFindings(relPath, piece.startPosition.row + 1, text, uncovered, (module) => allowed.has(module)));
      }
    });
    return findings;
  } finally {
    tree.delete();
  }
}

/** Every capability term in Flywheel-owned model text that no owner, definition, marker, or guard covers. */
export async function findCapabilityTermViolations(repoRoot: string, vocabulary: CapabilityVocabulary): Promise<readonly CapabilityTermViolation[]> {
  const files = new Set<string>();
  for (const root of new Set([...MARKDOWN_ROOTS, ...TEXT_ROOTS, "src/workflows"])) {
    const found: string[] = [];
    listFiles(path.join(repoRoot, root), found);
    for (const file of found) files.add(path.relative(repoRoot, file).split(path.sep).join("/"));
  }
  const findings: CapabilityTermViolation[] = [];
  for (const relPath of [...files].toSorted()) {
    if (isUnderAny(relPath, UNSCANNED) || vocabulary.modules.some((module) => isUnderAny(relPath, module.harnesses.map((harness) => `${harness}/`)))) continue;
    const markdown = BUNDLED_SKILL_FILE.test(relPath) || (MARKDOWN_FILE.test(relPath) && MARKDOWN_ROOTS.some((root) => relPath.startsWith(`${root}/`)) && (!relPath.startsWith("src/orchestration/modules/") || MODULE_DEFINITIONS.test(relPath)));
    // A migration holds the retired bytes it converts, which no current reader is shown.
    const text = /\.tsx?$/.test(relPath) && !/\.(?:test|d)\.tsx?$/.test(relPath) && !relPath.includes("/migrations/") && (TEXT_FILES.test(relPath) || TEXT_ROOTS.some((root) => relPath.startsWith(`${root}/`)));
    if (!markdown && !text) continue;
    const requires = new Set(vocabulary.definitions.filter((definition) => isUnderAny(relPath, [definition.path])).flatMap((definition) => definition.requires));
    const homes = new Set([...vocabulary.modules, ...vocabulary.types].filter((module) => isUnderAny(relPath, module.homes)).map((module) => module.id));
    const fileCovers = (module: string): boolean => requires.has(module) || homes.has(module);
    const source = fs.readFileSync(path.join(repoRoot, relPath), "utf8");
    findings.push(...markdown ? markdownFindings(relPath, source, vocabulary, fileCovers) : await typescriptFindings(relPath, source, vocabulary, fileCovers));
  }
  return findings;
}

/** The capability ids of `types`: `type:<id>` for each, and for the parent role that covers it. */
function typeCapabilities(types: readonly string[]): string[] {
  return types.flatMap((type) => {
    const parent = parentRoleId(type);
    return parent === undefined ? [`type:${type}`] : [`type:${type}`, `type:${parent}`];
  });
}

/** What one definition's availability needs, as capability ids: its modules and its agent types. */
function needs(entry: { readonly requires: readonly string[]; readonly types: readonly string[] } | undefined): readonly string[] | undefined {
  return entry === undefined ? undefined : [...entry.requires, ...typeCapabilities(entry.types)];
}

/** One capability per agent type that `AGENT_TYPE_PHRASES` spells, and one per role under a listed parent role. */
function typeTerms(personas: ReadonlyMap<string, AgentDefinition>): CapabilityModuleTerms[] {
  const nameOf = (name: string): RegExp => new RegExp(`(?<![\\w-])${escapeRegExp(name)}(?![\\w-])`);
  const roles = new Map<string, string[]>();
  for (const persona of personas.values()) {
    const type = agentTypeOf(persona);
    const parent = parentRoleId(type);
    if (parent !== undefined && Object.hasOwn(AGENT_TYPE_PHRASES, parent)) roles.set(type, [...roles.get(type) ?? [], persona.name]);
  }
  const term = (type: string, phrases: readonly RegExp[]): CapabilityModuleTerms => ({ id: `type:${type}`, tools: [], skills: [], phrases, guards: AGENT_TYPE_TEXT.get(type)?.guards ?? [], homes: AGENT_TYPE_TEXT.get(type)?.sources ?? [], harnesses: [] });
  return [
    ...Object.entries(AGENT_TYPE_PHRASES).map(([type, phrases]) => term(type, phrases)),
    ...[...roles].toSorted(([a], [b]) => a.localeCompare(b)).map(([role, names]) => term(role, [...names, role].map(nameOf))),
  ];
}

/** The vocabulary of `modules`, the whole catalog that the containment check reads: each module's tools, bundled
 *  skills, and phrase table entry, and the requirement closure of every bundled skill and persona of its definition
 *  bundles. Reads no user or project definition store. */
export async function realCapabilityVocabulary(repoRoot: string, modules: readonly FirstPartyModule[]): Promise<CapabilityVocabulary> {
  const scratch = fs.mkdtempSync(path.join(tmpdir(), "flywheel-capability-terms-"));
  try {
    const registry = createProjectDefinitionRegistry({ projectRoot: scratch, userDataRoot: scratch, accountHome: scratch, skillRoots: [], bundles: installedDefinitionBundles(modules), personaToolEntries: installedPersonaToolEntries() });
    const revision = registry.captureRevision();
    // Requirements resolve against `modules`, so a development skill's closure names its own module. A requirement
    // does not depend on the selection, so any capability state serves.
    const availability = (await createDefinitionAvailability({ definitions: registry, modules, capabilities: { state: () => decodeModuleState("") } })).snapshot();
    const relative = (file: string): string => path.relative(repoRoot, fs.realpathSync(file)).split(path.sep).join("/");
    const skillDirs = new Map([...revision.skills.skills.values()].flatMap((skill) => skill.source.kind === "filesystem" ? [[skill.id, `${relative(skill.source.canonicalDir)}/`] as const] : []));

    const toolModules = new Map<string, string[]>();
    const terms: CapabilityModuleTerms[] = modules.map((module) => {
      const tools = module.contributions.flatMap((contribution) => {
        if (contribution.domain !== "tools") return [];
        const registrations = Object.entries(contribution.value.declaration.registrations);
        const required = [module.id, ...registrations.flatMap(([, registration]) => registration.capabilities)];
        const names = [contribution.value.name, ...registrations.flatMap(([id, registration]) => [id, ...("exposedName" in registration && typeof registration.exposedName === "string" ? [registration.exposedName] : [])])];
        for (const name of names) toolModules.set(name, [...new Set([...toolModules.get(name) ?? [], ...required])]);
        return names;
      });
      const home = moduleHomes(module.id);
      const skills = [...skillDirs].filter(([, dir]) => isUnderAny(dir, home)).map(([id]) => id);
      const entry = CAPABILITY_PHRASES[module.id];
      return { id: module.id, tools: [...new Set(tools)], skills, phrases: entry?.phrases ?? [], guards: entry?.guards ?? [], homes: [...home, ...entry?.sources ?? []], harnesses: entry?.harnesses ?? [] };
    });

    // A shared reference renders inside every skill that expands it, so it needs what all of them need.
    const referenceRequires = new Map<string, Set<string>>();
    for (const skill of revision.skills.skills.values()) {
      const requires = needs(availability.skills.get(skill.id)) ?? [];
      for (const match of skill.body.matchAll(/\{\{ref:([a-z0-9-]+)\}\}/g)) {
        const name = match[1] ?? "";
        const held = referenceRequires.get(name);
        referenceRequires.set(name, held ? new Set(requires.filter((module) => held.has(module))) : new Set(requires));
      }
    }
    const personaDir = "src/workflows/agents/personas";
    return {
      modules: terms,
      types: typeTerms(revision.personaRevision.personas),
      termModules: (term) => {
        if (term.startsWith("skill:")) return needs(availability.skills.get(term.slice("skill:".length)));
        if (term.startsWith("persona:")) return needs(availability.personas.get(term.slice("persona:".length)));
        if (term.startsWith("type:")) {
          const type = term.slice("type:".length);
          // A type holds while one of its personas is available, which needs what every persona needs: dispatch.
          const persona = [...revision.personaRevision.personas.values()].find((agent) => agentTypeOf(agent) === type || parentRoleId(agentTypeOf(agent)) === type);
          return persona === undefined ? undefined : [...availability.personas.get(persona.name)?.requires ?? [], ...typeCapabilities([type])];
        }
        return toolModules.get(term);
      },
      definitions: [
        ...[...skillDirs].map(([id, dir]) => ({ path: dir, requires: needs(availability.skills.get(id)) ?? [] })),
        ...[...availability.personas].map(([name, entry]) => ({ path: `${personaDir}/${name}.md`, requires: needs(entry) ?? [] })),
        ...[...referenceRequires].map(([name, requires]) => ({ path: `src/agent-skills/references/${name}.md`, requires: [...requires] })),
      ],
    };
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}
