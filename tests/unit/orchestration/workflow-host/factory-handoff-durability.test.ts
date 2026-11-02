import { describe, expect, it } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { buildArtifactContext } from "../../../../src/orchestration/workflow-host/artifact-context.js"
import { createOutputAcceptContext } from "../../../../src/orchestration/workflow-host/output-accept-context.js"
import { fixture } from "../session/_session-change-fixtures.js"
import { validateAgentOutput } from "../../../../src/workflows/output-contract/accept.js"
import { compileOutput } from "../../../../src/workflows/output-contract/compile.js"

const research = compileOutput({ fields: { file_path: { type: "path", description: "The research document." } } })

describe("workflow host handoff authority", () => {
  it("resolves validation and artifact enrichment from the worker directory", async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "flywheel-handoff-project-"))
    const executionCwd = join(projectRoot, "flywheel-tui")
    try {
      mkdirSync(join(projectRoot, "docs", "research"), { recursive: true })
      mkdirSync(join(executionCwd, "docs", "research"), { recursive: true })
      mkdirSync(join(projectRoot, "src"), { recursive: true })
      mkdirSync(join(executionCwd, "src"), { recursive: true })
      writeFileSync(join(projectRoot, "docs", "research", "parent-only.md"), "wrong root\n")
      writeFileSync(join(executionCwd, "docs", "research", "audit.md"), "correct root\n")
      writeFileSync(join(projectRoot, "src", "marker.ts"), "export const marker = 'PARENT';\n")
      writeFileSync(join(executionCwd, "src", "marker.ts"), "export const marker = 'WORKER';\n")

      const validation = createOutputAcceptContext(executionCwd)
      const accepted = await validateAgentOutput(research, { file_path: "docs/research/audit.md", summary: "done" }, validation)
      expect(accepted.issues).toEqual([])
      const parentOnly = await validateAgentOutput(research, { file_path: "docs/research/parent-only.md", summary: "done" }, validation)
      expect(parentOnly.issues.map(({ path }) => path)).toEqual(["file_path"])

      const artifactContext = await buildArtifactContext([{ agentName: "Research", conversationIds: [], handoffs: [{
        summary: "done",
        files_modified: ["src/marker.ts"],
      }] }], { executionCwd, projectRoot, reader: fixture([]).projectionReader, workflowId: "s" }, new AbortController().signal)
      expect(artifactContext).toContain("WORKER")
      expect(artifactContext).not.toContain("PARENT")
    } finally {
      rmSync(projectRoot, { recursive: true, force: true })
    }
  })
})