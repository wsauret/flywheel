import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"

import { loadBundledDefaultCatalog } from "../../../../src/workflows/definitions/bundled-defaults.js"

function packageIdentity(files: readonly (readonly [string, string])[]): string {
  const identity = createHash("sha256")
  for (const [path, content] of files) {
    const contentHash = createHash("sha256").update(content).digest("hex")
    identity.update(`${Buffer.byteLength(path)}:${path}${contentHash.length}:${contentHash}`)
  }
  return identity.digest("hex")
}

describe("bundled default catalog", () => {
  test("lists Flywheel's own definitions and never a module's definition bundle", () => {
    const paths = Object.keys(loadBundledDefaultCatalog().files)

    // The development module's definitions ship only where the module does
    // and are never reference defaults, so no build publishes them.
    expect(paths.some((path) => path.startsWith("skills/typescript-bun/"))).toBe(false)
    expect(paths).not.toContain("workflows/bench-plan.yaml")

    expect(paths).toContain("skills/design/SKILL.md")
    expect(paths.filter((path) => /^workflows\/[^/]+\.ya?ml$/.test(path))).toEqual([])
    expect(paths).toContain("workflows/contracts/implementation-plan.json")
    expect(paths).toContain("system-prompt.md")
  })

  test("publishes clean bytes with deterministic shipped identities", () => {
    const catalog = loadBundledDefaultCatalog()
    const skillFiles = Object.entries(catalog.files)
      .filter(([path]) => path.startsWith("skills/design/"))
      .map(([path, file]) => [path.slice("skills/design/".length), file.content] as const)
      .sort(([left], [right]) => left.localeCompare(right))
    const skill = catalog.files["skills/design/SKILL.md"]

    expect(Object.values(catalog.files).every((file) => !file.content.includes("base_default_hash:"))).toBe(true)
    expect(Object.values(catalog.files).every((file) => file.sourceHash === createHash("sha256").update(file.content).digest("hex"))).toBe(true)
    expect(skill?.baseDefaultHash).toBe(packageIdentity(skillFiles))
  })

  test("ships conditional Advisor review in the design approval contract", () => {
    const skill = loadBundledDefaultCatalog().files["skills/design/SKILL.md"]?.content

    expect(skill).toContain("Advisor review first")
    expect(skill).toContain("conditionally approves the unchanged design")
    expect(skill).toContain("recommends no material change")
    expect(skill).toContain("raises a material concern")
    expect(skill).toContain("fails or is unavailable")
  })
})
