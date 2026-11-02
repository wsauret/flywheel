import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { prepareProjectDefaults } from "../../../src/cli/project-preparation.js"
import { canonicalTestDirectory } from "../../helpers/directories.js"

test("interactive preparation removes legacy overrides before deferring reference publication", async () => {
  const root = await mkdtemp(join(tmpdir(), "flywheel-deferred-defaults-"))
  const userDataRoot = join(root, ".flywheel")
  const agents = join(userDataRoot, "agents")
  await mkdir(agents, { recursive: true })
  await writeFile(join(agents, ".manifest.json"), JSON.stringify({ version: 1, sourceHash: createHash("sha256").update("legacy").digest("hex"), files: ["legacy.md"] }))
  await writeFile(join(agents, "legacy.md"), "Retired machine persona")
  await writeFile(join(agents, "mine.md"), "User override")
  try {
    const projectRoot = canonicalTestDirectory(root)
    await prepareProjectDefaults({ projectRoot, executionCwd: projectRoot, accountHome: root, userDataRoot }, { publishReferences: false })
    expect(await Bun.file(join(agents, "legacy.md")).exists()).toBe(false)
    expect(await readFile(join(agents, "mine.md"), "utf8")).toBe("User override")
    expect(await Bun.file(join(userDataRoot, "flywheel.toml")).exists()).toBe(true)
    expect(await Bun.file(join(userDataRoot, "defaults", ".manifest.json")).exists()).toBe(false)
    expect(await Bun.file(join(userDataRoot, "custom-providers.md")).exists()).toBe(false)
    expect(await Bun.file(join(agents, "README.md")).exists()).toBe(false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

