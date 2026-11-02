import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { expect, test } from "bun:test"
import { createDefinitionOverrideService } from "../../../../src/orchestration/definition-overrides/override-service.js"
import { temporaryDirectories } from "../../../helpers/directories.js"

const hash = (content: string): string => createHash("sha256").update(content).digest("hex")
const file = (content: string, baseDefaultHash = hash(content)) => ({ content, overlayTarget: "unused", sourceHash: hash(content), baseDefaultHash, stamp: "file" as const })
const baselines = { set: async (): Promise<void> => {} }
const temporaryDirectory = temporaryDirectories()

function packageIdentity(files: readonly (readonly [string, string])[]): string {
  const identity = createHash("sha256")
  for (const [path, content] of files) {
    const contentHash = hash(content)
    identity.update(`${Buffer.byteLength(path)}:${path}${contentHash.length}:${contentHash}`)
  }
  return identity.digest("hex")
}

test("prepares verified single-file bytes and applies only the complete approved result before refresh", async () => {
  const root = temporaryDirectory("override-rebase-")
  const path = join(root, "system-prompt.md")
  const snapshotPath = `${path}.base`
  await writeFile(path, "mine\n")
  await writeFile(snapshotPath, "base\n")
  const events: string[] = []
  const override = { family: "system-prompt" as const, id: "system-prompt", layer: "project" as const, path, catalogPath: "system-prompt.md", status: "upstream-changed" as const, valid: true, baseDefaultHash: hash("base\n"), currentDefaultHash: hash("theirs\n"), snapshotPath, snapshotAvailable: true }
  const service = createDefinitionOverrideService({ catalog: { files: { "system-prompt.md": file("theirs\n") } }, baselines, load: async () => ({ overrides: [override], diagnostics: [] }) })

  const inputs = await service.prepare(path, "rebase")
  expect(inputs.source).toEqual({ kind: "verified-three-way", base: { kind: "single-file", content: "base\n" }, theirs: { kind: "single-file", content: "theirs\n" }, mine: { kind: "single-file", content: "mine\n" } })
  const prepared = await service.prepare(path, "rebase", { kind: "single-file", content: "merged\n" })
  expect(prepared.diff?.files[0]?.unifiedDiff).toContain("merged")
  // Apply reloads and notifies once before it writes and once after; the
  // last notification is the seam that proves the file was written before
  // the report was refreshed.
  service.subscribe(() => { events.push(readFileSync(path, "utf8")) })
  await service.apply(prepared)

  expect(events.at(-1)).toContain("merged")
  expect(await readFile(snapshotPath, "utf8")).toBe("theirs\n")
})

test("returns complete sorted skill package maps and degrades when any snapshot byte invalidates its package identity", async () => {
  const root = temporaryDirectory("override-skill-rebase-")
  const packageDir = join(root, "demo")
  const path = join(packageDir, "SKILL.md")
  const snapshotPath = join(packageDir, ".base")
  await mkdir(join(packageDir, "references"), { recursive: true })
  await mkdir(join(snapshotPath, "references"), { recursive: true })
  await writeFile(path, "mine skill")
  await writeFile(join(packageDir, "references", "z.md"), "mine resource")
  await writeFile(join(snapshotPath, "SKILL.md"), "base skill")
  await writeFile(join(snapshotPath, "references", "z.md"), "tampered resource")
  const override = { family: "skill" as const, id: "demo", layer: "project" as const, path, catalogPath: "skills/demo/SKILL.md", status: "upstream-changed" as const, valid: true, baseDefaultHash: "0".repeat(64), currentDefaultHash: "1".repeat(64), snapshotPath, snapshotAvailable: true }
  const catalog = { files: { "skills/demo/SKILL.md": file("theirs skill", "1".repeat(64)), "skills/demo/references/a.md": file("theirs resource") } }
  const service = createDefinitionOverrideService({ catalog, baselines, load: async () => ({ overrides: [override], diagnostics: [] }) })

  const prepared = await service.prepare(path, "rebase")
  expect(prepared.source?.kind).toBe("missing-base")
  if (prepared.source?.kind !== "missing-base") throw new Error("expected missing base")
  expect(Object.keys(prepared.source.mine.kind === "skill-package" ? prepared.source.mine.files : {})).toEqual(["references/z.md", "SKILL.md"])
  expect(Object.keys(prepared.source.theirs.kind === "skill-package" ? prepared.source.theirs.files : {})).toEqual(["references/a.md", "SKILL.md"])
  expect(prepared.source.mineVersusTheirs.files.map((entry) => entry.path)).toEqual(["demo/SKILL.md", "demo/references/a.md", "demo/references/z.md"])
})

test("refuses unsafe complete package paths before loading or changing files", async () => {
  const root = temporaryDirectory("override-path-refusal-")
  const outside = join(root, "escape")
  await writeFile(outside, "safe")
  let loads = 0
  const service = createDefinitionOverrideService({
    catalog: { files: {} },
    baselines,
    load: async () => { loads += 1; return { overrides: [], diagnostics: [] } }
  })

  for (const unsafe of ["../escape", ".base/SKILL.md"]) {
    await expect(service.prepare(join(root, "demo", "SKILL.md"), "rebase", {
      kind: "skill-package",
      files: { "SKILL.md": "skill", [unsafe]: "hostile" },
    })).rejects.toThrow()
  }

  expect(loads).toBe(0)
  expect(await readFile(outside, "utf8")).toBe("safe")
})

test("refuses apply when the prepared target identity is stale", async () => {
  const root = temporaryDirectory("override-stale-target-")
  const path = join(root, "system-prompt.md")
  await writeFile(path, "mine\n")
  const override = { family: "system-prompt" as const, id: "system-prompt", layer: "project" as const, path, catalogPath: "system-prompt.md", status: "upstream-changed" as const, valid: true, baseDefaultHash: hash("base\n"), currentDefaultHash: hash("theirs\n"), snapshotPath: `${path}.base`, snapshotAvailable: false }
  const service = createDefinitionOverrideService({ catalog: { files: { "system-prompt.md": file("theirs\n") } }, baselines, load: async () => ({ overrides: [override], diagnostics: [] }) })
  const prepared = await service.prepare(path, "rebase", { kind: "single-file", content: "merged\n" })
  await writeFile(path, "changed\n")

  await expect(service.apply(prepared)).rejects.toThrow("changed after preparation")
  expect(await readFile(path, "utf8")).toBe("changed\n")
})

test("finalizes global adopt after removal and waits for refresh", async () => {
  const root = temporaryDirectory("override-global-adopt-")
  const packageDir = join(root, "demo")
  const path = join(packageDir, "SKILL.md")
  const snapshotPath = join(packageDir, ".base")
  await mkdir(snapshotPath, { recursive: true })
  await writeFile(join(snapshotPath, "SKILL.md"), "base")
  const events: string[] = []
  const service = createDefinitionOverrideService({
    catalog: { files: {} },
    baselines: { set: async () => { events.push("baseline-set") } },
    load: async () => ({ overrides: [], diagnostics: [] }),
  })
  service.subscribe(() => { events.push("refreshed") })
  const preparation = {
    preparationId: "prepared",
    action: "adopt-default" as const,
    target: { kind: "skill-package" as const, family: "skill" as const, id: "demo", path, layer: "user" as const, reach: "global" as const, overridePackageIdentity: "old", currentDefaultPackageIdentity: "new" },
  }

  await service.finalizeSkillPublication(preparation)
  events.push("success")
  expect(events).toEqual(["baseline-set", "refreshed", "success"])
  await expect(readFile(join(snapshotPath, "SKILL.md"), "utf8")).rejects.toThrow()
})

test("publishes the current snapshot before it commits the baseline and keeps clean user bytes", async () => {
  const root = temporaryDirectory("override-baseline-order-")
  const path = join(root, "system-prompt.md")
  const snapshotPath = `${path}.base`
  const oldHash = hash("old\n")
  const currentHash = hash("current\n")
  await writeFile(path, "mine\n")
  await writeFile(snapshotPath, "old\n")
  const override = { family: "system-prompt" as const, id: "system-prompt", layer: "project" as const, path, catalogPath: "system-prompt.md", status: "upstream-changed" as const, valid: true, baseDefaultHash: oldHash, currentDefaultHash: currentHash, snapshotPath, snapshotAvailable: true }
  const commits: string[] = []
  const service = createDefinitionOverrideService({
    catalog: { files: { "system-prompt.md": file("current\n") } },
    baselines: {
      set: async (_, acknowledged) => { commits.push(`${acknowledged}:${await readFile(snapshotPath, "utf8")}`) },
    },
    load: async () => ({ overrides: [override], diagnostics: [] })
  })

  await service.apply(await service.prepare(path, "keep-mine"))

  expect(await readFile(path, "utf8")).toBe("mine\n")
  expect(commits).toEqual([`${currentHash}:current\n`])
})

test("publishes keep-mine bytes verbatim, including legacy-looking installer fields", async () => {
  const root = temporaryDirectory("override-raw-bytes-")
  const path = join(root, "system-prompt.md")
  const stamped = `---\nbase_default_hash: ${hash("old\n")}\n---\nmine\n`
  await writeFile(path, stamped)
  const override = { family: "system-prompt" as const, id: "system-prompt", layer: "project" as const, path, catalogPath: "system-prompt.md", status: "upstream-changed" as const, valid: true, currentDefaultHash: hash("current\n"), snapshotPath: `${path}.base`, snapshotAvailable: false }
  const service = createDefinitionOverrideService({ catalog: { files: { "system-prompt.md": file("current\n") } }, baselines, load: async () => ({ overrides: [override], diagnostics: [] }) })

  const prepared = await service.prepare(path, "keep-mine")
  expect(prepared.proposed).toEqual({ kind: "single-file", content: stamped })
  await service.apply(prepared)

  expect(await readFile(path, "utf8")).toBe(stamped)
})

test("identifies a skill package by its unmodified SKILL.md bytes", async () => {
  const root = temporaryDirectory("override-skill-raw-bytes-")
  const packageDir = join(root, "demo")
  const path = join(packageDir, "SKILL.md")
  const stamped = `---\nbase_default_hash: ${hash("base")}\n---\nmine skill`
  await mkdir(packageDir, { recursive: true })
  await writeFile(path, stamped)
  const override = { family: "skill" as const, id: "demo", layer: "project" as const, path, catalogPath: "skills/demo/SKILL.md", status: "upstream-changed" as const, valid: true, currentDefaultHash: "1".repeat(64), snapshotPath: join(packageDir, ".base"), snapshotAvailable: false }
  const catalog = { files: { "skills/demo/SKILL.md": file("theirs skill", "1".repeat(64)) } }
  const service = createDefinitionOverrideService({ catalog, baselines, load: async () => ({ overrides: [override], diagnostics: [] }) })

  const prepared = await service.prepare(path, "rebase")
  if (prepared.source?.kind !== "missing-base") throw new Error("expected missing base")
  expect(prepared.source.mine).toEqual({ kind: "skill-package", files: { "SKILL.md": stamped } })
  expect(prepared.target.kind === "skill-package" && prepared.target.overridePackageIdentity).toBe(packageIdentity([["SKILL.md", stamped]]))
})

test("shows adopt-default as the change approval makes: the override's own lines go away", async () => {
  const root = temporaryDirectory("override-adopt-diff-")
  const path = join(root, "system-prompt.md")
  await writeFile(path, "default\nproject line\n")
  const override = { family: "system-prompt" as const, id: "system-prompt", layer: "project" as const, path, catalogPath: "system-prompt.md", status: "upstream-changed" as const, valid: true, currentDefaultHash: hash("default\n"), snapshotPath: `${path}.base`, snapshotAvailable: false }
  const service = createDefinitionOverrideService({ catalog: { files: { "system-prompt.md": file("default\n") } }, baselines, load: async () => ({ overrides: [override], diagnostics: [] }) })

  const patch = (await service.prepare(path, "adopt-default")).diff?.files[0]?.unifiedDiff ?? ""

  expect(patch).toContain("\n-project line")
  expect(patch).not.toContain("\n+project line")
  expect((await service.diff(path)).files[0]?.unifiedDiff).toContain("\n+project line")
})

test("summarizes a preparation as readable Markdown with the action, the target, and a fenced diff", async () => {
  const root = temporaryDirectory("override-summary-")
  const path = join(root, "system-prompt.md")
  await writeFile(path, "default\n```ts\nconst fenced = true\n```\n")
  const override = { family: "system-prompt" as const, id: "system-prompt", layer: "project" as const, path, catalogPath: "system-prompt.md", status: "upstream-changed" as const, valid: true, currentDefaultHash: hash("default\n"), snapshotPath: `${path}.base`, snapshotAvailable: false }
  const service = createDefinitionOverrideService({ catalog: { files: { "system-prompt.md": file("default\n") } }, baselines, load: async () => ({ overrides: [override], diagnostics: [] }) })

  const summary = (await service.prepare(path, "adopt-default")).summary ?? ""

  expect(summary.split("\n")[0]).toBe(`**Adopt the default** for the system-prompt \`system-prompt\`. Approval deletes the project override at \`${path}\`, so the bundled default applies.`)
  expect(summary).not.toContain("preparationId")
  expect(summary).not.toContain("\\n")
  expect(summary).toContain("\n````diff\n")
  expect(summary).toContain("\n-```ts\n")
  expect(summary.trimEnd().endsWith("````")).toBe(true)
})
