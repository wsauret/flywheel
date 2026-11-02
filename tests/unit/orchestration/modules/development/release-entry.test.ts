import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { BINARY_ENTRIES } from "../../../../../scripts/binary-entries.js";
import { importChain } from "../../../../helpers/import-graph.js";

const REPO_ROOT = resolve(import.meta.dir, "../../../../..");
const DEVELOPMENT_CATALOG = resolve(REPO_ROOT, "src/orchestration/development-modules.ts");

describe("the release entries", () => {
  for (const entry of BINARY_ENTRIES) {
    test(`${entry} never imports the development catalog, so a release bundle cannot contain it`, () => {
      expect(importChain(resolve(REPO_ROOT, entry), "bundled", (module) => module.kind === "file" && module.path === DEVELOPMENT_CATALOG)).toBeUndefined();
    });
  }
});
