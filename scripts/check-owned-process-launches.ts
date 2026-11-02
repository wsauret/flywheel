import * as fs from "node:fs";
import * as path from "node:path";
import type { Node, Tree } from "web-tree-sitter";
import { loadTreeSitterParser } from "../src/infra/tree-sitter-parser.js";

// Every external process Flywheel starts must come from the owned boundary
// (ARCH-TOOLS-022): `spawnOwned`, `runOwnedCommand`, or `openExternalUrl`. Only the
// raw-launch authority modules below hold the platform primitives. This gate
// walks the production roots and rejects any other way to reach a child
// process: a direct, computed, reflected, aliased or destructured Bun spawn, a
// Node child-process module however it is reached, a launcher taken out of a
// package this repository does not own, a Deno command, a Bun shell, a
// `globalThis` escape, a module load this gate cannot classify, an import of a
// raw-launch symbol outside the authority modules, or an authority module that
// exports its raw capability.
//
// It judges provenance, not names. A launch capability enters a file through
// an import, `Bun`, or a `globalThis` escape, and it then flows through
// aliases, assignments, destructuring, object literals and `Reflect.get`. Only
// a name that carries that provenance is a launcher, so an ordinary domain
// method called `spawn` or `execFile` passes, and a launcher renamed twice
// still fails. A module whose specifier the gate cannot read, or one this
// repository does not own, is opaque: its namespace is assumed to carry every
// capability.
//
// It reads the real syntax tree, not a hand-written lexer, so a launch cannot
// hide behind anything a parser understands and this gate did not: `Bun.spawn`,
// `Bun["spawn"]` and `Reflect.get(Bun, "spawn")` are the same access, and the
// gate sees them as one. Where the parser reports an error the file fails
// closed, because syntax nothing can classify can hide a launch.

export interface OwnedProcessViolation {
  file: string;
  line: number;
  rule: string;
  detail: string;
}

/** Roots that ship to users. Everything else (tests, benches, build scripts,
 *  vendored harnesses) may launch processes on its own terms. */
const PRODUCTION_ROOTS = ["src", "bin/flywheel", "scripts/dev.ts", "scripts/source-cli.ts", "scripts/project-executor.ts"] as const;

/** Roots the console rule covers, which is everything this repository runs.
 *  Ownership is a production concern, but a console window is not: Windows
 *  gives a fresh one to any console program started by a process that holds
 *  none, and a test or build script that opens a window opens it on the
 *  developer's screen just the same. */
const CONSOLE_ROOTS = ["src", "scripts", "tests", "bench", "bin/flywheel"] as const;

/** The only modules allowed to hold a raw platform launch. */
export const RAW_LAUNCH_AUTHORITY_FILES: ReadonlySet<string> = new Set([
  "src/infra/owned-subprocess-backend.ts",
  "src/infra/inherited-command.ts",
  "src/infra/process-container.ts",
  "src/infra/owned-command-supervisor.ts",
  "src/infra/process-supervisor.ts",
  "src/infra/persistent-subprocess.ts",
  "src/infra/windows-private-directory-acl.ts",
  "src/infra/foreground-successor.ts",
]);

/** Exported symbols of the authority modules that build a launcher inside
 *  their own body, where provenance cannot see it. Only policy says which of
 *  those may cross the authority boundary, so this list states it. A launcher
 *  the provenance analysis can see never needs a name here: `no-exported-raw-
 *  launch` stops it at the export. Signalling and settlement symbols
 *  (`ownedProcessBackend`, `emptyContainers`) are deliberately absent: the
 *  guardian owns containers it never started. */
const RAW_LAUNCH_FACTORY_SYMBOLS: ReadonlySet<string> = new Set([
  "createOwnedProcessBackend",
  "unixContainer",
  "ownUnixContainer",
  "commandSupervisorArgv",
  "persistentSubprocessPlatform",
]);

const AUTHORITY_MODULE_STEMS: ReadonlySet<string> = new Set(
  [...RAW_LAUNCH_AUTHORITY_FILES].map((file) => path.basename(file).replace(/\.ts$/, "")),
);

/** Every name that reaches a child process on `Bun`, on a `child_process`
 *  namespace, or on any namespace this gate cannot account for. */
const LAUNCH_MEMBERS: ReadonlySet<string> = new Set([
  "spawn",
  "spawnSync",
  "exec",
  "execSync",
  "execFile",
  "execFileSync",
  "fork",
]);
const GLOBAL_ESCAPE_MEMBERS: ReadonlySet<string> = new Set(["Bun", "Deno", "process", "require"]);

/** Installed dependencies are not this repository's production code. Nothing
 *  else is skipped: a directory under `src` named `fixtures`, `generated` or
 *  `vendor` still ships, so it is still scanned. Test roots are excluded by
 *  not being production roots at all, and a symlink is never followed. */
const SKIPPED_DIRECTORIES: ReadonlySet<string> = new Set(["node_modules"]);

/** Run output that benchmarks and end-to-end tests write into the tree: agent
 *  workspaces and copied fixtures that this repository never runs. These are
 *  the generated-output paths `.gitignore` names; a benchmark run alone can
 *  leave tens of thousands of files there. */
const GENERATED_OUTPUT = /^(bench\/[^/]+|tests\/e2e)\/results$/;

const CHILD_PROCESS_SPECIFIER = /^(node:)?child_process$/;

/** Extensions the runtime executes. A declaration file binds nothing at
 *  runtime, so it cannot hold a launch. */
const EXECUTABLE_SOURCE = /\.[mc]?[jt]sx?$/;
const DECLARATION_SOURCE = /\.d\.[mc]?ts$/;
const JSX_SOURCE = /\.[jt]sx$/;

export async function findOwnedProcessLaunchViolations(repoRoot: string): Promise<OwnedProcessViolation[]> {
  const violations: OwnedProcessViolation[] = [];
  const production = new Set(listFilesUnder(repoRoot, PRODUCTION_ROOTS));
  for (const file of production) {
    const relFile = path.relative(repoRoot, file).split(path.sep).join("/");
    const text = fs.readFileSync(file, "utf8");
    if (EXECUTABLE_SOURCE.test(relFile)) await collectSourceViolations(violations, relFile, text);
    else collectShellViolations(violations, relFile, text);
  }
  // Everything else this repository runs is read for the console rule alone.
  for (const file of listFilesUnder(repoRoot, CONSOLE_ROOTS)) {
    if (production.has(file)) continue;
    const relFile = path.relative(repoRoot, file).split(path.sep).join("/");
    if (!EXECUTABLE_SOURCE.test(relFile) || CONSOLE_RULE_EXEMPT.has(relFile)) continue;
    await collectConsoleOnlyViolations(violations, relFile, fs.readFileSync(file, "utf8"));
  }
  return violations.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.rule.localeCompare(b.rule));
}

/** Files whose launch text is a string fixture describing code for this gate to
 *  scan, rather than a launch the file performs. */
const CONSOLE_RULE_EXEMPT: ReadonlySet<string> = new Set([
  "tests/unit/scripts/check-owned-process-launches.test.ts",
  "tests/unit/scripts/check-terminal-io.test.ts",
]);

async function collectConsoleOnlyViolations(out: OwnedProcessViolation[], file: string, text: string): Promise<void> {
  // The console rule matches a callee whose source text is `Bun.spawn` or
  // `Bun.spawnSync`, so a file without that text cannot fail it, and most
  // files are never parsed.
  if (!text.includes("Bun.spawn")) return;
  const parser = await loadTreeSitterParser(JSX_SOURCE.test(file) ? "tsx" : "typescript");
  const tree: Tree | null = parser.parse(text);
  if (!tree) throw new Error(`owned-processes: failed to parse ${file}`);
  try {
    visit(tree.rootNode, (node) => {
      if (node.type === "call_expression") collectConsoleViolations(out, file, node);
    });
  } finally {
    tree.delete();
  }
}

function listFilesUnder(repoRoot: string, roots: readonly string[]): string[] {
  const files: string[] = [];
  for (const root of roots) {
    const full = path.join(repoRoot, root);
    // `lstat` on purpose: a symlinked root or entry points outside the audited
    // tree, and its target is not this repository's production code.
    const stat = fs.existsSync(full) ? fs.lstatSync(full) : undefined;
    if (stat?.isDirectory() === true) collectDirectory(repoRoot, full, files);
    else if (stat?.isFile() === true) files.push(full);
  }
  return files.sort();
}

function collectDirectory(repoRoot: string, dirPath: string, out: string[]): void {
  for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
    const full = path.join(dirPath, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      const relDir = path.relative(repoRoot, full).split(path.sep).join("/");
      if (!SKIPPED_DIRECTORIES.has(entry.name) && !GENERATED_OUTPUT.test(relDir)) collectDirectory(repoRoot, full, out);
      continue;
    }
    if (!entry.isFile()) continue;
    if (!EXECUTABLE_SOURCE.test(entry.name) || DECLARATION_SOURCE.test(entry.name)) continue;
    out.push(full);
  }
}

// --- syntax ----------------------------------------------------------------

function namedChildren(node: Node): Node[] {
  return node.namedChildren.filter((child): child is Node => child !== null);
}

function lineOf(node: Node): number {
  return node.startPosition.row + 1;
}

/** The value of a string literal node, without its quotes. */
function stringValue(node: Node | null): string | undefined {
  if (node?.type !== "string") return undefined;
  return node.text.slice(1, -1);
}

/** The first node the parser could not classify. Its line is where a reader
 *  should start looking. */
function firstError(node: Node): Node | undefined {
  if (node.type === "ERROR" || node.isMissing) return node;
  if (!node.hasError) return undefined;
  for (const child of node.children) {
    if (!child) continue;
    const found = firstError(child);
    if (found) return found;
  }
  return undefined;
}

// --- rules -----------------------------------------------------------------

async function collectSourceViolations(out: OwnedProcessViolation[], file: string, text: string): Promise<void> {
  const parser = await loadTreeSitterParser(JSX_SOURCE.test(file) ? "tsx" : "typescript");
  const tree: Tree | null = parser.parse(text);
  if (!tree) throw new Error(`owned-processes: failed to parse ${file}`);
  try {
    const isAuthority = RAW_LAUNCH_AUTHORITY_FILES.has(file);
    if (tree.rootNode.hasError) {
      const error = firstError(tree.rootNode);
      out.push({ file, line: error ? lineOf(error) : 1, rule: "unclassifiable-source", detail: "syntax this gate cannot classify" });
    }
    const provenance = fileProvenance(tree.rootNode);
    visit(tree.rootNode, (node) => { collectNodeViolations(out, file, isAuthority, node, provenance); });
  } finally {
    tree.delete();
  }
}

function visit(node: Node, inspect: (node: Node) => void): void {
  inspect(node);
  for (const child of namedChildren(node)) visit(child, inspect);
}

function collectNodeViolations(out: OwnedProcessViolation[], file: string, isAuthority: boolean, node: Node, provenance: Provenance): void {
  switch (node.type) {
    case "import_statement":
      collectImportViolations(out, file, isAuthority, node);
      return;
    case "export_statement":
      collectExportViolations(out, file, isAuthority, node, provenance);
      return;
    case "call_expression":
      collectCallViolations(out, file, isAuthority, node, provenance);
      if (isAuthority) collectConsoleViolations(out, file, node);
      return;
    case "member_expression":
    case "subscript_expression":
      collectAccessViolations(out, file, isAuthority, node, node.childForFieldName("object"), accessedName(node), provenance);
      return;
    case "variable_declarator":
      collectPatternViolations(out, file, isAuthority, node.childForFieldName("name"), node.childForFieldName("value"), provenance);
      return;
    case "assignment_expression":
      collectPatternViolations(out, file, isAuthority, node.childForFieldName("left"), node.childForFieldName("right"), provenance);
      return;
    default:
      return;
  }
}

/** The property being read, or undefined when it is computed from a value this
 *  gate cannot see. An unreadable property on a capability is itself the
 *  finding: it is exactly where a launcher hides. */
function accessedName(node: Node): string | undefined {
  if (node.type === "member_expression") return node.childForFieldName("property")?.text;
  return stringValue(node.childForFieldName("index"));
}

// --- provenance ------------------------------------------------------------

/** What one file taught this gate about its own names: which hold a launch
 *  capability, which load a module when they are called, and which module
 *  loads are classified somewhere other than at the load itself. */
interface Provenance {
  readonly carriers: ReadonlySet<string>;
  readonly loaders: ReadonlySet<string>;
  readonly paths: ReadonlySet<string>;
  readonly forwardedLoads: ReadonlySet<number>;
}

/** Expressions that pass their operand through unchanged. */
const TRANSPARENT_EXPRESSIONS: ReadonlySet<string> = new Set([
  "await_expression",
  "parenthesized_expression",
  "non_null_expression",
  "as_expression",
  "satisfies_expression",
]);

function unwrap(node: Node): Node {
  if (!TRANSPARENT_EXPRESSIONS.has(node.type)) return node;
  const inner = namedChildren(node)[0];
  return inner ? unwrap(inner) : node;
}

function callArguments(node: Node): Node[] {
  return namedChildren(node.childForFieldName("arguments") ?? node).filter((child) => child.type !== "comment");
}

interface ModuleLoad {
  /** Undefined when the argument is not a literal this gate can read. */
  readonly specifier: string | undefined;
  /** The expression that named the module, whatever this gate made of it. */
  readonly argument: Node | null;
  /** The `type` of the import attribute the load carries, when it carries one. */
  readonly attributeType: string | undefined;
}

/** What a module-loading call loads. Every way to reach a module at runtime is
 *  one: `import(...)`, `require(...)`, a builtin taken off `process`, whatever
 *  `createRequire` handed back, and any name this file bound to one of those. */
function moduleLoad(node: Node, provenance: Provenance): ModuleLoad | undefined {
  if (node.type !== "call_expression") return undefined;
  const callee = node.childForFieldName("function");
  if (!callee || !isModuleLoader(callee, provenance)) return undefined;
  const args = callArguments(node);
  return { specifier: stringValue(args[0] ?? null), argument: args[0] ?? null, attributeType: attributeType(args[1] ?? null) };
}

function isModuleLoader(callee: Node, provenance: Provenance): boolean {
  const target = unwrap(callee);
  switch (target.type) {
    case "import":
      return true;
    case "identifier":
      return target.text === "require" || provenance.loaders.has(target.text);
    case "member_expression":
    case "subscript_expression":
      return isBuiltinModuleLoader(target.childForFieldName("object"), accessedName(target));
    default:
      return isRequireFactory(target);
  }
}

/** `process.getBuiltinModule` reaches a builtin module without importing it. */
function isBuiltinModuleLoader(object: Node | null, name: string | undefined): boolean {
  return object?.text === "process" && name === "getBuiltinModule";
}

/** `createRequire(...)` hands back a loader, so calling its result loads a
 *  module and the name its result lands on is a loader too. */
function isRequireFactory(node: Node): boolean {
  if (node.type !== "call_expression") return false;
  const callee = node.childForFieldName("function");
  const target = callee ? unwrap(callee) : undefined;
  if (target?.type === "identifier") return target.text === "createRequire";
  return target?.type === "member_expression" && target.childForFieldName("property")?.text === "createRequire";
}

/** The `type` of an import attribute: `import(m, { with: { type: "wasm" } })`. */
function attributeType(node: Node | null): string | undefined {
  return stringValue(pairValue(pairValue(node, "with"), "type"));
}

/** Asset types no launch capability can come out of. */
const NON_EXECUTABLE_ATTRIBUTES: ReadonlySet<string> = new Set(["wasm", "json"]);

function isNonExecutableAsset(type: string | undefined): boolean {
  return type !== undefined && NON_EXECUTABLE_ATTRIBUTES.has(type);
}

function pairValue(object: Node | null, key: string): Node | null {
  if (object?.type !== "object") return null;
  const pair = namedChildren(object).find((child) => child.type === "pair" && child.childForFieldName("key")?.text === key);
  return pair?.childForFieldName("value") ?? null;
}

/** A module whose export surface this gate cannot account for. Modules of this
 *  repository are scanned in their own right, and `child_process` is rejected
 *  at the import itself, so neither needs a namespace tracked. */
function isOpaqueSpecifier(specifier: string | undefined): boolean {
  if (specifier === undefined) return true;
  if (specifier.startsWith(".")) return false;
  return !CHILD_PROCESS_SPECIFIER.test(specifier);
}

/** `Reflect.get(target, "name")` names a property without writing it as one. */
function reflectedAccess(node: Node): { readonly object: Node | null; readonly name: string | undefined } | undefined {
  if (node.type !== "call_expression") return undefined;
  const callee = node.childForFieldName("function");
  if (callee?.type !== "member_expression") return undefined;
  if (callee.childForFieldName("object")?.text !== "Reflect") return undefined;
  if (callee.childForFieldName("property")?.text !== "get") return undefined;
  const args = callArguments(node);
  return { object: args[0] ?? null, name: stringValue(args[1] ?? null) };
}

/** Whether the expression yields something that can hand out a launcher. */
function isCapabilitySource(node: Node | null, provenance: Provenance): boolean {
  if (!node) return false;
  const target = unwrap(node);
  switch (target.type) {
    case "identifier":
    case "shorthand_property_identifier":
      return target.text === "Bun" || provenance.carriers.has(target.text);
    case "member_expression":
    case "subscript_expression":
      return isCapabilityAccess(target.childForFieldName("object"), accessedName(target), provenance);
    default: {
      const load = moduleLoad(target, provenance);
      if (load) return isOpaqueSpecifier(load.specifier);
      const reflected = reflectedAccess(target);
      return reflected !== undefined && isCapabilityAccess(reflected.object, reflected.name, provenance);
    }
  }
}

/** Whether reading `name` off `object` yields a launch capability. An
 *  unreadable name is assumed to be the one that does. */
function isCapabilityAccess(object: Node | null, name: string | undefined, provenance: Provenance): boolean {
  if (object?.text === "globalThis") return name === undefined || GLOBAL_ESCAPE_MEMBERS.has(name);
  return isCapabilitySource(object, provenance) && (name === undefined || LAUNCH_MEMBERS.has(name));
}

/** A capability reaches a name directly, or inside a literal that holds it. */
function carriesCapability(node: Node | null, provenance: Provenance): boolean {
  if (!node) return false;
  const target = unwrap(node);
  if (isCapabilitySource(target, provenance)) return true;
  if (target.type !== "object" && target.type !== "array") return false;
  return namedChildren(target).some((element) => carriesCapability(elementValue(element), provenance));
}

function elementValue(element: Node): Node | null {
  if (element.type === "shorthand_property_identifier") return element;
  if (element.type === "spread_element") return namedChildren(element)[0] ?? null;
  return element.childForFieldName("value") ?? element;
}

const BINDING_SITES: ReadonlySet<string> = new Set([
  "variable_declarator",
  "assignment_expression",
  "import_statement",
  "for_in_statement",
]);

/** Every name in one file that holds a launch capability, loads a module, or
 *  names a file by path. Provenance flows from imports, aliases, assignments
 *  and destructuring, and a name can be bound before the name it came from is
 *  read, so the sets are grown to a fixed point. The scope is the whole file:
 *  a gate that fails closed does not need to model shadowing. */
function fileProvenance(root: Node): Provenance {
  const forwarding = specifierForwardingLoaders(root);
  const sites: Node[] = [];
  visit(root, (node) => {
    if (BINDING_SITES.has(node.type)) sites.push(node);
  });
  const carriers = new Set<string>();
  const loaders = new Set<string>(forwarding.names);
  const paths = new Set<string>();
  const provenance: Provenance = { carriers, loaders, paths, forwardedLoads: forwarding.loadIds };
  for (let grew = true; grew; ) {
    grew = false;
    for (const site of sites) {
      for (const name of boundPathNames(site, provenance)) grew = added(paths, name) || grew;
      for (const name of boundLoaderNames(site, provenance)) grew = added(loaders, name) || grew;
      for (const name of boundCapabilityNames(site, provenance)) grew = added(carriers, name) || grew;
    }
  }
  return provenance;
}

/** Calls that build a filesystem path out of their arguments. */
const PATH_BUILDERS: ReadonlySet<string> = new Set(["join", "resolve", "fileURLToPath"]);

/** Whether the expression is a filesystem path this file built, or a list of
 *  them. A path names a file, never a builtin module, so a load that asks for
 *  one cannot be a disguised `child_process`. */
function isPathExpression(node: Node | null, provenance: Provenance): boolean {
  if (!node) return false;
  const target = unwrap(node);
  if (target.type === "identifier") return provenance.paths.has(target.text);
  if (target.type === "array") {
    const elements = namedChildren(target);
    return elements.length > 0 && elements.every((element) => isPathExpression(elementValue(element), provenance));
  }
  if (target.type !== "call_expression") return false;
  const callee = target.childForFieldName("function");
  const name = callee?.type === "member_expression" ? callee.childForFieldName("property")?.text : callee?.text;
  return name !== undefined && PATH_BUILDERS.has(name);
}

function boundPathNames(site: Node, provenance: Provenance): readonly string[] {
  if (site.type === "import_statement") return [];
  const iterated = site.type === "for_in_statement";
  const assigned = site.type === "assignment_expression";
  const value = site.childForFieldName(iterated || assigned ? "right" : "value");
  const target = site.childForFieldName(iterated || assigned ? "left" : "name");
  if (target?.type !== "identifier" || !isPathExpression(value, provenance)) return [];
  return [target.text];
}

function added(names: Set<string>, name: string): boolean {
  if (names.has(name)) return false;
  names.add(name);
  return true;
}

/** A package this repository does not own is opaque, so both the namespace and
 *  the default export it hands over may carry anything, including a launcher.
 *  A module of this repository is scanned in its own right, so its default
 *  export is an ordinary value. */
function boundCapabilityNames(site: Node, provenance: Provenance): readonly string[] {
  if (site.type === "import_statement") {
    if (!isOpaqueSpecifier(stringValue(site.childForFieldName("source")))) return [];
    const imported = importedNames(site);
    return [imported.namespaceAlias, imported.defaultBinding].filter((name): name is string => name !== undefined);
  }
  const assigned = site.type === "assignment_expression";
  if (!carriesCapability(site.childForFieldName(assigned ? "right" : "value"), provenance)) return [];
  return boundNames(site.childForFieldName(assigned ? "left" : "name"));
}

function boundLoaderNames(site: Node, provenance: Provenance): readonly string[] {
  if (site.type === "import_statement") return [];
  const assigned = site.type === "assignment_expression";
  const value = site.childForFieldName(assigned ? "right" : "value");
  const target = site.childForFieldName(assigned ? "left" : "name");
  if (isLoaderExpression(value, provenance)) return target?.type === "identifier" ? [target.text] : [];
  if (target?.type !== "object_pattern" || !value) return [];
  const source = unwrap(value);
  return patternEntries(target).flatMap((entry) =>
    entry.local !== undefined && isBuiltinModuleLoader(source, entry.key) ? [entry.local] : [],
  );
}

/** Whether the expression is a loader itself, rather than a call of one. */
function isLoaderExpression(node: Node | null, provenance: Provenance): boolean {
  if (!node) return false;
  const target = unwrap(node);
  if (target.type === "identifier") return target.text === "require" || provenance.loaders.has(target.text);
  if (target.type === "member_expression" || target.type === "subscript_expression") {
    return isBuiltinModuleLoader(target.childForFieldName("object"), accessedName(target));
  }
  return isRequireFactory(target);
}

interface ForwardingLoaders {
  readonly names: ReadonlySet<string>;
  readonly loadIds: ReadonlySet<number>;
}

const FUNCTIONS: ReadonlySet<string> = new Set([
  "arrow_function",
  "function_expression",
  "function_declaration",
  "generator_function",
  "generator_function_declaration",
]);

/** A named local function that loads whatever module its own parameter names.
 *  Bun resolves a literal specifier when it builds, so this indirection is how
 *  a platform adapter reaches an optional dependency. The specifier is
 *  unreadable at the load and readable at every call, so the function's name
 *  is a loader and the load inside it is judged nowhere else. */
function specifierForwardingLoaders(root: Node): ForwardingLoaders {
  const names = new Set<string>();
  const loadIds = new Set<number>();
  visit(root, (node) => {
    if (!FUNCTIONS.has(node.type)) return;
    const name = functionBindingName(node);
    if (name === undefined) return;
    const forwarded = forwardedLoadIds(node, functionParameterNames(node));
    if (forwarded.length === 0) return;
    names.add(name);
    for (const id of forwarded) loadIds.add(id);
  });
  return { names, loadIds };
}

/** The name a function is reachable by: its own, or the one it was bound to. */
function functionBindingName(node: Node): string | undefined {
  if (node.type !== "arrow_function" && node.type !== "function_expression") return node.childForFieldName("name")?.text;
  const declarator = node.parent?.type === "variable_declarator" ? node.parent : undefined;
  const target = declarator?.childForFieldName("name");
  return target?.type === "identifier" ? target.text : undefined;
}

function functionParameterNames(node: Node): readonly string[] {
  const parameters = node.childForFieldName("parameters") ?? node.childForFieldName("parameter");
  if (!parameters) return [];
  if (parameters.type === "identifier") return [parameters.text];
  return namedChildren(parameters).flatMap((parameter) => {
    const pattern = parameter.childForFieldName("pattern") ?? parameter;
    return pattern.type === "identifier" ? [pattern.text] : [];
  });
}

/** The loads inside `node` that ask for exactly one of `parameters`. A load of
 *  a non-executable asset is not one: the attribute already classifies it, and
 *  the function that wraps it hands out no module. */
function forwardedLoadIds(node: Node, parameters: readonly string[]): readonly number[] {
  if (parameters.length === 0) return [];
  const ids: number[] = [];
  visit(node, (candidate) => {
    if (candidate.type !== "call_expression") return;
    const callee = candidate.childForFieldName("function");
    if (callee?.type !== "import" && !(callee?.type === "identifier" && callee.text === "require")) return;
    const args = callArguments(candidate);
    if (isNonExecutableAsset(attributeType(args[1] ?? null))) return;
    const specifier = args[0];
    if (specifier?.type === "identifier" && parameters.includes(specifier.text)) ids.push(candidate.id);
  });
  return ids;
}

/** The local names an assignment target binds. */
function boundNames(target: Node | null): readonly string[] {
  if (target?.type === "identifier") return [target.text];
  if (target?.type !== "object_pattern") return [];
  return patternEntries(target).flatMap((entry) => (entry.local === undefined ? [] : [entry.local]));
}

/** One report for every way a property is reached: `Bun.spawn`, `Bun["spawn"]`
 *  and `Reflect.get(Bun, "spawn")` are the same access and are judged once. */
function collectAccessViolations(
  out: OwnedProcessViolation[],
  file: string,
  isAuthority: boolean,
  node: Node,
  object: Node | null,
  name: string | undefined,
  provenance: Provenance,
): void {
  const line = lineOf(node);
  const objectText = object?.text ?? "";
  const shown = name ?? "[...]";
  if (objectText === "globalThis") {
    if (name === undefined || GLOBAL_ESCAPE_MEMBERS.has(name)) {
      out.push({ file, line, rule: "no-global-escape", detail: `globalThis.${shown}` });
    }
    return;
  }
  if (objectText === "Deno" && name === "Command") {
    out.push({ file, line, rule: "no-raw-launch", detail: "Deno.Command" });
    return;
  }
  if (objectText === "process" && name === "binding") {
    out.push({ file, line, rule: "no-global-escape", detail: "process.binding" });
    return;
  }
  if (!isCapabilitySource(object, provenance)) return;
  if (name === "$") {
    out.push({ file, line, rule: "no-shell-wrapper", detail: `${objectText}.$` });
    return;
  }
  if (name !== undefined && !LAUNCH_MEMBERS.has(name)) return;
  if (!isAuthority) out.push({ file, line, rule: "no-raw-launch", detail: `${objectText}.${shown}` });
}

function collectCallViolations(out: OwnedProcessViolation[], file: string, isAuthority: boolean, node: Node, provenance: Provenance): void {
  const load = moduleLoad(node, provenance);
  if (load) {
    if (load.specifier === undefined) collectUnclassifiedLoad(out, file, node, load, provenance);
    else collectModuleViolations(out, file, isAuthority, node, load.specifier, loadedNames(node));
    return;
  }
  const reflected = reflectedAccess(node);
  if (reflected) collectAccessViolations(out, file, isAuthority, node, reflected.object, reflected.name, provenance);
}

/** A module load whose specifier this gate cannot read fails closed at the
 *  load: the module it binds may hand out a launcher under any name, and a
 *  name is all this gate can judge. Three such loads hide nothing: one that
 *  asks for a non-executable asset by import attribute, one that asks for a
 *  path, which names a file rather than a builtin module, and one inside a
 *  function that forwards its own parameter, which every call of that function
 *  classifies in its place. */
function collectUnclassifiedLoad(out: OwnedProcessViolation[], file: string, node: Node, load: ModuleLoad, provenance: Provenance): void {
  if (isNonExecutableAsset(load.attributeType)) return;
  if (isPathExpression(load.argument, provenance)) return;
  if (provenance.forwardedLoads.has(node.id)) return;
  out.push({ file, line: lineOf(node), rule: "unclassifiable-module-load", detail: capabilityLabel(node) });
}

/** Reads one static import. Bindings and specifier are both needed: the
 *  specifier says which module, the bindings say whether a launch capability
 *  crossed the module boundary. */
function collectImportViolations(out: OwnedProcessViolation[], file: string, isAuthority: boolean, node: Node): void {
  const specifier = stringValue(node.childForFieldName("source"));
  if (specifier === undefined) return;
  collectModuleViolations(out, file, isAuthority, node, specifier, importedNames(node));
}

/** An authority module holds the platform primitives, so an export is the one
 *  way a raw launcher leaves it. Provenance decides, not the exported name: a
 *  launcher aliased, renamed on the way out, or made the default export is the
 *  same escape under a different name. A re-export is read as the import it
 *  is. */
function collectExportViolations(out: OwnedProcessViolation[], file: string, isAuthority: boolean, node: Node, provenance: Provenance): void {
  const source = stringValue(node.childForFieldName("source"));
  if (source !== undefined) {
    collectModuleViolations(out, file, isAuthority, node, source, exportedNames(node));
    return;
  }
  if (!isAuthority) return;
  const line = lineOf(node);
  const value = node.childForFieldName("value");
  if (value) {
    if (carriesCapability(value, provenance)) out.push({ file, line, rule: "no-exported-raw-launch", detail: "export default" });
    return;
  }
  for (const name of exportedLocalNames(node)) {
    if (provenance.carriers.has(name)) out.push({ file, line, rule: "no-exported-raw-launch", detail: `export ${name}` });
  }
}

/** The local names one export statement sends out under its own declaration or
 *  through an export clause. */
function exportedLocalNames(node: Node): readonly string[] {
  const declaration = node.childForFieldName("declaration");
  if (!declaration) return exportedSpecifierNames(node);
  return namedChildren(declaration).flatMap((child) => (child.type === "variable_declarator" ? boundNames(child.childForFieldName("name")) : []));
}

function exportedSpecifierNames(node: Node): readonly string[] {
  const clause = namedChildren(node).find((child) => child.type === "export_clause");
  if (!clause) return [];
  return namedChildren(clause).flatMap((specifier) => {
    if (specifier.type !== "export_specifier") return [];
    if (specifier.children.some((token) => token?.type === "type")) return [];
    const name = specifier.childForFieldName("name");
    return name ? [name.text] : [];
  });
}

/** What a re-export takes out of another module. `export * from` takes the
 *  whole namespace, exactly as `import * as` does. */
function exportedNames(node: Node): ImportedNames {
  if (node.children.some((child) => child?.type === "type")) return NOTHING_IMPORTED;
  const bindings = exportedSpecifierNames(node);
  return { bindings, wholeNamespace: namedChildren(node).every((child) => child.type !== "export_clause") };
}

/** What one import statement or expression brought across. `wholeNamespace` is
 *  set when no name bounds it: `import * as x` and `import(...)` both hand over
 *  every export the module has. */
interface ImportedNames {
  readonly bindings: readonly string[];
  readonly wholeNamespace: boolean;
  /** The name the whole namespace landed on, when it landed on one. */
  readonly namespaceAlias?: string;
  /** The name the default export landed on, when the import took one. */
  readonly defaultBinding?: string;
}

const NOTHING_IMPORTED: ImportedNames = { bindings: [], wholeNamespace: false };

function collectModuleViolations(
  out: OwnedProcessViolation[],
  file: string,
  isAuthority: boolean,
  node: Node,
  specifier: string,
  imported: ImportedNames,
): void {
  const line = lineOf(node);
  if (CHILD_PROCESS_SPECIFIER.test(specifier)) {
    out.push({ file, line, rule: "no-node-child-process", detail: `import "${specifier}"` });
    return;
  }
  if (!specifier.startsWith(".")) {
    if (isAuthority) return;
    for (const binding of imported.bindings) {
      if (specifier === "bun" && binding === "$") out.push({ file, line, rule: "no-shell-wrapper", detail: 'import { $ } from "bun"' });
      else if (LAUNCH_MEMBERS.has(binding)) out.push({ file, line, rule: "no-raw-launch", detail: `import { ${binding} } from "${specifier}"` });
    }
    return;
  }
  if (isAuthority) return;
  const stem = path.basename(specifier).replace(/\.(js|ts)$/, "");
  if (!AUTHORITY_MODULE_STEMS.has(stem)) return;
  if (imported.wholeNamespace) {
    out.push({ file, line, rule: "no-raw-backend-symbol", detail: `import * from "${specifier}"` });
    return;
  }
  for (const binding of imported.bindings) {
    if (!RAW_LAUNCH_FACTORY_SYMBOLS.has(binding)) continue;
    out.push({ file, line, rule: "no-raw-backend-symbol", detail: `import { ${binding} } from "${specifier}"` });
  }
}

/** The names an import binds at runtime. An `import type` clause, and an
 *  inline `type` specifier, bind nothing, so they carry no capability. */
function importedNames(node: Node): ImportedNames {
  if (node.children.some((child) => child?.type === "type")) return NOTHING_IMPORTED;
  const clause = node.childForFieldName("import_clause") ?? namedChildren(node).find((child) => child.type === "import_clause");
  if (!clause) return NOTHING_IMPORTED;
  const bindings: string[] = [];
  let namespaceAlias: string | undefined;
  let defaultBinding: string | undefined;
  for (const child of namedChildren(clause)) {
    if (child.type === "identifier") {
      defaultBinding = child.text;
      bindings.push(child.text);
    } else if (child.type === "namespace_import") namespaceAlias = namedChildren(child)[0]?.text ?? "";
    else if (child.type === "named_imports") {
      for (const specifier of namedChildren(child)) {
        if (specifier.type !== "import_specifier") continue;
        if (specifier.children.some((token) => token?.type === "type")) continue;
        const name = specifier.childForFieldName("name");
        if (name) bindings.push(name.text);
      }
    }
  }
  return { bindings, wholeNamespace: namespaceAlias !== undefined, namespaceAlias, defaultBinding };
}

/** One name an object pattern takes: `key` is the property read and `local` is
 *  where it landed. A rest element has no key, because it takes whatever is
 *  left, which is every name this gate would otherwise have enumerated. */
interface PatternEntry {
  readonly key: string | undefined;
  readonly local: string | undefined;
}

function patternEntries(pattern: Node): readonly PatternEntry[] {
  const entries: PatternEntry[] = [];
  for (const property of namedChildren(pattern)) {
    const target = property.type === "object_assignment_pattern" ? property.childForFieldName("left") : property;
    if (!target) continue;
    if (target.type === "rest_pattern") entries.push({ key: undefined, local: namedChildren(target)[0]?.text });
    else if (target.type === "shorthand_property_identifier_pattern") entries.push({ key: target.text, local: target.text });
    else if (target.type === "pair_pattern") {
      const value = target.childForFieldName("value");
      entries.push({ key: target.childForFieldName("key")?.text, local: value?.type === "identifier" ? value.text : undefined });
    }
  }
  return entries;
}

/** What a module load binds. `const { a } = await import(m)` names exactly what
 *  crossed, exactly as a static import would; anything else takes the whole
 *  module namespace. */
function loadedNames(node: Node): ImportedNames {
  const holder = node.parent?.type === "await_expression" ? node.parent : node;
  const pattern = holder.parent?.type === "variable_declarator" ? holder.parent.childForFieldName("name") : null;
  if (pattern?.type !== "object_pattern") return { bindings: [], wholeNamespace: true };
  const entries = patternEntries(pattern);
  return {
    bindings: entries.flatMap((entry) => (entry.key === undefined ? [] : [entry.key])),
    wholeNamespace: entries.some((entry) => entry.key === undefined),
  };
}

/** `const { spawn } = Bun` names the launcher without ever writing `Bun.spawn`,
 *  and a rest element takes it without naming it at all. A module load with a
 *  readable specifier is reported at the load, so it is not reported again
 *  here. */
function collectPatternViolations(
  out: OwnedProcessViolation[],
  file: string,
  isAuthority: boolean,
  target: Node | null,
  value: Node | null,
  provenance: Provenance,
): void {
  if (target?.type !== "object_pattern" || !value) return;
  if (!isCapabilitySource(value, provenance)) return;
  if (moduleLoad(unwrap(value), provenance)?.specifier !== undefined) return;
  const line = lineOf(target);
  const source = capabilityLabel(value);
  for (const entry of patternEntries(target)) {
    if (entry.key === "$") out.push({ file, line, rule: "no-shell-wrapper", detail: `{ $ } = ${source}` });
    else if (isAuthority) continue;
    else if (entry.key === undefined) out.push({ file, line, rule: "no-raw-launch", detail: `{ ... } = ${source}` });
    else if (LAUNCH_MEMBERS.has(entry.key)) out.push({ file, line, rule: "no-raw-launch", detail: `{ ${entry.key} } = ${source}` });
  }
}

/** How a capability is named in a report: the expression itself, or the call
 *  that produced it when the expression is a module load. */
function capabilityLabel(value: Node): string {
  const target = unwrap(value);
  const callee = target.type === "call_expression" ? target.childForFieldName("function") : null;
  return callee ? `${callee.text}(...)` : target.text;
}

/** Every raw launch states what it does about a console.
 *
 *  Windows gives a console program a fresh console when the process starting it
 *  holds none, and that console is a visible window. Flywheel holds none
 *  whenever it was not started from a terminal, and neither does anything it
 *  detaches, so a launch that stays silent about it produces a window that
 *  flashes up in front of whatever the user was doing. Nothing Flywheel starts
 *  wants one: an owned payload's streams belong to its launcher, and a probe is
 *  an internal question.
 *
 *  Raw launches exist only in the authority modules, so requiring it there
 *  covers every process this product can start. A launch anywhere else is
 *  already refused outright, and does not need telling about consoles as well.
 *  The flag is meaningless on other platforms, which ignore it. */
function collectConsoleViolations(out: OwnedProcessViolation[], file: string, node: Node): void {
  const callee = node.childForFieldName("function");
  if (!callee) return;
  const name = callee.text;
  if (name !== "Bun.spawn" && name !== "Bun.spawnSync") return;
  const args = node.childForFieldName("arguments");
  if (!args) return;
  let states = false;
  visit(args, (candidate) => {
    if (candidate.type !== "pair" && candidate.type !== "shorthand_property_identifier") return;
    const key = candidate.type === "pair" ? candidate.childForFieldName("key")?.text : candidate.text;
    if (key === "windowsHide" || key === '"windowsHide"') states = true;
  });
  if (!states) out.push({ file, line: lineOf(node), rule: "no-unstated-console", detail: `${name}(...) without windowsHide` });
}

/** The shell entry point may only replace itself with the CLI. Anything that
 *  creates a child there is a launch outside the owned boundary. */
function collectShellViolations(out: OwnedProcessViolation[], file: string, text: string): void {
  const lines = text.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = (lines[index] ?? "").trim();
    if (line.startsWith("#") || line.length === 0) continue;
    if (/\b(nohup|setsid|disown)\b/.test(line) || /&\s*$/.test(line)) {
      out.push({ file, line: index + 1, rule: "no-detached-shell-launch", detail: line });
      continue;
    }
    const match = /(^|[|;&]\s*)(bun|bunx|node|deno|npx|sh|bash|zsh|python3?)\b/.exec(line);
    if (match && !/^exec\s/.test(line)) {
      out.push({ file, line: index + 1, rule: "no-shell-child-launch", detail: line });
    }
  }
}

if (import.meta.main) {
  const repoRoot = path.resolve(import.meta.dir, "..");
  const violations = await findOwnedProcessLaunchViolations(repoRoot);
  for (const violation of violations) {
    process.stderr.write(`owned-processes: ${violation.file}:${violation.line} ${violation.rule}: ${violation.detail}\n`);
  }
  if (violations.length > 0) process.exit(1);
}