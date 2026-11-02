import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const repoRoot = resolve(import.meta.dir, "../..");
const oxlint = join(repoRoot, "node_modules", ".bin", "oxlint");
const pluginSpecifier = join(repoRoot, "scripts", "oxlint-plugin-anti-slop", "index.ts");
const oxlintEnv = { ...process.env, NAPI_RS_NATIVE_LIBRARY_PATH: "" };

interface RuleCase {
  readonly source: string;
  readonly expect: "fires" | "silent";
}

interface RuleCases {
  readonly [rule: string]: readonly RuleCase[];
}

const ruleCases: RuleCases = {
  "no-chained-type-assertions": [
    { source: "declare const value: unknown; interface User { id: string } const user = value as object as User;", expect: "fires" },
    { source: "declare const value: unknown; interface User { id: string } const user = value as User;", expect: "silent" },
  ],
  "no-known-value-widening": [
    { source: "interface Handler { run(): void } declare const startHandler: Handler; const handlers: Record<string, Handler> = { start: startHandler };", expect: "fires" },
    { source: "interface Handler { run(): void } declare const startHandler: Handler; const handlers = { start: startHandler } satisfies Record<string, Handler>;", expect: "silent" },
  ],
  "no-module-mocking": [
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
  "no-object-parameters": [
    { source: "function save(value: object): void { void value; }", expect: "fires" },
    { source: "interface Value { id: string } function save(value: Value): void { void value; }", expect: "silent" },
  ],
  "no-reflect-apply": [
    { source: "declare const operation: () => void; Reflect.apply(operation, undefined, []);", expect: "fires" },
    { source: "declare const operation: () => void; operation();", expect: "silent" },
  ],
  "no-reflect-get": [
    { source: "declare const owner: { id: string }; const id = Reflect.get(owner, 'id');", expect: "fires" },
    { source: "declare const owner: { id: string }; const id = owner.id;", expect: "silent" },
  ],
  "no-shape-in-symbol-names": [
    { source: "interface UserShape { id: string }", expect: "fires" },
    { source: "interface UserRecord { id: string }", expect: "silent" },
  ],
  "no-unknown-returns": [
    { source: "function load(): unknown { return 1; }", expect: "fires" },
    { source: "function load(): number { return 1; }", expect: "silent" },
  ],
  "no-unknown-type-aliases": [
    { source: "type ExternalValue = unknown;", expect: "fires" },
    { source: "type ExternalValue = string | number;", expect: "silent" },
  ],
  "no-widen-then-assert": [
    { source: "interface User { id: string } declare function loadUser(): User; const loaded: User = loadUser(); const stored: unknown = loaded; const user = stored as User;", expect: "fires" },
    { source: "interface User { id: string } declare function loadUser(): User; const user = loadUser();", expect: "silent" },
  ],
};

interface Diagnostic {
  readonly code: string;
  readonly filename: string;
}

function lintRule(rule: string, cases: readonly RuleCase[]): Diagnostic[] {
  const dir = mkdtempSync(join(tmpdir(), "fw-anti-slop-"));
  try {
    const files = cases.map((testCase, index) => {
      const file = join(dir, `case-${index}.ts`);
      writeFileSync(file, `${testCase.source}\n`);
      return file;
    });
    const config = join(dir, "oxlint.json");
    writeFileSync(config, JSON.stringify({
      jsPlugins: [{ name: "anti-slop", specifier: pluginSpecifier }],
      plugins: [],
      categories: { correctness: "off" },
      rules: { [`anti-slop/${rule}`]: "error" },
    }));
    const result = spawnSync(oxlint, ["-c", config, "--format", "json", ...files], {
      cwd: repoRoot,
      encoding: "utf8",
      env: oxlintEnv,
    });
    const output: { diagnostics: Diagnostic[] } = JSON.parse(result.stdout);
    return output.diagnostics;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("anti-slop oxlint plugin", () => {
  for (const [rule, cases] of Object.entries(ruleCases)) {
    it(`${rule}: fires and stays silent per fixture`, () => {
      const diagnostics = lintRule(rule, cases);
      for (const [index, testCase] of cases.entries()) {
        const code = `anti-slop(${rule})`;
        const count = diagnostics.filter((diagnostic) => diagnostic.code === code && diagnostic.filename.endsWith(`case-${index}.ts`)).length;
        expect(count > 0).toBe(testCase.expect === "fires");
      }
    });
  }
});
