import * as fs from "node:fs";
import * as path from "node:path";
import type { Node } from "web-tree-sitter";
import { loadTreeSitterParser } from "../src/infra/tree-sitter-parser.js";

// Derived state is advanced, never recomputed (AGENTS.md section 7).
//
// A read of an aggregate from its start costs work proportional to that
// aggregate's whole history. On a one-shot path (an explicit person command, a
// migration, recovery, startup) that is the price of the answer. On a hot path
// it is the defect that starved commits during a fifty-agent workflow launch,
// and nothing at the call site shows it: `readSlice({ aggregateId })` reads
// like a lookup. This check names the syntactically visible reads below,
// so that each either moves into a registered projection, advances from a
// position it keeps, or states on the reviewed allowlist why its caller runs it
// only once.
//
// What the check sees, from the syntax alone:
// - `readSlice(query)`, `capturedFacts(reader, query, bounds)`, and
//   `readCapturedFacts(reader, query, bounds)`, where the query is an object
//   literal or a lexically visible `const` bound to one in the same file.
// - `read(query)` and `readTolerant(query)` when every key of that literal is a
//   FactQuery key, which separates an event reader from the many other `read`
//   methods.
// - A durable read repeated once per item: the body of a `for...of` or a
//   `for...in`, or a callback of an array iteration method, in the same
//   function. Retry and paging loops (`while`, counted `for`) do not count.
//
// What it cannot see:
// - A query built elsewhere and passed in as a parameter, or spread from a
//   value it cannot resolve. It trusts such a query to carry its own bound.
// - A full read behind a helper. The helper's own read is checked, but a hot
//   caller of a one-shot helper is not.
// - A loop that calls a helper which reads, and whether a loop runs per change.
//   The loop rule therefore covers every loop, not only change handlers.
// - The receiver's type. A method named `readSlice` on an unrelated object is
//   checked as if it read events.
// - Runtime values or mutations of query objects. A visible `undefined` or
//   `void` bound does not count; other opaque bound values are trusted.

/** Every key a FactQuery declares, in src/infra/event-store-types.ts. */
const FACT_QUERY_KEYS = new Set([
  "aggregateId", "aggregateIds", "aggregatePrefix", "sessionId", "positions", "types", "afterPosition",
  "beforePosition", "fromSeq", "parentToolUseIds", "toolUseIds", "order", "limit", "limitPerAggregate",
]);

/** Keys that bound a read below its whole history. `beforePosition` is an
 *  upper bound, so a read with only that still folds from the first fact. A
 *  read by exact positions, tool-use ids, or a row limit is one indexed probe. */
const LOWER_BOUND_KEYS = new Set(["afterPosition", "fromSeq", "positions", "limit", "toolUseIds", "parentToolUseIds"]);

/** Reads whose call name alone identifies a durable store request. */
const STATE_REQUEST_METHODS = new Set([
  "readSlice", "readLatestByAggregateAndTypes", "readLatestPayloadByAggregateAndType",
  "countByAggregate", "aggregateSeq", "readInFlight", "latestPosition",
  "readPage", "capturePosition",
]);

const CAPTURED_READS = new Set(["capturedFacts", "readCapturedFacts"]);

const ITERATION_METHODS = new Set(["map", "flatMap", "forEach", "filter", "reduce", "some", "every", "find", "findIndex"]);

export type AggregateReadRule = "full-aggregate-read" | "durable-read-in-loop";

export interface AggregateReadFinding {
  readonly file: string;
  readonly line: number;
  /** The innermost named function, method, or binding that holds the read. */
  readonly scope: string;
  readonly rule: AggregateReadRule;
  readonly snippet: string;
}

/** One reviewed exception. The reason names who calls the scope and how often,
 *  which is what makes a full read or a per-item read acceptable there. */
export interface AggregateReadAllowance {
  readonly file: string;
  readonly scope: string;
  readonly rule: AggregateReadRule;
  readonly reason: string;
}

function listSourceFiles(dir: string, out: string[]): void {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) listSourceFiles(full, out);
    else if (entry.isFile() && /\.tsx?$/.test(entry.name)) out.push(full);
  }
}

function children(node: Node): Node[] {
  return node.namedChildren.filter((child): child is Node => child !== null);
}

function visit(node: Node, enter: (node: Node) => void): void {
  enter(node);
  for (const child of children(node)) visit(child, enter);
}

function calleeName(call: Node): string | undefined {
  const callee = call.childForFieldName("function");
  if (callee?.type === "identifier") return callee.text;
  if (callee?.type === "member_expression") return callee.childForFieldName("property")?.text;
  return undefined;
}

function callArguments(call: Node): Node[] {
  const args = call.childForFieldName("arguments");
  return args ? children(args) : [];
}

interface Scope {
  readonly parent?: Scope;
  readonly functionScope: boolean;
  readonly bindings: Map<string, Node | null>;
}

const FUNCTIONS = new Set(["function_declaration", "function_expression", "generator_function_declaration", "generator_function", "arrow_function", "method_definition"]);
const SCOPES = new Set(["program", "statement_block", "for_statement", "for_in_statement", "catch_clause", "switch_body"]);
const TRANSPARENT = new Set(["parenthesized_expression", "as_expression", "satisfies_expression", "non_null_expression", "type_assertion"]);

function unwrap(node: Node): Node {
  const expression = node.type === "type_assertion" ? children(node).at(-1) : node.firstNamedChild;
  return TRANSPARENT.has(node.type) && expression ? unwrap(expression) : node;
}

function bindPattern(pattern: Node | null, scope: Scope, value: Node | null): void {
  if (!pattern) return;
  if (pattern.type === "identifier" || pattern.type === "shorthand_property_identifier_pattern") {
    scope.bindings.set(pattern.text, value);
  } else if (pattern.type === "pair_pattern") {
    bindPattern(pattern.childForFieldName("value"), scope, null);
  } else if (pattern.type === "assignment_pattern") {
    bindPattern(pattern.childForFieldName("left"), scope, null);
  } else {
    for (const child of children(pattern)) bindPattern(child, scope, null);
  }
}

/** Bindings include opaque shadows, so a parameter or a `let` never resolves
 *  to an outer constant with the same name. Only const initializers are followed. */
function lexicalScopes(root: Node): Map<number, Scope> {
  const scopes = new Map<number, Scope>();
  function walk(node: Node, parent?: Scope): void {
    const scope = !parent || SCOPES.has(node.type) || FUNCTIONS.has(node.type)
      ? { parent, functionScope: node.type === "program" || FUNCTIONS.has(node.type), bindings: new Map<string, Node | null>() }
      : parent;
    scopes.set(node.id, scope);
    if (node.type === "variable_declarator") {
      let owner = scope;
      if (node.parent?.type === "variable_declaration") {
        while (!owner.functionScope && owner.parent) owner = owner.parent;
      }
      const constant = node.parent?.children.some((child) => child?.type === "const");
      bindPattern(node.childForFieldName("name"), owner, constant ? node.childForFieldName("value") : null);
    }
    if (node.type === "required_parameter" || node.type === "optional_parameter") bindPattern(node.childForFieldName("pattern"), scope, null);
    if (node.type === "arrow_function") bindPattern(node.childForFieldName("parameter"), scope, null);
    if (node.type === "catch_clause") bindPattern(node.childForFieldName("parameter"), scope, null);
    if (node.type === "for_in_statement") bindPattern(node.childForFieldName("left"), scope, null);
    if (node.type === "function_declaration" || node.type === "generator_function_declaration") bindPattern(node.childForFieldName("name"), parent ?? scope, null);
    if (node.type === "function_expression") bindPattern(node.childForFieldName("name"), scope, null);
    for (const child of children(node)) walk(child, scope);
  }
  walk(root);
  return scopes;
}

function resolve(node: Node, scopes: ReadonlyMap<number, Scope>): Node | undefined {
  for (let scope = scopes.get(node.id); scope; scope = scope.parent) {
    if (scope.bindings.has(node.text)) return scope.bindings.get(node.text) ?? undefined;
  }
  return undefined;
}

function definedValue(value: Node, scopes: ReadonlyMap<number, Scope>, seen = new Set<number>()): boolean {
  const node = unwrap(value);
  if (seen.has(node.id)) return false;
  const visited = new Set([...seen, node.id]);
  if (node.type === "undefined" || (node.type === "unary_expression" && node.childForFieldName("operator")?.text === "void")) return false;
  if (node.type === "identifier" || node.type === "shorthand_property_identifier") {
    const bound = resolve(node, scopes);
    return bound ? definedValue(bound, scopes, visited) : true;
  }
  if (node.type === "ternary_expression") {
    const consequent = node.childForFieldName("consequence");
    const alternate = node.childForFieldName("alternative");
    return Boolean(consequent && alternate && definedValue(consequent, scopes, visited) && definedValue(alternate, scopes, visited));
  }
  return true;
}

interface QueryAlternative {
  readonly properties: ReadonlyMap<string, boolean>;
  readonly opaque: boolean;
}

const OPAQUE_QUERY: QueryAlternative = { properties: new Map(), opaque: true };

/** Keep conditional alternatives separate: a cursor in only one branch does
 *  not bound the other branch. Object writes retain their overwrite order. */
function queryAlternatives(expression: Node | undefined, scopes: ReadonlyMap<number, Scope>, seen = new Set<number>()): QueryAlternative[] | undefined {
  if (!expression) return undefined;
  const node = unwrap(expression);
  if (seen.has(node.id)) return undefined;
  const visited = new Set([...seen, node.id]);
  if (node.type === "identifier") return queryAlternatives(resolve(node, scopes), scopes, visited);
  if (node.type === "ternary_expression") {
    return ["consequence", "alternative"].flatMap((field) => queryAlternatives(node.childForFieldName(field) ?? undefined, scopes, visited) ?? [OPAQUE_QUERY]);
  }
  if (node.type !== "object") return undefined;
  let queries: QueryAlternative[] = [{ properties: new Map(), opaque: false }];
  for (const property of children(node)) {
    if (property.type === "spread_element") {
      const alternatives = queryAlternatives(property.firstNamedChild ?? undefined, scopes, visited) ?? [OPAQUE_QUERY];
      queries = queries.flatMap((query) => alternatives.map((spread) => ({
        properties: new Map([...query.properties, ...spread.properties]), opaque: query.opaque || spread.opaque,
      })));
    } else {
      const key = property.type === "shorthand_property_identifier" ? property : property.childForFieldName("key");
      const name = key?.type === "string" ? key.text.slice(1, -1) : key?.type === "property_identifier" || key?.type === "shorthand_property_identifier" ? key.text : undefined;
      const value = property.type === "shorthand_property_identifier" ? property : property.childForFieldName("value");
      if (name && value) queries = queries.map((query) => ({ ...query, properties: new Map([...query.properties, [name, definedValue(value, scopes)]]) }));
    }
  }
  return queries;
}

function isFactQuery(query: QueryAlternative): boolean {
  return query.properties.size > 0 && [...query.properties.keys()].every((key) => FACT_QUERY_KEYS.has(key));
}

function isBounded(query: QueryAlternative): boolean {
  return query.opaque || [...query.properties].some(([key, defined]) => defined && LOWER_BOUND_KEYS.has(key));
}

function isFunction(node: Node): boolean {
  return FUNCTIONS.has(node.type);
}

function ancestorsOf(node: Node): Node[] {
  const ancestors: Node[] = [];
  for (let parent = node.parent; parent; parent = parent.parent) ancestors.unshift(parent);
  return ancestors;
}

function scopeName(ancestors: readonly Node[]): string {
  let className: string | undefined;
  let name: string | undefined;
  for (const node of ancestors.toReversed()) {
    const parent = node.parent;
    if (name === undefined && isFunction(node)) {
      name = node.childForFieldName("name")?.text;
      if (!name && parent?.type === "variable_declarator") name = parent.childForFieldName("name")?.text;
      if (!name && parent?.type === "pair") name = parent.childForFieldName("key")?.text;
    }
    if (node.type === "class_declaration" || node.type === "class") {
      className = node.childForFieldName("name")?.text;
      break;
    }
  }
  if (name === undefined) return className ?? "<module>";
  return className === undefined ? name : `${className}.${name}`;
}

/** Whether the read sits in the factory of a registered projection, which
 *  runs once per key and is then advanced by `replay()`. */
function isRegistered(ancestors: readonly Node[]): boolean {
  return ancestors.some((node) => node.type === "call_expression" && calleeName(node) === "heldProjection");
}

/** Whether an iteration over items repeats the read inside the function
 *  that holds it: the body of a `for...of` or a `for...in`, or a callback of
 *  an array iteration method. A `while` or a counted `for` is a retry or
 *  paging loop here, which repeats on a conflict or a continuation rather than
 *  once per item, so it does not count. The iterable
 *  of a `for...of` is evaluated once and does not count either. */
function isInItemLoop(ancestors: readonly Node[], read: Node): boolean {
  let child = read;
  for (const node of ancestors.toReversed()) {
    if (node.type === "for_in_statement" && node.childForFieldName("body")?.id === child.id) return true;
    if (isFunction(node)) {
      const parent = node.parent;
      const call = parent?.type === "arguments" ? parent.parent : undefined;
      return call?.type === "call_expression" && ITERATION_METHODS.has(calleeName(call) ?? "");
    }
    child = node;
  }
  return false;
}

interface DurableRead {
  /** Whether the query reads from the first fact. */
  readonly full: boolean;
}

function classifyRead(call: Node, scopes: ReadonlyMap<number, Scope>): DurableRead | undefined {
  const name = calleeName(call);
  if (name === undefined) return undefined;
  const args = callArguments(call);
  if (CAPTURED_READS.has(name)) {
    const queries = queryAlternatives(args[1], scopes) ?? [OPAQUE_QUERY];
    const bounds = args[2] ? queryAlternatives(args[2], scopes) ?? [OPAQUE_QUERY] : [{ properties: new Map(), opaque: false }];
    return { full: queries.some((query) => bounds.some((bound) => !isBounded(query) && !isBounded(bound))) };
  }
  if (name === "readSlice") {
    const queries = queryAlternatives(args[0], scopes);
    return { full: queries?.some((query) => !isBounded(query)) ?? false };
  }
  if (STATE_REQUEST_METHODS.has(name)) return { full: false };
  if (name === "read" || name === "readTolerant") {
    const queries = queryAlternatives(args[0], scopes);
    if (!queries?.every(isFactQuery)) return undefined;
    return { full: queries.some((query) => !isBounded(query)) };
  }
  return undefined;
}

/** Syntactically visible full and per-item reads under `src/`, before ledger
 *  filtering. Rejects unparseable scanned files. Paths use repository-relative `/`. */
export async function findAggregateReads(repoRoot: string): Promise<AggregateReadFinding[]> {
  const files: string[] = [];
  listSourceFiles(path.join(repoRoot, "src"), files);
  const findings: AggregateReadFinding[] = [];
  for (const file of files.sort()) {
    const source = fs.readFileSync(file, "utf8");
    if (!/\b(read\w*|capturedFacts|countByAggregate|aggregateSeq|latestPosition|capturePosition)\s*\(/.test(source)) continue;
    const relative = path.relative(repoRoot, file).split(path.sep).join("/");
    const parser = await loadTreeSitterParser(file.endsWith(".tsx") ? "tsx" : "typescript");
    const tree = parser.parse(source);
    if (!tree) throw new Error(`${relative}: cannot parse`);
    try {
      if (tree.rootNode.hasError) throw new Error(`${relative}: cannot parse source`);
      const scopes = lexicalScopes(tree.rootNode);
      visit(tree.rootNode, (node) => {
        if (node.type !== "call_expression") return;
        const read = classifyRead(node, scopes);
        if (read === undefined) return;
        const ancestors = ancestorsOf(node);
        const at = { file: relative, line: node.startPosition.row + 1, scope: scopeName(ancestors), snippet: node.text.replace(/\s+/g, " ").slice(0, 120) };
        if (read.full && !isRegistered(ancestors)) findings.push({ ...at, rule: "full-aggregate-read" });
        if (isInItemLoop(ancestors, node)) findings.push({ ...at, rule: "durable-read-in-loop" });
      });
    } finally {
      tree.delete();
    }
  }
  return findings;
}

function allowanceKey(entry: { readonly file: string; readonly scope: string; readonly rule: AggregateReadRule }): string {
  return `${entry.file}#${entry.scope}#${entry.rule}`;
}

export interface AggregateReadReport {
  readonly violations: readonly AggregateReadFinding[];
  /** Allowances that match no finding, which the ledger must drop. */
  readonly staleAllowances: readonly AggregateReadAllowance[];
}

/** Findings the allowlist does not cover, and allowances nothing needs. */
export async function checkAggregateReads(repoRoot: string, allowlist: readonly AggregateReadAllowance[]): Promise<AggregateReadReport> {
  const findings = await findAggregateReads(repoRoot);
  const allowed = new Set(allowlist.map(allowanceKey));
  const found = new Set(findings.map(allowanceKey));
  return {
    violations: findings.filter((finding) => !allowed.has(allowanceKey(finding))),
    staleAllowances: allowlist.filter((entry) => !found.has(allowanceKey(entry))),
  };
}
