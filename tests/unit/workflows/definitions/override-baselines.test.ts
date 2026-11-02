import { createHash } from "node:crypto"
import { existsSync, writeFileSync } from "node:fs"
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { describe, expect, test } from "bun:test"

import { resolveDefinitionCandidates } from "../../../../src/infra/definition-resolution.js"
import { acquireLock, releaseLock } from "../../../../src/infra/ownership-file-lock.js"
import { observeDefinitionOverrideBaselines, readDefinitionOverrideBaselines } from "../../../../src/workflows/definitions/override-baselines.js"
import { deriveDefinitionStalenessReport } from "../../../../src/workflows/definitions/override-staleness.js"
import { temporaryDirectories } from "../../../helpers/directories.js"

const hash = (content: string): string => createHash("sha256").update(content).digest("hex")
const catalog = (content = "bundled") => ({ files: { "agents/reviewer.md": { content, overlayTarget: "agents/reviewer.md", sourceHash: hash(content), baseDefaultHash: hash(content) } } })

function resolution(path: string) {
  return resolveDefinitionCandidates("persona", "reviewer", "agents/reviewer.md", [
    { kind: "valid", source: { path, layer: "user", identity: hash("override") }, value: "override" },
    { kind: "valid", source: { path: "/bundle/agents/reviewer.md", layer: "bundled", identity: hash("bundled") }, value: "bundled" },
  ])
}

describe("definition override baselines", () => {
  const temporaryDirectory = temporaryDirectories()

  test("observes no overrides without acquiring mutation ownership", async () => {
    const userDataRoot = temporaryDirectory("flywheel-baselines-")
    const manifestPath = join(userDataRoot, "definition-override-baselines.json")
    await mkdir(`${manifestPath}.lock`)

    expect(await observeDefinitionOverrideBaselines({ userDataRoot, resolutions: [], catalog: catalog() })).toEqual({})
    expect(existsSync(manifestPath)).toBe(false)
  })

  test("reads acknowledged overrides without mutation ownership or snapshot repair", async () => {
    const userDataRoot = temporaryDirectory("flywheel-baselines-")
    const overridePath = join(userDataRoot, "agents", "reviewer.md")
    const manifestPath = join(userDataRoot, "definition-override-baselines.json")
    const retiredPath = join(userDataRoot, "workflows", "debug.yaml")
    const records = {
      [overridePath]: { acknowledged_default_hash: hash("older") },
      [retiredPath]: { acknowledged_default_hash: hash("retired workflow") },
    }
    const manifest = JSON.stringify({ version: 1, records })
    await writeFile(manifestPath, manifest)
    await mkdir(`${manifestPath}.lock`)

    expect(await observeDefinitionOverrideBaselines({ userDataRoot, resolutions: [resolution(overridePath)], catalog: catalog() })).toEqual(records)
    expect(await readFile(manifestPath, "utf8")).toBe(manifest)
    expect(existsSync(`${overridePath}.base`)).toBe(false)
    expect(readDefinitionOverrideBaselines(userDataRoot)).toEqual({ kind: "readable", records })
    expect(deriveDefinitionStalenessReport([resolution(overridePath)], catalog(), records).overrides.map(({ path }) => path)).toEqual([overridePath])
  })

  test("publishes a current snapshot before recording the first baseline", async () => {
    const userDataRoot = temporaryDirectory("flywheel-baselines-")
    const overridePath = join(userDataRoot, "agents", "reviewer.md")
    const retiredPath = join(userDataRoot, "workflows", "debug.yaml")
    const retainedRecords = { [retiredPath]: { acknowledged_default_hash: hash("retired workflow") } }
    await writeFile(join(userDataRoot, "definition-override-baselines.json"), JSON.stringify({ version: 1, records: retainedRecords }))
    await mkdir(join(userDataRoot, "agents"), { recursive: true })
    await writeFile(overridePath, "override")

    const records = await observeDefinitionOverrideBaselines({ userDataRoot, resolutions: [resolution(overridePath)], catalog: catalog() })

    expect(records[overridePath]).toEqual({ acknowledged_default_hash: hash("bundled") })
    expect(await readFile(`${overridePath}.base`, "utf8")).toBe("bundled")
    expect(JSON.parse(await readFile(join(userDataRoot, "definition-override-baselines.json"), "utf8"))).toEqual({
      version: 1,
      records: { ...retainedRecords, [overridePath]: { acknowledged_default_hash: hash("bundled") } },
    })
  })

  test("uses an existing snapshot identity for the first baseline", async () => {
    const userDataRoot = temporaryDirectory("flywheel-baselines-")
    const overridePath = join(userDataRoot, "agents", "reviewer.md")
    await mkdir(join(userDataRoot, "agents"), { recursive: true })
    await writeFile(`${overridePath}.base`, "older")

    const records = await observeDefinitionOverrideBaselines({ userDataRoot, resolutions: [resolution(overridePath)], catalog: catalog() })

    expect(records[overridePath]).toEqual({ acknowledged_default_hash: hash("older") })
  })

  test("rereads concurrent acknowledgments after acquiring mutation ownership", async () => {
    const userDataRoot = temporaryDirectory("flywheel-baselines-")
    const overridePath = join(userDataRoot, "agents", "reviewer.md")
    const manifestPath = join(userDataRoot, "definition-override-baselines.json")
    const ownership = await acquireLock(`${manifestPath}.lock`)
    const observation = observeDefinitionOverrideBaselines({ userDataRoot, resolutions: [resolution(overridePath)], catalog: catalog() })
    const records = {
      [overridePath]: { acknowledged_default_hash: hash("older") },
      [join(userDataRoot, "other-project", "reviewer.md")]: { acknowledged_default_hash: hash("other") },
    }
    try {
      writeFileSync(manifestPath, JSON.stringify({ version: 1, records }))
    } finally {
      releaseLock(ownership)
    }

    expect(await observation).toEqual(records)
    expect(readDefinitionOverrideBaselines(userDataRoot)).toEqual({ kind: "readable", records })
    expect(existsSync(`${overridePath}.base`)).toBe(false)
  })

  test.each([
    ["bytes that are not JSON", "{\"version\": 1, \"records\": {"],
    ["an unknown manifest shape", JSON.stringify({ version: 1, records: {}, extra: true })],
    ["an invalid record", JSON.stringify({ version: 1, records: { "/elsewhere/reviewer.md": { acknowledged_default_hash: "short" } } })],
  ])("moves an unreadable manifest with %s aside and rebuilds it from the snapshots", async (_manifest, bytes) => {
    const userDataRoot = temporaryDirectory("flywheel-baselines-")
    const overridePath = join(userDataRoot, "agents", "reviewer.md")
    const manifestPath = join(userDataRoot, "definition-override-baselines.json")
    await mkdir(join(userDataRoot, "agents"), { recursive: true })
    await writeFile(`${overridePath}.base`, "older")
    await writeFile(manifestPath, bytes)

    const records = await observeDefinitionOverrideBaselines({ userDataRoot, resolutions: [resolution(overridePath)], catalog: catalog() })

    expect(records).toEqual({ [overridePath]: { acknowledged_default_hash: hash("older") } })
    expect(readDefinitionOverrideBaselines(userDataRoot)).toEqual({ kind: "readable", records })
    const aside = (await readdir(userDataRoot)).filter((name) => name.startsWith("definition-override-baselines.json.unreadable-"))
    expect(aside).toHaveLength(1)
    expect(await readFile(join(userDataRoot, aside[0] ?? ""), "utf8")).toBe(bytes)
  })

  test("repairs an unreadable manifest even when no override needs a baseline", async () => {
    const userDataRoot = temporaryDirectory("flywheel-baselines-")
    await writeFile(join(userDataRoot, "definition-override-baselines.json"), "not json")

    expect(await observeDefinitionOverrideBaselines({ userDataRoot, resolutions: [], catalog: catalog() })).toEqual({})
    expect(readDefinitionOverrideBaselines(userDataRoot)).toEqual({ kind: "readable", records: {} })
  })
})
