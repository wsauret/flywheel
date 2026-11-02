import { describe, expect, it } from "bun:test";
import {
  COMBINED_REVIEW_PROMPT,
  MEMORY_REVIEW_PROMPT,
  SKILL_REVIEW_PROMPT,
} from "../../../../../src/orchestration/modules/learning/learning-review-prompts.js";

describe("learning review classification", () => {
  const prompts = [MEMORY_REVIEW_PROMPT, SKILL_REVIEW_PROMPT, COMBINED_REVIEW_PROMPT];

  it("sends preferences and stable user facts to global memory", () => {
    for (const prompt of prompts) {
      expect(prompt).toContain("Preference");
      expect(prompt).toContain("global memory");
      expect(prompt).toContain("A preference is never a skill.");
    }
  });

  it("separates selective memory from repository instructions and session notes", () => {
    for (const prompt of prompts) {
      expect(prompt).toContain("many future sessions");
      expect(prompt).toContain("AGENTS.md");
      expect(prompt).toContain("Session notes");
      expect(prompt).toContain("do not edit repository files");
      expect(prompt).toContain("project memory");
      expect(prompt).not.toContain("this repository's commands, paths, architecture, conventions, or a verified environment fact) -> project memory");
    }
  });

  it("makes a repeatable procedure the only skill trigger and defaults a generated skill to project", () => {
    for (const prompt of prompts) {
      expect(prompt).toContain("Repeatable procedure");
      expect(prompt).toContain("a project skill");
      expect(prompt).toContain("Generated learning defaults to project");
    }
  });

  it("tells the background review that a global skill write is refused", () => {
    for (const prompt of prompts) {
      expect(prompt).toContain("cannot create, rewrite, patch, archive, restore, or change support files in a global package");
    }
  });

  it("keeps nothing to save a normal outcome with no write-pressure language", () => {
    for (const prompt of prompts) {
      expect(prompt).toContain("'Nothing to save.' is a correct and complete outcome.");
      expect(prompt).not.toContain("missed learning opportunity");
      expect(prompt).not.toContain("Be ACTIVE");
    }
  });

  it("saves nothing for a smooth session or an unresolved failure", () => {
    for (const prompt of prompts) {
      expect(prompt).toContain("transient failures that resolved");
      expect(prompt).toContain("unresolved failures where no working method was found");
    }
  });
});
