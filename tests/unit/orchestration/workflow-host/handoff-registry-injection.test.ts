import { describe, expect, it } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { join, relative } from "node:path"

const EXECUTION_ROOTS = ["src/workflows", "src/orchestration"] as const







const REVISION_CAPTURE_ALLOWLIST = new Set([
  // Direct chat and headless task starts capture the persona roster for that
  // admitted runner before any model request is assembled.
  "src/orchestration/chat/runner.ts",
  "src/orchestration/headless/run-headless-task.ts",
  "src/orchestration/modules/workflows/migrations/workflow-identity-chain.ts",
  "src/orchestration/workflow-host/controller.ts",
  "src/orchestration/app-service/definition-availability.ts",
  "src/orchestration/modules/workflows/cli/verify.ts",
  // An Ask approval question of a workflow file reads the file against the
  // revision that a launch would capture, so the question binds the hash
  // of the definition that the launch admits.
  "src/orchestration/modules/workflows.ts",
])

function sourceFiles(root: string): string[] {
  return readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
    .map((entry) => join(entry.parentPath, entry.name))
}

function offenders(pattern: RegExp, allowlist: ReadonlySet<string>): string[] {
  return EXECUTION_ROOTS
    .flatMap(sourceFiles)
    .map((path) => ({ path: relative(process.cwd(), path).replaceAll("\\", "/"), source: readFileSync(path, "utf8") }))
    .filter(({ path, source }) => pattern.test(source) && !allowlist.has(path))
    .map(({ path }) => path)
    .sort()
}

describe("workflow execution registry injection", () => {
  it("captures project-definition revisions only at approved boundaries", () => {
    expect(offenders(/\.captureRevision\s*\(/, REVISION_CAPTURE_ALLOWLIST)).toEqual([])
  })
})
