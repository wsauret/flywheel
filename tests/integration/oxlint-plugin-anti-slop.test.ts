import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, posix, resolve } from "node:path";

const repoRoot = resolve(import.meta.dir, "../..");
const oxlint = join(repoRoot, "node_modules", ".bin", "oxlint");
const pluginRoot = join(repoRoot, "scripts", "oxlint-plugin-anti-slop");
const jsPlugins = [
  { name: "anti-slop", specifier: join(pluginRoot, "index.ts") },
  { name: "anti-slop-effect", specifier: join(pluginRoot, "effect", "index.ts") },
  { name: "anti-slop-martinfowler", specifier: join(pluginRoot, "martinfowler", "index.ts") },
];
const oxlintEnv = { ...process.env, NAPI_RS_NATIVE_LIBRARY_PATH: "" };

interface RuleCase {
  readonly source: string;
  readonly expect: "fires" | "silent";
  /** The path of the linted file under the temporary root, for rules that read it. */
  readonly path?: string;
}

interface RuleCases {
  readonly [rule: string]: readonly RuleCase[];
}

const ruleCases: RuleCases = {
  "anti-slop/no-chained-type-assertions": [
    { source: "declare const value: unknown; interface User { id: string } const user = value as object as User;", expect: "fires" },
    { source: "declare const value: unknown; interface User { id: string } const user = value as User;", expect: "silent" },
  ],
  "anti-slop/no-known-value-widening": [
    { source: "interface Handler { run(): void } declare const startHandler: Handler; const handlers: Record<string, Handler> = { start: startHandler };", expect: "fires" },
    { source: "interface Handler { run(): void } declare const startHandler: Handler; const handlers = { start: startHandler } satisfies Record<string, Handler>;", expect: "silent" },
    // A type guard narrows a typed value; the call widens nothing.
    { source: "interface Event { message?: string } function isRecord(value: unknown): value is { [key: string]: unknown } { return typeof value === 'object' && value !== null; } declare const event: Event; const ok = isRecord(event);", expect: "silent" },
  ],
  "anti-slop/max-ternary-depth": [
    { source: "declare const n: number; const label = n === 0 ? 'zero' : n === 1 ? 'one' : n === 2 ? 'two' : n === 3 ? 'three' : 'many';", expect: "fires" },
    { source: "declare const n: number; const label = n === 0 ? 'zero' : n === 1 ? 'one' : n === 2 ? 'two' : 'many';", expect: "silent" },
  ],
  "anti-slop/no-conditional-spread": [
    { source: "declare const flag: boolean; const value = { ...(flag && { a: 1 }) };", expect: "fires" },
    { source: "declare const extra: { b: number } | undefined; const value = { ...(extra || {}) };", expect: "silent" },
    { source: "declare const x: number | undefined; const value = { ...(x === undefined ? {} : { x }) };", expect: "silent" },
    { source: "declare const list: number[] | undefined; const value = [...(list ?? [])];", expect: "silent" },
  ],
  "anti-slop/no-reduce-accumulator-copy": [
    { source: "declare const items: { id: string }[]; const byId = items.reduce((acc, item) => Object.assign({}, acc, { [item.id]: item }), {});", expect: "fires" },
    { source: "declare const items: string[]; const all = items.reduce<string[]>((acc, item) => { acc.push(item); return acc; }, []);", expect: "silent" },
  ],
  "anti-slop/no-reprovide-ambient-service": [
    { source: "import { Effect, Layer } from 'effect'; import * as HttpClient from 'effect/unstable/http/HttpClient'; declare const Service: any; declare const request: any; const ServiceLive = Layer.effect(Service, Effect.gen(function* () { const httpClient = yield* HttpClient.HttpClient; return Service.of({ execute: () => request.pipe(Effect.provideService(HttpClient.HttpClient, httpClient)) }); }));", expect: "fires" },
    { source: "import { Effect } from 'effect'; import * as HttpClient from 'effect/unstable/http/HttpClient'; const operation = Effect.gen(function* () { yield* HttpClient.HttpClient; });", expect: "silent" },
  ],
  "anti-slop/no-module-mocking": [
    { source: "import { mock } from 'bun:test'; mock.module('./store', () => ({}));", expect: "fires" },
    { source: "import { mock as testMock } from 'bun:test'; testMock['module']('./store', () => ({}));", expect: "fires" },
    { source: "import { mock } from 'bun:test'; const mockModule = mock.module.bind(mock); mockModule('./store', () => ({}));", expect: "fires" },
    { source: "import { mock } from 'bun:test'; const mockModule = mock.module; mockModule('./store', () => ({}));", expect: "fires" },
    { source: "vi.mock('./store');", expect: "fires" },
    { source: "jest.mock('./store');", expect: "fires" },
    { source: "const mock = { module() {} }; mock.module();", expect: "silent" },
    { source: "const helper = { module() {} }; const mockModule = helper.module.bind(helper); mockModule();", expect: "silent" },
    { source: "import { mock } from './helpers'; mock.module('./store');", expect: "silent" },
  ],
  "anti-slop/no-object-parameters": [
    { source: "function save(value: object): void { void value; }", expect: "fires" },
    { source: "interface Value { id: string } function save(value: Value): void { void value; }", expect: "silent" },
  ],
  "anti-slop/no-reflect-apply": [
    { source: "declare const operation: () => void; Reflect.apply(operation, undefined, []);", expect: "fires" },
    { source: "declare const operation: () => void; operation();", expect: "silent" },
  ],
  "anti-slop/no-reflect-get": [
    { source: "declare const owner: { id: string }; const id = Reflect.get(owner, 'id');", expect: "fires" },
    { source: "declare const owner: { id: string }; const id = owner.id;", expect: "silent" },
  ],
  "anti-slop/no-shape-in-symbol-names": [
    { source: "interface UserShape { id: string }", expect: "fires" },
    { source: "interface UserRecord { id: string }", expect: "silent" },
  ],
  "anti-slop/no-unknown-parameters": [
    { source: "export function save(payload: unknown): void { store(payload); } declare function store(value: string): void;", expect: "fires" },
    { source: "export type Listener = (message: unknown) => void;", expect: "fires" },
    { source: "export function isText(value: unknown): value is string { return typeof value === 'string'; }", expect: "silent" },
    { source: "export function assertText(value: unknown): asserts value is string { if (typeof value !== 'string') throw new Error('text'); }", expect: "silent" },
    { source: "export function describeFailure(error: unknown): string { return String(error); }", expect: "silent" },
    { source: "declare const work: Promise<void>; work.catch((failure: unknown) => { void failure; });", expect: "silent" },
    { source: "export const options = { onError: (failure: unknown) => { void failure; } };", expect: "silent" },
    { source: "export interface Visits { forEach(visit: (value: string) => void, thisArg?: unknown): void }", expect: "silent" },
    { source: "export function readCount(value: unknown): number { return typeof value === 'number' ? value : 0; }", expect: "silent" },
    { source: "import { asRecord } from './records'; export function readName(row: unknown): unknown { return asRecord(row)?.name; }", expect: "silent" },
    { source: "function isText(value: unknown): value is string { return typeof value === 'string'; } export function hasText(input: unknown): boolean { return isText(input); }", expect: "silent" },
    { source: "export function render(detail: unknown): string { return 'detail ' + JSON.stringify(detail); }", expect: "silent" },
    { source: "export function readAll<T>(decode: (value: unknown) => T, rows: readonly string[]): T[] { return rows.map((row) => decode(JSON.parse(row))); }", expect: "silent" },
    { source: "export type ReplyParser<T> = (value: unknown) => T;", expect: "silent" },
    // Forwarding to the same narrowing function twice is not a cycle.
    { source: "function isText(value: unknown): value is string { return typeof value === 'string'; } function narrow(value: unknown): boolean { return isText(value); } export function count(input: unknown): number { return Number(narrow(input)) + Number(narrow(input)); }", expect: "silent" },
    // A forwarded input takes the exemption of the decoder slot it reaches.
    { source: "declare function store(value: any): number; const rowDecoder = (value: unknown): number => store(value); export function load(input: unknown): number { return rowDecoder(input); }", expect: "silent" },
  ],
  "anti-slop/no-unknown-returns": [
    { source: "function load(): unknown { return 1; }", expect: "fires" },
    { source: "function load(): number { return 1; }", expect: "silent" },
  ],
  "anti-slop/no-unknown-type-aliases": [
    { source: "type ExternalValue = unknown;", expect: "fires" },
    { source: "type ExternalValue = string | number;", expect: "silent" },
  ],
  "anti-slop/no-widen-then-assert": [
    { source: "interface User { id: string } declare function loadUser(): User; const loaded: User = loadUser(); const stored: unknown = loaded; const user = stored as User;", expect: "fires" },
    { source: "interface User { id: string } declare function loadUser(): User; const user = loadUser();", expect: "silent" },
  ],
  "anti-slop-effect/no-manual-effect-error-tag": [
    { source: 'declare const recover: unknown; declare const fail: unknown; Effect.catch((error: { _tag: string }) => error._tag === "NotFound" ? recover : fail);', expect: "fires" },
    { source: 'declare const recover: unknown; Effect.catchTag("NotFound", recover);', expect: "silent" },
  ],
  "anti-slop-effect/no-ordie-in-service-construction": [
    { source: `import * as Context from "effect/Context"; import * as Effect from "effect/Effect"; import * as Layer from "effect/Layer"; import * as Config from "effect/Config"; export class Client extends Context.Service<Client, { token: string }>()("@app/Client", { make: Effect.gen(function* () { const token = yield* Config.string("TOKEN").pipe(Effect.orDie); return { token }; }) }) { static readonly layer = Layer.effect(this, this.make); }`, expect: "fires" },
    { source: `import * as Context from "effect/Context"; import * as Effect from "effect/Effect"; import * as Layer from "effect/Layer"; import * as Config from "effect/Config"; declare const Sql: any; export class Store extends Context.Service<Store, { find(id: string): unknown }>()("@app/Store", { make: Effect.gen(function* () { const sql = yield* Sql; return { find: (id: string) => sql.find(id).pipe(Effect.orDie) }; }) }) { static readonly layer = Layer.effect(this, this.make); }`, expect: "silent" },
  ],
  "anti-slop-effect/no-service-parameters": [
    { source: `import * as Context from "effect/Context"; import * as Effect from "effect/Effect"; import * as Layer from "effect/Layer"; import * as Config from "effect/Config"; declare const run: any; interface Input { id: string } interface Store { id: string } export const operation = (input: Input, layer: Layer.Layer<Store>) => run(input).pipe(Effect.provide(layer));`, expect: "fires" },
    { source: `import * as Context from "effect/Context"; import * as Effect from "effect/Effect"; import * as Layer from "effect/Layer"; import * as Config from "effect/Config"; declare const Store: any; export const find = (input: { readonly id: string }) => Effect.gen(function* () { const store = yield* Store; return yield* store.find(input.id); });`, expect: "silent" },
  ],
  "anti-slop-effect/prefer-yield-service": [
    { source: `import * as Context from "effect/Context"; import * as Effect from "effect/Effect"; import * as Layer from "effect/Layer"; import * as Config from "effect/Config"; declare const runBuild: any; export const make = Effect.gen(function* () { const fileAccess = yield* Effect.context<never>(); return { build: (dir: string) => runBuild(dir).pipe(Effect.provideContext(fileAccess)) }; });`, expect: "fires" },
    { source: `import * as Context from "effect/Context"; import * as Effect from "effect/Effect"; import * as Layer from "effect/Layer"; import * as Config from "effect/Config"; declare const FileSystem: any; export const make = Effect.gen(function* () { const fs = yield* FileSystem; return { read: (path: string) => fs.read(path) }; });`, expect: "silent" },
  ],
  "anti-slop-effect/require-cause-when-narrowing": [
    { source: `import * as Context from "effect/Context"; import * as Effect from "effect/Effect"; import * as Layer from "effect/Layer"; import * as Config from "effect/Config"; declare const decode: any; declare const text: string; declare const BadRequest: any; export const a = decode(text).pipe(Effect.mapError(() => BadRequest.make({ reason: "Invalid JSON" })));`, expect: "fires" },
    { source: `import * as Context from "effect/Context"; import * as Effect from "effect/Effect"; import * as Layer from "effect/Layer"; import * as Config from "effect/Config"; declare const decode: any; declare const text: string; declare const BadRequest: any; export const a = decode(text).pipe(Effect.mapError((cause: unknown) => BadRequest.make({ reason: "Invalid JSON", cause })));`, expect: "silent" },
  ],
  "anti-slop-effect/no-test-code-in-src": [
    { source: 'it("works", () => {});', expect: "fires", path: "src/widgets.test.ts" },
    { source: "export const hitTest = (x: number) => x > 0;", expect: "silent", path: "src/widgets.ts" },
  ],
  "anti-slop-effect/prefer-tagged-error-handling": [
    { source: 'declare const Predicate: any; declare const recover: unknown; Effect.catch((error: unknown) => Predicate.isTagged(error, "NotFound") ? recover : Effect.fail(error));', expect: "fires" },
    { source: 'declare const Predicate: any; declare const result: unknown; declare function useReady(value: unknown): void; if (Predicate.isTagged(result, "Ready")) useReady(result);', expect: "silent" },
  ],
  "anti-slop-martinfowler/mysterious-name": [
    { source: "export function resolve(): void {}", expect: "fires" },
    { source: "function loadConfiguration(): void {} export const refresh = loadConfiguration;", expect: "fires" },
    { source: "export function resolveBinding(): void {}", expect: "silent" },
  ],
};

interface Diagnostic {
  readonly code: string;
  readonly filename: string;
}

// Rules that need options run with the options oxlint.config.ts gives them.
const ruleOptions = new Map([["anti-slop/max-ternary-depth", ["error", { maxDepth: 3 }]]]);

function casePath(testCase: RuleCase, index: number): string {
  return testCase.path ?? `case-${index}.ts`;
}

function lintRule(rule: string, cases: readonly RuleCase[], extraArgs: readonly string[] = []): Diagnostic[] {
  const dir = mkdtempSync(join(tmpdir(), "fw-anti-slop-"));
  try {
    const files = cases.map((testCase, index) => {
      const file = join(dir, `${index}`, casePath(testCase, index));
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, `${testCase.source}\n`);
      return file;
    });
    const config = join(dir, "oxlint.json");
    writeFileSync(config, JSON.stringify({
      jsPlugins,
      plugins: [],
      categories: { correctness: "off" },
      rules: { [rule]: ruleOptions.get(rule) ?? "error" },
    }));
    const result = spawnSync(oxlint, ["-c", config, "--format", "json", ...extraArgs, ...files], {
      cwd: repoRoot,
      encoding: "utf8",
      env: oxlintEnv,
      windowsHide: true,
    });
    const output: { diagnostics: Diagnostic[] } = JSON.parse(result.stdout);
    return output.diagnostics;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function firesPerCase(rule: string, cases: readonly RuleCase[], diagnostics: readonly Diagnostic[]) {
  const [plugin, name] = rule.split("/");
  const code = `${plugin}(${name})`;
  for (const [index, testCase] of cases.entries()) {
    // oxlint reports `/` separators on every platform.
    const file = posix.join(`${index}`, casePath(testCase, index));
    const count = diagnostics.filter((diagnostic) => diagnostic.code === code && diagnostic.filename.endsWith(file)).length;
    expect({ source: testCase.source, fires: count > 0 }).toEqual({ source: testCase.source, fires: testCase.expect === "fires" });
  }
}

describe("anti-slop oxlint plugins", () => {
  for (const [rule, cases] of Object.entries(ruleCases)) {
    it(`${rule}: fires and stays silent per fixture`, () => {
      firesPerCase(rule, cases, lintRule(rule, cases));
    });
  }

  // One thread lints both files with the same rule instance, so an Effect
  // alias imported by the first file must not leak into the second.
  it("anti-slop/no-reprovide-ambient-service: reads Effect imports per file", () => {
    const rule = "anti-slop/no-reprovide-ambient-service";
    const cases: readonly RuleCase[] = [
      { source: "import { Effect as E } from 'effect'; declare const Service: any; declare const request: any; export const make = E.gen(function* () { const service = yield* Service; return request.pipe(E.provideService(Service, service)); });", expect: "fires" },
      { source: "declare const E: any; declare const Service: any; declare const request: any; export function* make() { const service = yield* Service; return request.pipe(E.provideService(Service, service)); }", expect: "silent" },
    ];
    firesPerCase(rule, cases, lintRule(rule, cases, ["--threads", "1"]));
  });
});
