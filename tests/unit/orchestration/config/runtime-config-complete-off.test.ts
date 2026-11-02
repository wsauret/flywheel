import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { join, relative } from "node:path"

const root = join(import.meta.dir, "../../../../src")

function sources(directory = root): readonly string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    return entry.isDirectory() ? sources(path) : entry.name.endsWith(".ts") || entry.name.endsWith(".tsx") ? [path] : []
  })
}

// Read the tree once: each pattern scans the same text, and re-reading every
// source file for each pattern let a loaded host push one case past its bound.
let sourceTexts: ReadonlyArray<readonly [string, string]> | undefined

function matchingFiles(pattern: RegExp): readonly string[] {
  sourceTexts ??= sources().map((path) => [relative(root, path).replaceAll("\\", "/"), readFileSync(path, "utf8")] as const)
  return sourceTexts.filter(([, text]) => pattern.test(text)).map(([path]) => path).sort()
}

describe("runtime config complete-off", () => {
  test("keeps the only resident flywheel.toml watcher in RuntimeConfigOwner", () => {
    expect(matchingFiles(/\bwatchConfigFile\b/)).toEqual([
      "orchestration/config/config-file.ts",
      "orchestration/config/runtime-config-owner.ts",
    ])
  })

  test("has no obsolete resident config surfaces", () => {
    for (const obsolete of [
      /config\.refresh/,
      /configRefresh/,
      /createLiveConfigAccessor/,
      /refreshRuntime/,
    ]) expect(matchingFiles(obsolete)).toEqual([])
  })
})
