import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { resolveWorkflowAgents } from "../../../src/workflows/agent-resolution.js";
import { verifyAuthoredWorkflow } from "../../../src/workflows/vm/verify.js";
import { loadWorkflowFile } from "../../../src/workflows/workflow-file.js";
import { repoDefinitions } from "../../helpers/project-definitions.js";

describe("answer-key review workflow", () => {
  it("loads and verifies the committed workflow", () => {
    const file = resolve(import.meta.dir, "../../../bench/harbor/workflows/answer-key-review.workflow.yaml");
    const skills = repoDefinitions().captureRevision().skills;
    const loaded = loadWorkflowFile({ file, content: readFileSync(file, "utf8"), location: { root: { kind: "directory", dir: dirname(file) }, path: basename(file) }, provenance: { layer: "session", filePath: file }, skills });
    if (!loaded.ok) throw new Error(JSON.stringify(loaded.diagnostics));
    const report = verifyAuthoredWorkflow(loaded.workflow, resolveWorkflowAgents(loaded.workflow), { skills });
    expect(report.result).not.toBe("invalid");
  });
});
