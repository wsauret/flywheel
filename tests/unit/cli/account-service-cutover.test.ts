import { describe, expect, test } from "bun:test"
import * as fs from "node:fs"
import * as path from "node:path"

const ROOT = path.resolve(import.meta.dir, "../../..")
const PRODUCTION_ROOTS = ["src", "vscode/src"] as const
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx"])
const FORBIDDEN = [
  /\bide\.(?:listening|already-listening|startup\.phase|startup\.failed)\b/,
  /\bideRuntimeIdentityPath\b/,
  /\bideSocketPath\b/,
  /\bideStartLockPath\b/,
  /\bremote host\b/,
  /\bremote-host\b/,
  /\bcreateProjectRuntimeAttach\b/,
  /\bdecodeIdeStatusLine\b/,
  /\bIdeStatusRecord\b/,
] as const

function sourceFiles(root: string): readonly string[] {
  return fs.readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const candidate = path.join(root, entry.name)
    if (entry.isDirectory()) return sourceFiles(candidate)
    return SOURCE_EXTENSIONS.has(path.extname(entry.name)) ? [candidate] : []
  })
}

describe("account service production cutover", () => {
  test("has no legacy serving target in production source", () => {
    const violations = PRODUCTION_ROOTS.flatMap((relativeRoot) => sourceFiles(path.join(ROOT, relativeRoot))).flatMap((file) => {
      const text = fs.readFileSync(file, "utf8")
      return FORBIDDEN.flatMap((pattern) => pattern.test(text) ? [`${path.relative(ROOT, file)}: ${pattern.source}`] : [])
    })
    expect(violations).toEqual([])
  })
})
