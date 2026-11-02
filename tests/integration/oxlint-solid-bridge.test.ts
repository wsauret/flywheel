import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";

// Guards the alpha oxlint <-> eslint-plugin-solid jsPlugin bridge. oxlint loads
// eslint-plugin-solid through its experimental JS-plugin API (oxlint.config.ts
// jsPlugins); if a version bump, a plugin-API change, or a config regression breaks
// that bridge, the solid rules silently stop firing and src/ loses its reactivity
// gate with a green lint. This test runs the PRODUCTION config over the permanent
// coverage fixtures and asserts the rules still fire -- so a broken bridge fails CI.
const repoRoot = resolve(import.meta.dir, "../..");
const oxlint = join(repoRoot, "node_modules", ".bin", "oxlint");
const config = join(repoRoot, "oxlint.config.ts");
// Blank Flywheel's packaged ast-grep napi-rs override; oxlint must load its own native binding.
const oxlintEnv = { ...process.env, NAPI_RS_NATIVE_LIBRARY_PATH: "" };

interface Diagnostic {
  code: string;
  labels: { span: { line: number } }[];
}

// The fixtures live in tests/fixtures/, outside the production src/ lint path, so
// `bun run lint` never reaches them. We invoke oxlint directly on the fixture path:
// the oxlint.config.ts override scopes tests/fixtures/oxlint-solid-*.tsx in, so the
// full recommended solid rule set applies exactly as it does for src/tui.
const lintFixture = (fixture: string) => {
  const result = spawnSync(oxlint, ["--config", config, "--format=json", `tests/fixtures/${fixture}`], {
    cwd: repoRoot,
    encoding: "utf8",
    env: oxlintEnv,
  });
  const parsed: { diagnostics: Diagnostic[] } = JSON.parse(result.stdout);
  const diagnostics = parsed.diagnostics;
  return {
    status: result.status,
    codes: new Set(diagnostics.map((d) => d.code)),
    linesFor: (code: string) => diagnostics.filter((d) => d.code === code).map((d) => d.labels[0]!.span.line),
  };
};

describe("oxlint <-> eslint-plugin-solid jsPlugin bridge", () => {
  describe("coverage fixture", () => {
    const lint = lintFixture("oxlint-solid-coverage.tsx");

    // Required by the regression contract: the two headline reactivity-safety rules.
    it("fires solid(reactivity) and solid(no-destructure)", () => {
      expect(lint.codes).toContain("solid(reactivity)");
      expect(lint.codes).toContain("solid(no-destructure)");
    });

    // Breadth check: a spread of error- and warn-level rules across the categories
    // the plugin covers (JSX safety, React-isms, output style). If the bridge half-
    // works -- loads but mis-dispatches -- some of these drop while reactivity holds.
    it("fires a representative spread of recommended rules", () => {
      for (const code of [
        "solid(jsx-no-duplicate-props)",
        "solid(jsx-no-undef)",
        "solid(no-innerhtml)",
        "solid(prefer-for)",
        "solid(no-react-specific-props)",
        "solid(self-closing-comp)",
      ]) {
        expect(lint.codes).toContain(code);
      }
    });

    // An error-level solid rule fires, so oxlint must exit non-zero. A green exit
    // here would mean the bridge produced only warnings or nothing -- a regression.
    it("exits non-zero because an error-level solid rule fired", () => {
      expect(lint.status).toBe(1);
    });

    // style-prop is overridden off in oxlint.config.ts; the kebab-case style key in
    // the fixture would otherwise trip it. Silence proves the off-override survives
    // the bridge -- a rule disabled in config must stay disabled.
    it("respects the style-prop off override", () => {
      expect(lint.codes).not.toContain("solid(style-prop)");
    });

    // oxlint must honor both disable-comment dialects so the existing eslint-disable
    // comments in src/ keep suppressing through the bridge. The two probe blocks hold
    // the same reactivity violation as the unguarded blocks; the suppressed reads sit
    // on fixture lines 117 (eslint-disable) and 126 (oxlint-disable). reactivity must
    // fire on the unguarded blocks yet never on either suppressed line.
    it("honors both eslint-disable and oxlint-disable directives", () => {
      const reactivityLines = lint.linesFor("solid(reactivity)");
      expect(reactivityLines.length).toBeGreaterThan(0);
      expect(reactivityLines).not.toContain(117);
      expect(reactivityLines).not.toContain(126);
    });
  });

  describe("typed-reactivity fixture", () => {
    const lint = lintFixture("oxlint-solid-typed-reactivity.tsx");

    // A reactivity loss whose source is a prop typed as a Solid Accessor. The plugin
    // is type-blind, but its scope heuristic treats every props.x read as reactive,
    // so the bridge still flags it -- at warning severity, so we read diagnostics
    // not the exit code.
    it("fires solid(reactivity) on the prop-derived loss", () => {
      expect(lint.codes).toContain("solid(reactivity)");
    });
  });
});
