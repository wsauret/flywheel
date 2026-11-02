import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadEngineeringDoctrine } from "../../../../src/infra/agent-assets/system-prompt.js";
import { buildSystemPrompt, type PromptKind } from "../../../../src/orchestration/agent-runtime/system-prompt.js";
import { renderSystemPrompt } from "../../../../src/orchestration/agent-runtime/llm/system-prompt-tiers.js";
import { testDirectories } from "../../../helpers/directories.js";

const promptRealmPath = mkdtempSync(join(tmpdir(), "commit-publication-prompt-"));
const engineeringDoctrine = loadEngineeringDoctrine(testDirectories(promptRealmPath));
const PROMPT_KINDS: readonly PromptKind[] = ["chat", "workflow-agent", "subagent", "headless"];
const COMMIT_MARKERS = [
  "A repository-changing unit is complete only when relevant verification passes and the unit is committed and pushed.",
  "Commit and push before starting another unit or reporting completion.",
  "use `commit + push` without asking for a publication-mode decision",
  "Run the repository's standard gates first.",
  "If unrelated concurrent work makes a global gate fail, prove that the failure is unrelated",
  "run the narrowest relevant tests and lint or type checks for the unit's changed files, then commit and push.",
  "Unrelated concurrent failures are not blockers.",
] as const;

afterAll(() => rmSync(promptRealmPath, { recursive: true, force: true }));

describe("commit publication prompt contract", () => {
  for (const promptKind of PROMPT_KINDS) {
    it(`reaches ${promptKind} agents that author code`, () => {
      const prompt = renderSystemPrompt(buildSystemPrompt({ corePrompt: "core", engineeringDoctrine, tools: [], promptKind }));
      expect(prompt).toContain("COMMITS:");
      for (const marker of COMMIT_MARKERS) expect(prompt).toContain(marker);
    });
  }
});
