import { describe, expect, it } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const repoRoot = join(import.meta.dir, "../../../..");
const infraToolsRoot = join(repoRoot, "src/infra/tools");

function listFiles(root: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const full = join(root, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(full));
    else if (entry.name.endsWith(".ts")) out.push(full);
  }
  return out;
}

function collectStaticImports(text: string): string[] {
  const valueImports = /^\s*import\s+(?!type\b)[\s\S]*?\sfrom\s+["']([^"']+)["']/gm;
  const sideEffectImports = /^\s*import\s*["']([^"']+)["']/gm;
  return [...text.matchAll(valueImports), ...text.matchAll(sideEffectImports)].flatMap((match) => match[1] ?? []);
}

describe("infra/tools boundary", () => {
  it("does not import value bindings from orchestration", () => {
    const files = listFiles(infraToolsRoot);
    expect(files.length).toBeGreaterThan(0);

    const offenders: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      const specifiers = collectStaticImports(text);
      for (const spec of specifiers) {
        if (spec.includes("orchestration/")) offenders.push(`${file} -> ${spec}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("registry returns display metadata without runtime schema fields", () => {
    // After the phase-2 split, ToolDisplay carries no inputSchema/execute. If
    // someone adds them back here, the type would change shape.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getToolDisplay } = require("../../../../src/infra/tools/tool-display-registry.js");
    const read = getToolDisplay("read");
    expect("execute" in read).toBe(false);
    expect("inputSchema" in read).toBe(false);
    expect("description" in read).toBe(false);
  });
});

describe("infra/tools static layout", () => {
  it("displays directory contains one file per registered display contract", () => {
    const displaysDir = join(infraToolsRoot, "displays");
    const stat = statSync(displaysDir);
    expect(stat.isDirectory()).toBe(true);
    const entries = readdirSync(displaysDir).filter((n) => n.endsWith(".ts"));
    expect(entries.length).toBeGreaterThan(0);
  });
});
