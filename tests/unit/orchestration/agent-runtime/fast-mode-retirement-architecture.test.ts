import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { extname, relative, resolve } from "node:path";

const PRODUCTION_ROOT = resolve(import.meta.dir, "../../../../src");
const EXCLUDED_PATH_SEGMENTS = new Set(["archive", "docs", "inspiration", "jobs", ".git"]);
const RETIRED_IDENTIFIERS = [
  /run_in_background/,
  /completeWithBackgroundWork/,
  /dispatchProcessWait/,
  /runner-compatibility-profile/,
] as const;
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);
const GENERIC_EXTERNAL_APPLY_PATCH_POLICY_EXCEPTION = "apply_patch";

function productionSourceFiles(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    if (EXCLUDED_PATH_SEGMENTS.has(entry.name)) return [];
    const path = resolve(root, entry.name);
    if (entry.isDirectory()) return productionSourceFiles(path);
    return SOURCE_EXTENSIONS.has(extname(entry.name)) ? [path] : [];
  });
}

describe("Fast mode retirement architecture", () => {
  test("production source contains no retired Fast shell, process, loop, or selector identifiers", () => {
    const violations = productionSourceFiles(PRODUCTION_ROOT).flatMap((path) => {
      const source = readFileSync(path, "utf8");
      return source.split("\n").flatMap((line, index) => {
        if (line.includes(GENERIC_EXTERNAL_APPLY_PATCH_POLICY_EXCEPTION) && line.includes("generic external command")) return [];
        return RETIRED_IDENTIFIERS.some((identifier) => identifier.test(line))
          ? [`${relative(PRODUCTION_ROOT, path)}:${index + 1}: ${line.trim()}`]
          : [];
      });
    });

    expect(violations).toEqual([]);
  });
});

describe("Request tool authority", () => {
  test("production exposes only plan-owned request surfaces", () => {
    const violations = productionSourceFiles(PRODUCTION_ROOT).flatMap((path) => {
      const source = readFileSync(path, "utf8");
      return ["RequestToolSurfaceSource", "resolveToolSurfaceOwner", "getBaseTools"].flatMap((identifier) =>
        source.includes(identifier) ? [`${relative(PRODUCTION_ROOT, path)}: ${identifier}`] : [],
      );
    });

    expect(violations).toEqual([]);
  });

  test("AgentLoopOptions rejects raw tool maps", () => {
    const source = readFileSync(resolve(PRODUCTION_ROOT, "orchestration/agent-runtime/agent-loop-types.ts"), "utf8");
    expect(source).toContain("tools: RequestToolSurfaceOwner;");
    expect(source).not.toContain("tools: RequestToolSurfaceSource;");
  });
});
