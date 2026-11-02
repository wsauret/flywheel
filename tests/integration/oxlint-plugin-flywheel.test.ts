import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const repoRoot = resolve(import.meta.dir, "../..");
const oxlint = join(repoRoot, "node_modules", ".bin", "oxlint");
const productionConfig = join(repoRoot, "oxlint.config.ts");
const pluginSpecifier = join(repoRoot, "scripts", "oxlint-plugin-flywheel.js");
// Blank Flywheel's packaged ast-grep napi-rs override; oxlint must load its own native binding.
const oxlintEnv = { ...process.env, NAPI_RS_NATIVE_LIBRARY_PATH: "" };

// Each rule is exercised against a throwaway config that enables it at top level,
// isolating the rule's AST logic from the production config's directory scoping
// (that scoping is verified by the live `oxlint src/` gate, not here). The
// production config IDs are flywheel/<rule>; oxlint's JSON output uses flywheel(<rule>).
//
// All fixtures for a rule lint in ONE oxlint spawn: process startup dominates
// the cost, so per-case spawning made this file the slowest in the suite.

interface RuleCase {
  readonly file: string;
  readonly source: string;
  readonly expect: "fires" | "fires-once" | "silent";
}
interface RuleCases {
  readonly [rule: string]: readonly RuleCase[];
}

const effectImport = `import { Effect } from "effect";\n`;
const schemaImport = `import { Schema } from "effect";\n`;

const ruleCases: RuleCases = {
  "no-effect-escape-hatch": [
    { file: "edge.ts", source: `${effectImport}export const x = Effect.orDie(Effect.void);\n`, expect: "fires" },
    { file: "edge.test.ts", source: `${effectImport}export const x = Effect.orDie(Effect.void);\n`, expect: "silent" },
    { file: "stream.ts", source: `declare const stream: { orDie(): void };\nexport const x = stream.orDie();\n`, expect: "silent" },
  ],
  "no-schema-class": [
    { file: "schema.ts", source: `${schemaImport}export class X extends Schema.Class<X>("X")({ id: Schema.String }) {}\n`, expect: "fires-once" },
    { file: "error.ts", source: `${schemaImport}export class E extends Schema.TaggedErrorClass<E>()("E", { reason: Schema.String }) {}\n`, expect: "silent" },
  ],
  "no-unsupported-effect-api": [
    ...["async", "zipRight", "zipLeft", "timeoutFail", "orDieWith", "dieMessage"].map((member): RuleCase => (
      { file: `${member}.ts`, source: `${effectImport}export const x = Effect.${member}(Effect.void);\n`, expect: "fires" }
    )),
    { file: "callback.ts", source: `${effectImport}export const x = Effect.callback((resume) => resume(Effect.void));\n`, expect: "silent" },
  ],
  "require-suppression-reason": [
    { file: "suppressed.ts", source: `// oxlint-disable-next-line no-console\nconsole.log("hidden");\n`, expect: "fires" },
    { file: "explained.ts", source: `// oxlint-disable-next-line no-console -- CLI output is the command contract\nconsole.log("visible");\n`, expect: "silent" },
  ],
  "no-barrel-file": [
    { file: "barrel.ts", source: `export * from "./a.js";\n`, expect: "fires" },
    { file: "barrel-ns.ts", source: `export * as ns from "./b.js";\n`, expect: "fires" },
    { file: "named.ts", source: `export { a } from "./a.js";\n`, expect: "silent" },
  ],
  "no-record": [
    { file: "erased.ts", source: `export type Payload = Record<string, unknown>;\n`, expect: "fires-once" },
    { file: "nested.ts", source: `export interface X { meta: Readonly<Record<string, boolean>> }\n`, expect: "fires-once" },
    { file: "value.ts", source: `const record = { a: 1 };\nexport const x = record;\n`, expect: "silent" },
    { file: "named.ts", source: `interface Flags { [key: string]: boolean }\nexport type F = Flags;\n`, expect: "silent" },
  ],
  "prefer-schema-inferred-types": [
    { file: "dup.ts", source: `${schemaImport}export const FooSchema = Schema.Struct({ id: Schema.String });\nexport interface Foo { id: string }\n`, expect: "fires" },
    { file: "inferred.ts", source: `${schemaImport}export const FooSchema = Schema.Struct({ id: Schema.String });\nexport type Foo = typeof FooSchema.Type;\n`, expect: "silent" },
    { file: "decoder.ts", source: `${schemaImport}export const XModel = Schema.decodeUnknownSync(Schema.Unknown);\nexport interface X { id: string }\n`, expect: "silent" },
  ],
  "no-shouty-constants": [
    { file: "shouty.ts", source: `const FOO = "FOO";\nexport const x = FOO;\n`, expect: "fires" },
    { file: "ok.ts", source: `const FOO = "foo";\nexport const x = FOO;\n`, expect: "silent" },
    { file: "ok-lower.ts", source: `const greeting = "greeting";\nexport const x = greeting;\n`, expect: "silent" },
  ],
  "no-tmp-literal-path": [
    { file: "root.ts", source: `import { join } from "node:path";\nexport const x = join("/tmp", "a");\n`, expect: "fires-once" },
    { file: "below.ts", source: `export const x = "/tmp/a";\n`, expect: "fires-once" },
    { file: "template.ts", source: `declare const id: string;\nexport const x = \`/tmp/a-\${id}\`;\n`, expect: "fires-once" },
    { file: "suffix.ts", source: `declare const id: string;\nexport const x = \`/tmp\${id}\`;\n`, expect: "fires-once" },
    { file: "socket.ts", source: `// oxlint-disable-next-line flywheel/no-tmp-literal-path -- a Unix socket path must stay under 104 bytes\nexport const x = "/tmp/fw-";\n`, expect: "silent" },
    { file: "mention.ts", source: `export const x = "rm -rf /tmp/a";\nexport const y = "/tmpfs";\n`, expect: "silent" },
  ],
};

interface Diagnostic {
  readonly code: string;
  readonly filename: string;
}

function lintFiles(configPath: string, dir: string, files: readonly string[]) {
  const result = spawnSync(
    oxlint,
    ["-c", configPath, "--format", "json", ...files.map((file) => join(dir, file))],
    { cwd: repoRoot, encoding: "utf8", env: oxlintEnv },
  );
  const parsed: { diagnostics: Diagnostic[] } = JSON.parse(result.stdout);
  return { diagnostics: parsed.diagnostics, status: result.status };
}

function lintRule(rule: string, cases: readonly RuleCase[]): { diagnostics: Diagnostic[]; status: number | null } {
  const dir = mkdtempSync(join(tmpdir(), "fw-oxlint-"));
  try {
    const configPath = join(dir, "config.jsonc");
    writeFileSync(
      configPath,
      JSON.stringify({
        jsPlugins: [{ name: "flywheel", specifier: pluginSpecifier }],
        plugins: [],
        categories: { correctness: "off" },
        rules: { [`flywheel/${rule}`]: "error" },
      }),
    );
    for (const testCase of cases) writeFileSync(join(dir, testCase.file), testCase.source);
    return lintFiles(configPath, dir, cases.map((testCase) => testCase.file));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function matches(count: number, expectation: RuleCase["expect"]): boolean {
  if (expectation === "silent") return count === 0;
  if (expectation === "fires-once") return count === 1;
  return count >= 1;
}

describe("flywheel oxlint plugin", () => {
  for (const [rule, cases] of Object.entries(ruleCases)) {
    it(`${rule}: fires and stays silent per fixture`, () => {
      const { diagnostics, status } = lintRule(rule, cases);
      const mismatches = cases
        .map((testCase) => {
          const count = diagnostics.filter(
            (diagnostic) => diagnostic.code === `flywheel(${rule})` && diagnostic.filename.endsWith(testCase.file),
          ).length;
          return { file: testCase.file, expect: testCase.expect, count };
        })
        .filter(({ count, expect: expectation }) => !matches(count, expectation));
      expect(mismatches).toEqual([]);
      // Every rule has at least one firing fixture, so the batch must fail lint.
      expect(status).toBe(1);
    });
  }
});

describe("production oxlint ownership", () => {
  it("uses the built-in TypeScript rule for @ts-nocheck and @ts-ignore", () => {
    const dir = mkdtempSync(join(tmpdir(), "fw-oxlint-production-"));
    try {
      writeFileSync(join(dir, "nocheck.ts"), `// @ts-nocheck\nexport const x = 1;\n`);
      writeFileSync(join(dir, "ignore.ts"), `// @ts-ignore\nexport const x = 1;\n`);
      const { diagnostics, status } = lintFiles(productionConfig, dir, ["nocheck.ts", "ignore.ts"]);
      const banned = diagnostics.filter((diagnostic) => diagnostic.code === "typescript(ban-ts-comment)");
      expect(banned.some((diagnostic) => diagnostic.filename.endsWith("nocheck.ts"))).toBe(true);
      expect(banned.some((diagnostic) => diagnostic.filename.endsWith("ignore.ts"))).toBe(true);
      expect(status).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
