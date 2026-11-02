import * as fs from "node:fs";
import * as path from "node:path";
import { declaredFactRetentionTypes, factOwner } from "../src/infra/fact-retention-registry.js";
import { DEVELOPMENT_MODULES } from "../src/orchestration/development-modules.js";
import { SHIPPED_MODULES } from "../src/orchestration/modules.js";
import { MODULE_IDS } from "../src/protocol/module-ids.js";
import { PROTOCOL_MODULES } from "../src/protocol/modules.js";
import { isUnderAny, MODULE_REGISTRIES, moduleFactHomes, moduleHomeId, moduleHomeImportViolation, moduleHomes } from "./module-homes.js";
import { MODULE_CONTAINMENT_ALLOWLIST, type ModuleContainmentAllowance } from "./module-containment-allowlist.js";
import { scanSourceImports, type SourceImport } from "./source-imports.js";

// A module's vocabulary is its id, its protocol domains with their snapshot
// query discriminants, and the fact families it owns. Each may be named only
// inside the module's homes and in the few kernel files that hold every
// module's vocabulary by design: the registries, the wire vocabulary, and the
// readers that present or maintain every fact family. Anything else is a
// leak. The empty allowlist is permanent: a new capability extends its homes
// and registries instead of adding an exception.
//
// A module id is matched only in a file that handles module ids, which is
// one that imports the module system (a path whose basename names a module
// file: `modules`, `module-ids`, `module-policy`, `tui-module`) or is such a
// file itself. The short ids are also a shell program, a tool name, a
// directory name, and an OAuth step, and a literal scan cannot tell those
// apart; a file that holds an id as a module id types it, and typing it
// means importing the vocabulary. A module home may name any module id,
// because the contract declares dependencies and tool capabilities by id.
// Domain and fact literals are distinctive and are matched everywhere.

export interface ModuleVocabulary {
  readonly moduleIds: readonly string[];
  /** Domain names and snapshot query discriminants, each with its owning module. */
  readonly domains: readonly { readonly literal: string; readonly module: string }[];
  /** The fact families a module owns; kernel families are not scanned. */
  readonly facts: readonly { readonly type: string; readonly module: string }[];
}

export interface ModuleVocabularyViolation {
  readonly path: string;
  readonly line: number;
  readonly literal: string;
  readonly module: string;
  readonly rule: "module-id" | "protocol-domain" | "fact-family";
}

export interface ModuleVocabularyReport {
  readonly violations: readonly ModuleVocabularyViolation[];
  /** Allowances that matched no hit, so the list can only shrink. */
  readonly stale: readonly ModuleContainmentAllowance[];
}

export interface ModuleContainmentRegistry {
  readonly catalog: readonly { readonly id: string; readonly protocol?: { readonly contract: { readonly id: string } } }[];
  readonly protocol: readonly { readonly id: string }[];
  readonly tui: readonly { readonly id: string }[];
  readonly web: readonly { readonly id: string }[];
  readonly homes: {
    readonly orchestration: readonly string[];
    readonly protocol: readonly string[];
    readonly tui: readonly string[];
    readonly web: readonly string[];
  };
}

type RegistryLayer = "catalog" | "protocol" | "tui" | "web";

function duplicateIds(layer: RegistryLayer, entries: readonly { readonly id: string }[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const entry of entries) {
    if (seen.has(entry.id)) duplicates.add(entry.id);
    seen.add(entry.id);
  }
  return [...duplicates].map((id) => `${layer} registry declares duplicate module id "${id}"`);
}

export function findModuleRegistryViolations(registry: ModuleContainmentRegistry): readonly string[] {
  const failures = ([
    ...duplicateIds("catalog", registry.catalog),
    ...duplicateIds("protocol", registry.protocol),
    ...duplicateIds("tui", registry.tui),
    ...duplicateIds("web", registry.web),
  ]);
  const catalogIds = new Set(registry.catalog.map((module) => module.id));
  const protocolById = new Map(registry.protocol.map((module) => [module.id, module]));

  for (const layer of ["protocol", "tui", "web"] as const) {
    for (const module of registry[layer]) {
      if (!catalogIds.has(module.id)) failures.push(`${layer} registry module "${module.id}" is absent from the orchestration catalog`);
    }
  }

  for (const module of registry.catalog) {
    const contract = module.protocol?.contract;
    if (!contract) continue;
    if (contract.id !== module.id) failures.push(`orchestration module "${module.id}" binds protocol contract "${contract.id}"`);
    const registered = protocolById.get(contract.id);
    if (!registered) {
      failures.push(`orchestration module "${module.id}" binds a protocol contract absent from the protocol registry`);
    } else if (registered !== contract) {
      failures.push(`orchestration module "${module.id}" does not bind the registered "${contract.id}" protocol contract`);
    }
  }

  for (const protocol of registry.protocol) {
    const owners = registry.catalog.filter((module) => module.protocol?.contract === protocol);
    if (owners.length === 0) failures.push(`protocol module "${protocol.id}" has no orchestration binding`);
    if (owners.length > 1) failures.push(`protocol module "${protocol.id}" has ${owners.length} orchestration bindings`);
  }

  const registryIds = {
    orchestration: catalogIds,
    protocol: new Set(registry.protocol.map((module) => module.id)),
    tui: new Set(registry.tui.map((module) => module.id)),
    web: new Set(registry.web.map((module) => module.id)),
  };
  for (const layer of ["orchestration", "protocol", "tui", "web"] as const) {
    const homes = new Set(registry.homes[layer]);
    for (const id of registryIds[layer]) {
      if (!homes.has(id)) failures.push(`${layer === "orchestration" ? "catalog" : `${layer} registry`} module "${id}" has no canonical home`);
    }
    for (const id of homes) {
      if (!registryIds[layer].has(id)) failures.push(`${layer} module home "${id}" has no registry entry`);
    }
  }

  return failures.toSorted();
}

export interface ModuleHomeImportViolation {
  readonly path: string;
  readonly line: number;
  readonly target: string;
  readonly module: string;
}

export function findModuleHomeImportViolations(imports: readonly SourceImport[], moduleIds: readonly string[]): readonly ModuleHomeImportViolation[] {
  return imports.flatMap((importRef) => {
    if (/\.test\.tsx?$/.test(importRef.sourcePath)) return [];
    const module = moduleHomeImportViolation(importRef.sourcePath, importRef.targetPath, moduleIds);
    return module === undefined ? [] : [{ path: importRef.sourcePath, line: importRef.line, target: importRef.targetPath, module }];
  });
}

/** Roots that ship to users; tests may name any module they exercise. */
const SCAN_ROOTS = ["src", "webview/src", "webview/phone", "vscode/src", "relay"];
const NON_SOURCE_DIRS = new Set(["node_modules", "dist", "out"]);

// The retention registry names every family's owner by module id.
const MODULE_ID_READERS: readonly string[] = [...MODULE_REGISTRIES, "src/protocol/module-ids.ts", "src/orchestration/development-modules.ts", "src/infra/fact-retention-registry.ts"];
const DOMAIN_READERS: readonly string[] = ["src/protocol/modules.ts", "src/protocol/protocol-module.ts"];
// The retention registry classifies every family, `events search` presents
// every family, and maintenance prunes the retired ones.
const FACT_READERS: readonly string[] = [
  "src/infra/fact-retention-registry.ts",
  "src/cli/event-search-format.ts",
  "src/orchestration/session/event-store-maintenance.ts",
];

const MODULE_SYSTEM_FILE = /(^|-)modules?(-|\.|$)/;
const IMPORT_SPECIFIER = /(?:\bfrom|\bimport\s*\()\s*["']([^"']+)["']/g;
/** A quoted token spelled like an id, a domain, or a fact type. */
const QUOTED_TOKEN = /(["'])([A-Za-z0-9_.-]+)\1/g;

function listSourceFiles(dir: string, out: string[]): void {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!NON_SOURCE_DIRS.has(entry.name)) listSourceFiles(full, out);
      continue;
    }
    if (!entry.isFile() || !/\.tsx?$/.test(entry.name)) continue;
    if (entry.name.endsWith(".d.ts") || /\.test\.tsx?$/.test(entry.name)) continue;
    out.push(full);
  }
}

function handlesModuleIds(relPath: string, source: string): boolean {
  if (MODULE_SYSTEM_FILE.test(path.basename(relPath))) return true;
  for (const match of source.matchAll(IMPORT_SPECIFIER)) {
    const specifier = match[1];
    if (specifier !== undefined && MODULE_SYSTEM_FILE.test(path.basename(specifier))) return true;
  }
  return false;
}

function lineOf(source: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i++) if (source.charCodeAt(i) === 10) line++;
  return line;
}

interface Term {
  readonly literal: string;
  readonly module: string;
  readonly rule: ModuleVocabularyViolation["rule"];
  /** Where the literal is at home; a module id is at home in every module home. */
  readonly homes: readonly string[];
  readonly readers: readonly string[];
  readonly onlyWhereModuleIdsAreHandled: boolean;
}

function terms(vocabulary: ModuleVocabulary): ReadonlyMap<string, readonly Term[]> {
  const byLiteral = new Map<string, Term[]>();
  const add = (term: Term): void => {
    const existing = byLiteral.get(term.literal);
    if (existing) existing.push(term);
    else byLiteral.set(term.literal, [term]);
  };
  const everyHome = vocabulary.moduleIds.flatMap(moduleHomes);
  for (const id of vocabulary.moduleIds) {
    add({ literal: id, module: id, rule: "module-id", homes: everyHome, readers: MODULE_ID_READERS, onlyWhereModuleIdsAreHandled: true });
  }
  for (const domain of vocabulary.domains) {
    add({ literal: domain.literal, module: domain.module, rule: "protocol-domain", homes: moduleHomes(domain.module), readers: DOMAIN_READERS, onlyWhereModuleIdsAreHandled: false });
  }
  for (const fact of vocabulary.facts) {
    add({ literal: fact.type, module: fact.module, rule: "fact-family", homes: [...moduleHomes(fact.module), ...moduleFactHomes(fact.module)], readers: FACT_READERS, onlyWhereModuleIdsAreHandled: false });
  }
  return byLiteral;
}

const allowanceKey = (allowance: { readonly path: string; readonly literal: string }): string => `${allowance.path}\u0000${allowance.literal}`;

export function findModuleVocabularyViolations(repoRoot: string, vocabulary: ModuleVocabulary, allowlist: readonly ModuleContainmentAllowance[]): ModuleVocabularyReport {
  const byLiteral = terms(vocabulary);
  const files: string[] = [];
  for (const root of SCAN_ROOTS) {
    const dir = path.join(repoRoot, root);
    if (fs.existsSync(dir)) listSourceFiles(dir, files);
  }

  const allowed = new Map(allowlist.filter((allowance) => !allowance.literal.includes("/")).map((allowance) => [allowanceKey(allowance), allowance]));
  const used = new Set<string>();
  const violations: ModuleVocabularyViolation[] = [];

  for (const file of files) {
    const relPath = path.relative(repoRoot, file).split(path.sep).join("/");
    const source = fs.readFileSync(file, "utf8");
    const handlesIds = handlesModuleIds(relPath, source);
    const reported = new Set<string>();
    for (const match of source.matchAll(QUOTED_TOKEN)) {
      const literal = match[2];
      if (literal === undefined || reported.has(literal)) continue;
      const candidates = byLiteral.get(literal);
      if (!candidates) continue;
      // One spelling can be both a module id and that module's domain. A file
      // that is at home with, or a reader of, either reading may spell it;
      // otherwise the first reading that applies here is the leak, and one
      // report per literal per file is what an allowance names.
      const atHome = candidates.some((candidate) => isUnderAny(relPath, candidate.homes) || isUnderAny(relPath, candidate.readers));
      const term = atHome ? undefined : candidates.find((candidate) => !(candidate.onlyWhereModuleIdsAreHandled && !handlesIds));
      if (!term) continue;
      reported.add(literal);
      const key = allowanceKey({ path: relPath, literal });
      if (allowed.has(key)) {
        used.add(key);
        continue;
      }
      violations.push({ path: relPath, line: lineOf(source, match.index ?? 0), literal, module: term.module, rule: term.rule });
    }
  }

  // An entry that names a term outside every vocabulary can never match, and
  // is reported here rather than silently kept.
  const stale = [...allowed.values()].filter((allowance) => !used.has(allowanceKey(allowance)));
  return { violations, stale };
}

function realVocabulary(): ModuleVocabulary {
  return {
    moduleIds: MODULE_IDS,
    domains: PROTOCOL_MODULES.flatMap((module) => module.domains.flatMap((domain) => [
      { literal: domain.domain, module: module.id },
      { literal: domain.snapshot.query, module: module.id },
    ])),
    facts: declaredFactRetentionTypes().flatMap((type) => {
      const owner = factOwner(type);
      return owner === undefined || owner === "kernel" ? [] : [{ type, module: owner }];
    }),
  };
}

export function discoverModuleHomes(repoRoot: string): ModuleContainmentRegistry["homes"] {
  const discover = (root: string): readonly string[] => {
    const absoluteRoot = path.join(repoRoot, root);
    if (!fs.existsSync(absoluteRoot)) return [];
    const ids = new Set<string>();
    for (const entry of fs.readdirSync(absoluteRoot, { withFileTypes: true })) {
      if (entry.isFile() && /\.tsx?$/.test(entry.name)) ids.add(entry.name.replace(/\.tsx?$/, ""));
      if (entry.isDirectory()) {
        const files: string[] = [];
        listSourceFiles(path.join(absoluteRoot, entry.name), files);
        if (files.length > 0) ids.add(entry.name);
      }
    }
    return [...ids].toSorted();
  };
  return {
    orchestration: discover("src/orchestration/modules"),
    protocol: discover("src/protocol/modules"),
    tui: discover("src/tui/modules"),
    web: discover("webview/src/modules"),
  };
}

export function clientRegistryEntries(imports: readonly SourceImport[], registryPath: string, source: string, declarationName: string): readonly { readonly id: string }[] {
  const targetBySpecifier = new Map(imports.filter((entry) => entry.sourcePath === registryPath).map((entry) => [entry.specifier, entry.targetPath]));
  const targetByLocalName = new Map<string, string>();
  const importPattern = /(?:^|\n)\s*import\s+(?!type\b)\{([^}]+)\}\s+from\s+["']([^"']+)["']/g;
  for (const match of source.matchAll(importPattern)) {
    const bindings = match[1];
    const specifier = match[2];
    const target = specifier === undefined ? undefined : targetBySpecifier.get(specifier);
    if (!bindings || !target) continue;
    for (const binding of bindings.split(",")) {
      const parts = binding.trim().split(/\s+as\s+/);
      const localName = parts.at(-1);
      if (localName) targetByLocalName.set(localName, target);
    }
  }

  const declaration = source.match(new RegExp(`\\bexport\\s+const\\s+${declarationName}\\s*=\\s*\\[([^\\]]*)\\]`));
  const elements = declaration?.[1]?.split(",").map((element) => element.trim()).filter((element) => element.length > 0);
  if (!elements) throw new Error(`${registryPath} must declare ${declarationName} as an array`);
  return elements.map((element) => {
    if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(element)) throw new Error(`${registryPath} ${declarationName} entries must be imported module identifiers`);
    const target = targetByLocalName.get(element);
    const id = target === undefined ? undefined : moduleHomeId(target);
    if (id === undefined) throw new Error(`${registryPath} ${declarationName} entry ${element} must come from a canonical module home`);
    return { id };
  });
}

if (import.meta.main) {
  const repoRoot = path.resolve(import.meta.dir, "..");
  const { imports } = scanSourceImports(repoRoot, SCAN_ROOTS);
  const report = findModuleVocabularyViolations(repoRoot, realVocabulary(), MODULE_CONTAINMENT_ALLOWLIST);
  const homes = discoverModuleHomes(repoRoot);
  const discoveredIds = [...new Set(Object.values(homes).flat())];
  const importViolations = findModuleHomeImportViolations(imports, discoveredIds);
  const registryViolations = findModuleRegistryViolations({
    catalog: [...SHIPPED_MODULES, ...DEVELOPMENT_MODULES],
    protocol: PROTOCOL_MODULES,
    tui: clientRegistryEntries(imports, "src/tui/modules.ts", fs.readFileSync(path.join(repoRoot, "src/tui/modules.ts"), "utf8"), "TUI_MODULES"),
    web: clientRegistryEntries(imports, "webview/src/modules.ts", fs.readFileSync(path.join(repoRoot, "webview/src/modules.ts"), "utf8"), "WEB_MODULES"),
    homes,
  });
  for (const violation of report.violations) {
    console.error(`module-containment: ${violation.path}:${violation.line} names "${violation.literal}" (${violation.rule} of ${violation.module}) outside that module's homes`);
  }
  for (const violation of importViolations) {
    console.error(`module-containment: ${violation.path}:${violation.line} imports ${violation.target} from the ${violation.module} module outside its homes and registries`);
  }
  for (const violation of registryViolations) {
    console.error(`module-containment: ${violation}`);
  }
  for (const allowance of report.stale) {
    console.error(`module-containment: stale allowance ${allowance.path} "${allowance.literal}" (unit ${allowance.unit}) no longer matches; remove it from scripts/module-containment-allowlist.ts`);
  }
  const problems = report.violations.length + importViolations.length + registryViolations.length + report.stale.length;
  if (problems > 0) {
    console.error(`\nmodule-containment: ${problems} problem(s). Module registries, homes, imports, ids, domains, and fact families must agree.`);
    process.exit(1);
  }
  console.log(`module-containment: ${MODULE_CONTAINMENT_ALLOWLIST.length} allowed leak(s) remain`);
}
