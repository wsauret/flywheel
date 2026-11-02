import { expect, test } from "bun:test";
import { isQualifiedSkillId, isQualifiedSkillIdPrefix, normalizeSkillId, requireQualifiedSkillId } from "../src/infra/skill-id";

test("skill-id: accepts ids that only begin with the letters of the learned root", () => {
  for (const id of ["learned-notes", "learnedx", "learnedtools.fix"]) {
    expect(isQualifiedSkillId(id)).toBe(true);
    expect(isQualifiedSkillIdPrefix(id)).toBe(true);
    expect(normalizeSkillId(` ${id.toUpperCase()} `)).toBe(id);
    expect(requireQualifiedSkillId(id, "skill")).toBe(id);
  }
});

test("skill-id: still reserves the learned root and its namespace", () => {
  for (const id of ["learned", "learned.notes", "learned.a.b"]) {
    expect(isQualifiedSkillId(id)).toBe(false);
    expect(isQualifiedSkillIdPrefix(id)).toBe(false);
    expect(normalizeSkillId(id)).toBeNull();
    expect(() => requireQualifiedSkillId(id, "skill")).toThrow("reserved learned-skill command root");
  }
  expect(isQualifiedSkillId("help")).toBe(false);
  expect(isQualifiedSkillIdPrefix("help")).toBe(true);
});
