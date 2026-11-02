import { createHash } from "node:crypto"
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, spyOn, test } from "bun:test"

import { Log } from "../../../../src/infra/log.js"
import type { BundledDefaultCatalog } from "../../../../src/workflows/definitions/bundled-defaults.js"
import { installBundledDefaults } from "../../../../src/workflows/definitions/installer.js"
import { configurationReferenceFile } from "../../../../src/infra/paths.js"
import { workflowAssets } from "../../../../src/workflows/agents/manifest.js"
import { existsSync } from "node:fs"

const hash = (content: string): string => createHash("sha256").update(content).digest("hex")

const catalog: BundledDefaultCatalog = {
  files: {
    "system-prompt.md": { content: "System prompt\n", overlayTarget: "system-prompt.md", sourceHash: hash("System prompt\n"), baseDefaultHash: hash("System prompt\n") },
    "workflows/example.yaml": { content: "id: example\n", overlayTarget: "workflows/example.yaml", sourceHash: hash("id: example\n"), baseDefaultHash: hash("id: example\n") },
    "agents/nested/example.md": { content: "---\nname: example\n---\nBody\n", overlayTarget: "agents/nested/example.md", sourceHash: hash("---\nname: example\n---\nBody\n"), baseDefaultHash: hash("---\nname: example\n---\nBody\n") },
    "skills/example/SKILL.md": { content: "---\ndescription: Example\n---\nBody\n", overlayTarget: "skills/example/SKILL.md", sourceHash: hash("---\ndescription: Example\n---\nBody\n"), baseDefaultHash: "package-identity" },
    "skills/example/references/raw.txt": { content: "resource\n", overlayTarget: "skills/example/references/raw.txt", sourceHash: hash("resource\n"), baseDefaultHash: hash("resource\n") },
  },
}

async function tempUserDataRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), "fw-defaults-"))
}

describe("bundled defaults installer", () => {
  test("publishes clean catalog bytes and skips a current tree", async () => {
    const userDataRoot = await tempUserDataRoot()
    try {
      const first = await installBundledDefaults({ userDataRoot, binaryVersion: "1.2.3", catalog })
      const second = await installBundledDefaults({ userDataRoot, binaryVersion: "1.2.3", catalog })
      const defaults = join(userDataRoot, "defaults")
      const manifest = JSON.parse(await readFile(join(defaults, ".manifest.json"), "utf8"))

      expect(first).toEqual({ installed: 5, errors: [] })
      expect(second).toEqual({ installed: 0, errors: [] })
      expect(manifest).toEqual({
        version: 1,
        binaryVersion: "1.2.3",
        files: Object.fromEntries(Object.entries(catalog.files).map(([path, file]) => [path, file.sourceHash])),
      })
      expect(await readFile(join(defaults, "system-prompt.md"), "utf8")).toBe("System prompt\n")
      expect(await readFile(join(defaults, "agents/nested/example.md"), "utf8")).toBe("---\nname: example\n---\nBody\n")
      expect(await readFile(join(defaults, "skills/example/SKILL.md"), "utf8")).toBe("---\ndescription: Example\n---\nBody\n")
      expect(await readFile(join(defaults, "skills/example/references/raw.txt"), "utf8")).toBe("resource\n")
    } finally {
      await rm(userDataRoot, { recursive: true, force: true })
    }
  })

  test("skips publication when only the binary version changes", async () => {
    const userDataRoot = await tempUserDataRoot()
    const write = spyOn(Bun, "write")
    try {
      await installBundledDefaults({ userDataRoot, binaryVersion: "1", catalog })
      write.mockClear()
      expect(await installBundledDefaults({ userDataRoot, binaryVersion: "2", catalog })).toEqual({ installed: 0, errors: [] })
      expect(write).not.toHaveBeenCalled()
    } finally {
      write.mockRestore()
      await rm(userDataRoot, { recursive: true, force: true })
    }
  })

  test("warns for each drifted file with its overlay target", async () => {
    const userDataRoot = await tempUserDataRoot()
    const warn = spyOn(Log.create({ service: "definitions-installer" }), "warn")
    const changedCatalog: BundledDefaultCatalog = { files: { ...catalog.files, "new.txt": { content: "new\n", overlayTarget: "new.txt", sourceHash: hash("new\n"), baseDefaultHash: hash("new\n") } } }
    try {
      await installBundledDefaults({ userDataRoot, binaryVersion: "1", catalog })
      await writeFile(join(userDataRoot, "defaults", "workflows/example.yaml"), "edited\n")
      await installBundledDefaults({ userDataRoot, binaryVersion: "2", catalog: changedCatalog })
      expect(warn.mock.calls.some(([message, fields]) => message === "machine-owned default was edited; overwriting" && fields?.file === "workflows/example.yaml" && fields?.overlayTarget === "workflows/example.yaml")).toBe(true)
    } finally {
      warn.mockRestore()
      await rm(userDataRoot, { recursive: true, force: true })
    }
  })

  test("sweeps only dead attempt-owned paths", async () => {
    const userDataRoot = await tempUserDataRoot()
    const liveStage = join(userDataRoot, `defaults.tmp.${process.pid}.live`)
    const deadStage = join(userDataRoot, "defaults.tmp.2147483647.dead")
    const deadAside = join(userDataRoot, "defaults.old.2147483647.dead")
    try {
      await Promise.all([mkdir(liveStage), mkdir(deadStage), mkdir(deadAside)])
      await writeFile(join(liveStage, "owner"), "live")
      expect(await installBundledDefaults({ userDataRoot, binaryVersion: "1", catalog })).toEqual({ installed: 5, errors: [] })
      expect(await readFile(join(liveStage, "owner"), "utf8")).toBe("live")
      expect(await Bun.file(deadStage).exists()).toBe(false)
      expect(await Bun.file(deadAside).exists()).toBe(false)
    } finally {
      await rm(userDataRoot, { recursive: true, force: true })
    }
  })

  test("removes only legacy manifest-listed personas, even when defaults are current", async () => {
    const userDataRoot = await tempUserDataRoot()
    const agentsDir = join(userDataRoot, "agents")
    try {
      await installBundledDefaults({ userDataRoot, binaryVersion: "1", catalog })
      await mkdir(agentsDir, { recursive: true })
      await writeFile(join(agentsDir, ".manifest.json"), JSON.stringify({ version: 1, sourceHash: hash("legacy"), files: ["explorer.md", "implementer.md"] }))
      await writeFile(join(agentsDir, "explorer.md"), "legacy\n")
      await writeFile(join(agentsDir, "implementer.md"), "legacy\n")
      await writeFile(join(agentsDir, "mine.md"), "user override\n")
      expect(await installBundledDefaults({ userDataRoot, binaryVersion: "1", catalog })).toEqual({ installed: 0, errors: [] })
      expect(await Bun.file(join(agentsDir, "explorer.md")).exists()).toBe(false)
      expect(await Bun.file(join(agentsDir, "implementer.md")).exists()).toBe(false)
      expect(await Bun.file(join(agentsDir, ".manifest.json")).exists()).toBe(false)
      expect(await readFile(join(agentsDir, "mine.md"), "utf8")).toBe("user override\n")
    } finally {
      await rm(userDataRoot, { recursive: true, force: true })
    }
  })

  test("pre-creates the user override dirs with a README, and keeps an edited README", async () => {
    const userDataRoot = await tempUserDataRoot()
    try {
      await installBundledDefaults({ userDataRoot, binaryVersion: "1", catalog })
      for (const dir of ["agents", "skills"]) {
        expect(await readFile(join(userDataRoot, dir, "README.md"), "utf8")).toContain("Precedence, highest first:")
      }
      expect(existsSync(join(userDataRoot, "workflows"))).toBe(false)
      await writeFile(join(userDataRoot, "agents", "README.md"), "mine\n")
      await installBundledDefaults({ userDataRoot, binaryVersion: "2", catalog })
      expect(await readFile(join(userDataRoot, "agents", "README.md"), "utf8")).toBe("mine\n")
    } finally {
      await rm(userDataRoot, { recursive: true, force: true })
    }
  })

  test("publishes user guides at the root, machine-owned", async () => {
    const userDataRoot = await tempUserDataRoot()
    const guideSource = (name: string): string => join(import.meta.dir, "../../../../src/workflows/docs", name)
    try {
      await installBundledDefaults({ userDataRoot, binaryVersion: "1", catalog })
      for (const reference of ["cli.md", "commands.md", "keys.md"]) {
        expect(await readFile(join(userDataRoot, reference), "utf8")).toBe(await readFile(guideSource(reference), "utf8"))
      }
      const target = join(userDataRoot, "custom-providers.md")
      const expected = await readFile(guideSource("custom-providers.md"), "utf8")
      expect(await readFile(target, "utf8")).toBe(expected)
      await writeFile(target, "edited\n")
      await installBundledDefaults({ userDataRoot, binaryVersion: "1", catalog })
      expect(await readFile(target, "utf8")).toBe(expected)
    } finally {
      await rm(userDataRoot, { recursive: true, force: true })
    }
  })

  test("publishes the bundled configuration reference through its canonical path", async () => {
    const userDataRoot = await tempUserDataRoot()
    const bundled = "# Bundled configuration reference\n"
    workflowAssets["docs/configuration.md"] = bundled
    try {
      const target = configurationReferenceFile(userDataRoot)
      await writeFile(target, new Uint8Array([0xff, 0xfe, 0xfd]))
      await installBundledDefaults({ userDataRoot, binaryVersion: "1", catalog })
      expect(await readFile(target)).toEqual(Buffer.from(bundled))
      const published = await stat(target)
      await installBundledDefaults({ userDataRoot, binaryVersion: "1", catalog })
      expect((await stat(target)).ino).toBe(published.ino)
    } finally {
      delete workflowAssets["docs/configuration.md"]
      await rm(userDataRoot, { recursive: true, force: true })
    }
  })

  test("a failed guide write is non-fatal and leaves defaults published", async () => {
    const userDataRoot = await tempUserDataRoot()
    try {
      // A directory at the guide's target path makes the atomic rename fail.
      await mkdir(join(userDataRoot, "custom-providers.md"), { recursive: true })
      const result = await installBundledDefaults({ userDataRoot, binaryVersion: "1", catalog })
      expect(result.errors).toEqual([])
      expect(await readFile(join(userDataRoot, "defaults", "system-prompt.md"), "utf8")).toBe("System prompt\n")
    } finally {
      await rm(userDataRoot, { recursive: true, force: true })
    }
  })

  test("a damaged override path does not suppress the other override dirs", async () => {
    const userDataRoot = await tempUserDataRoot()
    try {
      await writeFile(join(userDataRoot, "agents"), "not a directory\n")
      expect((await installBundledDefaults({ userDataRoot, binaryVersion: "1", catalog })).errors).toEqual([])
      expect(await readFile(join(userDataRoot, "skills", "README.md"), "utf8")).toContain("Precedence, highest first:")
      expect(existsSync(join(userDataRoot, "workflows"))).toBe(false)
    } finally {
      await rm(userDataRoot, { recursive: true, force: true })
    }
  })

  test("replaces a fully legacy agents dir with the fresh override dir", async () => {
    const userDataRoot = await tempUserDataRoot()
    const agentsDir = join(userDataRoot, "agents")
    try {
      await mkdir(agentsDir, { recursive: true })
      await writeFile(join(agentsDir, ".manifest.json"), JSON.stringify({ version: 1, sourceHash: hash("legacy"), files: ["explorer.md"] }))
      await writeFile(join(agentsDir, "explorer.md"), "legacy\n")
      await installBundledDefaults({ userDataRoot, binaryVersion: "1", catalog })
      expect(await readdir(join(userDataRoot, "agents"))).toEqual(["README.md"])
    } finally {
      await rm(userDataRoot, { recursive: true, force: true })
    }
  })

  // These are the exact installer texts at 4e579573d9, df98df6504, and 0e90bd62ad. Remove after 2027-04-30.
  test.each(["4e579573d9", "df98df6504", "0e90bd62ad"])("removes the machine-written workflow README from %s without removing a person's files", async (commit) => {
    const userDataRoot = await tempUserDataRoot()
    const dir = join(userDataRoot, "workflows")
    const text = "# Workflow Overrides (all projects)\n\nWorkflow definitions in this directory override the bundled workflows for every project on this machine. The `id` field inside the `.yaml` file selects the workflow it replaces.\n\n"
      + (commit === "0e90bd62ad" ? "A workflow here runs a brief from the `briefs/` folder in this directory before a bundled brief of the same name. To change a bundled brief, copy it from `../defaults/workflows/briefs/` into `briefs/` and edit the copy.\n\n" : "")
      + "Precedence, highest first: `<project>/.flywheel/workflows/`, this directory, the bundled defaults.\n\nThe bundled definitions are published for reference under `../defaults/`. That tree is machine-owned: do not edit it, it is overwritten on upgrade. Copy a file from it into an override directory and edit the copy.\n"
    try {
      await mkdir(dir)
      await writeFile(join(dir, "README.md"), text)
      await installBundledDefaults({ userDataRoot, binaryVersion: "1", catalog })
      expect(existsSync(dir)).toBe(false)
      await mkdir(dir)
      const bytes = new Uint8Array([0xff, 0x00, 0x61])
      await writeFile(join(dir, "mine.yaml"), bytes)
      await writeFile(join(dir, "README.md"), text)
      await installBundledDefaults({ userDataRoot, binaryVersion: "1", catalog })
      expect(await readFile(join(dir, "mine.yaml"))).toEqual(Buffer.from(bytes))
      expect(existsSync(join(dir, "README.md"))).toBe(false)
      await writeFile(join(dir, "README.md"), `${text}My notes.\n`)
      await installBundledDefaults({ userDataRoot, binaryVersion: "1", catalog })
      expect(await readFile(join(dir, "README.md"), "utf8")).toBe(`${text}My notes.\n`)
    } finally {
      await rm(userDataRoot, { recursive: true, force: true })
    }
  })

  test("never deletes from a manifest that does not match the legacy shape exactly", async () => {
    const userDataRoot = await tempUserDataRoot()
    const agentsDir = join(userDataRoot, "agents")
    const rejected = [
      { version: 1, sourceHash: hash("x"), files: ["mine.md"], owner: "another-tool" },
      { version: 1, sourceHash: "not-a-sha", files: ["mine.md"] },
      { version: 2, sourceHash: hash("x"), files: ["mine.md"] },
      { version: 1, sourceHash: hash("x"), files: ["/etc/passwd.md"] },
      { version: 1, sourceHash: hash("x"), files: ["../escape.md"] },
      { version: 1, sourceHash: hash("x"), files: ["..\\escape.md"] },
      { version: 1, sourceHash: hash("x"), files: ["mine.txt"] },
    ]
    try {
      for (const manifest of rejected) {
        await mkdir(agentsDir, { recursive: true })
        await writeFile(join(agentsDir, ".manifest.json"), JSON.stringify(manifest))
        await writeFile(join(agentsDir, "mine.md"), "user override\n")
        await installBundledDefaults({ userDataRoot, binaryVersion: "1", catalog })
        expect(await readFile(join(agentsDir, "mine.md"), "utf8")).toBe("user override\n")
        expect(await Bun.file(join(agentsDir, ".manifest.json")).exists()).toBe(true)
        await rm(agentsDir, { recursive: true, force: true })
      }
    } finally {
      await rm(userDataRoot, { recursive: true, force: true })
    }
  })

  test("keeps the published tree and top-level overlays when staging fails", async () => {
    const userDataRoot = await tempUserDataRoot()
    const originalWrite = Bun.write
    const write = spyOn(Bun, "write")
    try {
      await installBundledDefaults({ userDataRoot, binaryVersion: "1", catalog })
      await mkdir(join(userDataRoot, "skills"), { recursive: true })
      await writeFile(join(userDataRoot, "skills", "overlay.md"), "overlay\n")
      const changedCatalog: BundledDefaultCatalog = { files: { ...catalog.files, "new.txt": { content: "new\n", overlayTarget: "new.txt", sourceHash: hash("new\n"), baseDefaultHash: hash("new\n") } } }
      write.mockImplementation((destination, data) => {
        if (typeof destination !== "string" || typeof data !== "string") throw new Error("the installer writes text to a path")
        if (destination.endsWith(".manifest.json")) throw new Error("staged manifest write failed")
        return originalWrite(destination, data)
      })
      const result = await installBundledDefaults({ userDataRoot, binaryVersion: "2", catalog: changedCatalog })
      expect(result.errors).toEqual(["staged manifest write failed"])
      expect(JSON.parse(await readFile(join(userDataRoot, "defaults", ".manifest.json"), "utf8")).files).not.toHaveProperty("new.txt")
      expect(await readFile(join(userDataRoot, "skills", "overlay.md"), "utf8")).toBe("overlay\n")
    } finally {
      write.mockRestore()
      await rm(userDataRoot, { recursive: true, force: true })
    }
  })

  test("publishes complete competing trees through fresh attempt-owned stages", async () => {
    const userDataRoot = await tempUserDataRoot()
    const originalWrite = Bun.write
    const write = spyOn(Bun, "write")
    const alternateContent = "Alternate prompt\n"
    const alternate: BundledDefaultCatalog = { files: { ...catalog.files, "system-prompt.md": { content: alternateContent, overlayTarget: "system-prompt.md", sourceHash: hash(alternateContent), baseDefaultHash: hash(alternateContent) } } }
    let arrivals = 0
    let releaseBarrier = (): void => {}
    const barrier = new Promise<void>((resolve) => { releaseBarrier = resolve })
    const stagePaths = new Set<string>()
    try {
      write.mockImplementation(async (path, data) => {
        if (typeof path !== "string" || typeof data !== "string") throw new Error("the installer writes text to a path")
        if (path.includes("defaults.tmp.") && path.endsWith(".manifest.json")) {
          stagePaths.add(path.slice(0, -"/.manifest.json".length))
          for (const file of Object.keys(catalog.files)) expect(await Bun.file(join(path, "..", file)).exists()).toBe(true)
          arrivals++
          if (arrivals === 2) releaseBarrier()
          if (arrivals <= 2) await barrier
        }
        return originalWrite(path, data)
      })
      const results = await Promise.all([
        installBundledDefaults({ userDataRoot, binaryVersion: "a", catalog }),
        installBundledDefaults({ userDataRoot, binaryVersion: "b", catalog: alternate }),
      ])
      expect(results.every((result) => result.errors.length === 0)).toBe(true)
      // Two stages when one publication ends before the other starts, as a
      // slow Windows host can order it; a third when they overlap and the
      // loser restages through a fresh attempt. Both orders are correct.
      expect(stagePaths.size).toBeGreaterThanOrEqual(2)
      const manifest = JSON.parse(await readFile(join(userDataRoot, "defaults", ".manifest.json"), "utf8"))
      const winnerContent = manifest.files["system-prompt.md"] === hash(alternateContent) ? alternateContent : "System prompt\n"
      expect(await readFile(join(userDataRoot, "defaults", "system-prompt.md"), "utf8")).toContain(winnerContent)
      expect((await readdir(userDataRoot)).filter((name) => name.startsWith("defaults.tmp.") || name.startsWith("defaults.old."))).toEqual([])
    } finally {
      write.mockRestore()
      await rm(userDataRoot, { recursive: true, force: true })
    }
  })
})
