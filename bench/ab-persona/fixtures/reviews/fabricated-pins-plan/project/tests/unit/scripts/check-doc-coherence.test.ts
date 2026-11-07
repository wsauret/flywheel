import { describe, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { checkDoc, checkDocs, checkRequiredStatements } from "../../../scripts/check-doc-coherence.js";

function tmpRepo(): string {
  const root = mkdtempSync("/tmp/flywheel-doc-coherence-");
  mkdirSync(join(root, "src", "orchestration", "session"), { recursive: true });
  mkdirSync(join(root, "docs"), { recursive: true });
  writeFileSync(join(root, "package.json"), "{}\n");
  return root;
}

describe("check-doc-coherence", () => {
  it("reports a wrong-cased entrypoint instead of relying on a case-insensitive filesystem", () => {
    const root = tmpRepo();
    try {
      writeFileSync(join(root, "AGENTS.md"), "Current instructions.\n");
      const violations = checkDocs(root, ["agents.md"]);
      expect(violations).toHaveLength(1);
      expect(violations[0]!.reason).toContain("document does not exist with this exact path");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reports a missing required architectural statement", () => {
    const root = tmpRepo();
    try {
      writeFileSync(join(root, "AGENTS.md"), "Stale instructions.\n");
      const violations = checkRequiredStatements(root, [
        { doc: "AGENTS.md", statement: "Rendered history is derived." },
      ]);
      expect(violations).toEqual([{
        doc: "AGENTS.md",
        ref: "Rendered history is derived.",
        reason: "required architectural statement is missing",
      }]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("passes a reference to a file that exists at its exact path", () => {
    const root = tmpRepo();
    try {
      writeFileSync(join(root, "src", "infra.ts"), "export const x = 1\n");
      writeFileSync(join(root, "AGENTS.md"), "See `infra.ts` for details.\n");
      expect(checkDoc(root, "AGENTS.md")).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("resolves a repo-root file like package.json directly", () => {
    const root = tmpRepo();
    try {
      writeFileSync(join(root, "AGENTS.md"), "Scripts declared in `package.json`.\n");
      expect(checkDoc(root, "AGENTS.md")).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("resolves prose shorthand that omits intermediate directories by path suffix", () => {
    const root = tmpRepo();
    try {
      writeFileSync(join(root, "src", "orchestration", "session", "pid-lock.ts"), "export const lock = 1\n");
      writeFileSync(join(root, "AGENTS.md"), "The lock lives in `session/pid-lock.ts`.\n");
      expect(checkDoc(root, "AGENTS.md")).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("flags a reference to a path that does not exist anywhere", () => {
    const root = tmpRepo();
    try {
      writeFileSync(join(root, "AGENTS.md"), "See `workflows/shared/invoke-pooled.ts` for the pool.\n");
      const violations = checkDoc(root, "AGENTS.md");
      expect(violations).toHaveLength(1);
      expect(violations[0]!.ref).toBe("workflows/shared/invoke-pooled.ts");
      expect(violations[0]!.reason).toContain("no file matches");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("flags a line citation past the end of the cited file", () => {
    const root = tmpRepo();
    try {
      writeFileSync(join(root, "src", "small.ts"), "const x = 1\nconst y = 2\n");
      writeFileSync(join(root, "AGENTS.md"), "See `small.ts:226` for the invariant.\n");
      const violations = checkDoc(root, "AGENTS.md");
      expect(violations).toHaveLength(1);
      expect(violations[0]!.reason).toContain("cites line 226");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("accepts a line citation within range, including a start-end span", () => {
    const root = tmpRepo();
    try {
      writeFileSync(join(root, "src", "small.ts"), `${"line\n".repeat(10)}`);
      writeFileSync(join(root, "AGENTS.md"), "See `small.ts:3` and `small.ts:5-8`.\n");
      expect(checkDoc(root, "AGENTS.md")).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("ignores a bare symbol call, which is not a path reference", () => {
    const root = tmpRepo();
    try {
      writeFileSync(join(root, "AGENTS.md"), "Call `invokePooled()` to run the pool.\n");
      expect(checkDoc(root, "AGENTS.md")).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not double-report the same reference cited twice", () => {
    const root = tmpRepo();
    try {
      writeFileSync(join(root, "AGENTS.md"), "See `missing.ts`. Also see `missing.ts` again.\n");
      expect(checkDoc(root, "AGENTS.md")).toHaveLength(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
