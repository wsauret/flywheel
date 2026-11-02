import { describe, expect, it } from "bun:test";

import type { GrepMatch } from "../../../../../src/orchestration/agent-runtime/tools/ripgrep.js";
import {
  classifyPath,
  isDefinitionLine,
  isImportLine,
  rankMatches,
} from "../../../../../src/orchestration/agent-runtime/tools/search-ranking.js";
import type { RankedMatch } from "../../../../../src/orchestration/agent-runtime/tools/search-ranking.js";

function match(path: string, line: string): GrepMatch {
  return { path, lineNumber: 1, line };
}

describe("isDefinitionLine", () => {
  it("matches definition lines across languages", () => {
    expect(isDefinitionLine("pub fn foo() {}")).toBe(true);
    expect(isDefinitionLine("export default class X {}")).toBe(true);
    expect(isDefinitionLine("async function y() {}")).toBe(true);
    expect(isDefinitionLine("pub(crate) struct S {}")).toBe(true);
    expect(isDefinitionLine("interface I {}")).toBe(true);
    expect(isDefinitionLine("def thing():")).toBe(true);
    expect(isDefinitionLine("type T = number")).toBe(true);
    expect(isDefinitionLine("impl Foo {}")).toBe(true);
  });

  it("rejects non-definition lines and respects word boundaries", () => {
    expect(isDefinitionLine("let x = foo()")).toBe(false);
    expect(isDefinitionLine("// fn comment")).toBe(false);
    expect(isDefinitionLine("funcy()")).toBe(false);
    expect(isDefinitionLine("myStruct.field")).toBe(false);
  });
});

describe("isImportLine", () => {
  it("matches import/use lines", () => {
    expect(isImportLine("import x")).toBe(true);
    expect(isImportLine('from "y"')).toBe(true);
    expect(isImportLine("use a::b")).toBe(true);
    expect(isImportLine("require('z')")).toBe(true);
    expect(isImportLine("require ('z')")).toBe(true);
    expect(isImportLine("#include <h>")).toBe(true);
    expect(isImportLine("#  include \"h\"")).toBe(true);
  });

  it("rejects look-alikes", () => {
    expect(isImportLine("important = 1")).toBe(false);
    expect(isImportLine("from = 3")).toBe(false);
    expect(isImportLine("using()")).toBe(false);
  });
});

describe("classifyPath", () => {
  it("classifies vendor, test, and source by segment", () => {
    expect(classifyPath("node_modules/x.js")).toBe("vendor");
    expect(classifyPath("dist/a.js")).toBe("vendor");
    expect(classifyPath("lib/foo.min.js")).toBe("vendor");
    expect(classifyPath("tests/foo.test.ts")).toBe("test");
    expect(classifyPath("__fixtures__/x.ts")).toBe("test");
    expect(classifyPath("src/app.ts")).toBe("source");
    // Segment match, not substring: "testing-utils" must not be a test.
    expect(classifyPath("src/testing-utils.ts")).toBe("source");
  });
});

describe("rankMatches", () => {
  function fixture(): GrepMatch[] {
    return [
      match("src/a.ts", "import { target } from './x'"),
      match("src/a.ts", "target()"),
      match("src/a.ts", "export function target() {}"),
    ];
  }

  it("orders definition, usage, import and keeps the import visible", () => {
    const input = fixture();
    const out = rankMatches(input, { rankingEnabled: true, preferTests: false });

    expect(out.map((r) => r.tier)).toEqual([0, 1, 2]);
    expect(out[0]?.match.line).toContain("export function target");
    expect(out[1]?.match.line).toBe("target()");
    // (b) the import is present, not dropped (divergence from fff suppression).
    expect(out.some((r) => r.match.line.includes("import"))).toBe(true);
    expect(out.length).toBe(3);
  });

  it("does not mutate the input array and wraps the original objects", () => {
    const input = fixture();
    const snapshot = input.map((m) => ({ ...m }));
    const out = rankMatches(input, { rankingEnabled: true, preferTests: false });

    // (c) input unchanged (no in-place sort, no field writes).
    expect(input).toEqual(snapshot);
    // (d) each output .match is referentially identical to an input object.
    for (const r of out) {
      expect(input).toContain(r.match);
    }
  });

  it("identity mode keeps input order but reports real isDefinition", () => {
    const input = fixture();
    const out = rankMatches(input, { rankingEnabled: false, preferTests: false });

    // (e) order preserved, all tier 1.
    expect(out.map((r) => r.match.line)).toEqual(input.map((m) => m.line));
    expect(out.every((r) => r.tier === 1)).toBe(true);
    // isDefinition still reflects actual classification, NOT hard-coded false.
    const def = out.find((r) => r.match.line.includes("export function target"));
    expect(def?.isDefinition).toBe(true);
  });

  it("inverts path weight when preferTests is true", () => {
    const input: GrepMatch[] = [
      match("src/x.ts", "callTarget()"),
      match("tests/x.test.ts", "callTarget()"),
    ];
    const normal = rankMatches(input, { rankingEnabled: true, preferTests: false });
    const inverted = rankMatches(input, { rankingEnabled: true, preferTests: true });

    // (f) inversion flips cross-class ordering for same-tier matches.
    expect(normal[0]?.match.path).toBe("src/x.ts");
    expect(inverted[0]?.match.path).toBe("tests/x.test.ts");
  });

});

// Compile-time guard that RankedMatch fields are readonly is enforced by tsc;
// this runtime reference keeps the type imported and used.
const _typeGuard: (r: RankedMatch) => boolean = (r) => r.isDefinition;
void _typeGuard;
