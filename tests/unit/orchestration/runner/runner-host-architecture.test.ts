import { expect, it } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { extname, relative, resolve, sep } from "node:path"

const ORCHESTRATION_ROOT = resolve(import.meta.dir, "../../../../src/orchestration")
const ALLOWED_CONSTRUCTORS = new Map([
  ["runner/context.ts", ["createRunnerContext("]],
  ["runner/agent-turn.ts", ["runAgentTurn("]],
  ["runner/host.ts", ["runAgentTurn("]],
])

function sourceFiles(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(root, entry.name)
    if (entry.isDirectory()) return sourceFiles(path)
    return extname(entry.name) === ".ts" ? [path] : []
  })
}

it("keeps raw production runner construction inside the shared host and canonical factories", () => {
  const violations = sourceFiles(ORCHESTRATION_ROOT).flatMap((path) => {
    const source = readFileSync(path, "utf8")
    // The allowlist below names repository paths the one way; `relative` answers
    // in host separators.
    const localPath = relative(ORCHESTRATION_ROOT, path).replaceAll(sep, "/")
    const allowed = ALLOWED_CONSTRUCTORS.get(localPath) ?? []
    return ["createRunnerContext(", "runAgentTurn("].flatMap((constructor) =>
      source.includes(constructor) && !allowed.includes(constructor)
        ? [`${localPath}: ${constructor}`]
        : [],
    )
  })

  expect(violations).toEqual([])
})

it("keeps one logical turn execution in the shared runner host without a forwarding context", () => {
  const source = readFileSync(resolve(ORCHESTRATION_ROOT, "runner/host.ts"), "utf8")
  expect(source.match(/\bcreateRunnerContext\s*\(/g)).toBeNull()
  expect(source.match(/\brunAgentTurn\s*\(\s*\{/g)).toHaveLength(1)
})
