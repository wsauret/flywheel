import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runMemoryShow } from "../../../src/orchestration/modules/learning/cli/memory.js"
import type { ProjectDirectories } from "../../../src/infra/directory-authorities.js"
import {
  applyMemoryOperation,
  createMemoryStoreConfig,
  memoryStorePath,
} from "../../../src/orchestration/modules/learning/memory-store.js"

const created: string[] = []

function projectDirectories(): ProjectDirectories {
  const projectRoot = realpathSync(mkdtempSync(join(tmpdir(), "flywheel-memory-show-")))
  const accountHome = join(projectRoot, "account")
  created.push(projectRoot)
  mkdirSync(join(projectRoot, ".git"), { recursive: true })
  mkdirSync(accountHome)
  return {
    projectRoot,
    accountHome,
    userDataRoot: join(accountHome, ".flywheel"),
  }
}

function configFor(directories: ProjectDirectories) {
  return createMemoryStoreConfig(directories.projectRoot, directories.accountHome)
}

interface CliOutput {
  readonly log: readonly string[]
  readonly error: readonly string[]
}

async function captureCli(run: () => void | Promise<void>): Promise<CliOutput> {
  const originalLog = console.log
  const originalError = console.error
  const log: string[] = []
  const error: string[] = []
  console.log = (...args: unknown[]) => log.push(args.map(String).join(" "))
  console.error = (...args: unknown[]) => error.push(args.map(String).join(" "))
  process.exitCode = 0
  try {
    await run()
  } finally {
    console.log = originalLog
    console.error = originalError
  }
  return { log, error }
}

interface JsonObject {
  readonly [key: string]: unknown
}

function isRecord(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function jsonStores(output: CliOutput): readonly JsonObject[] {
  const parsed: unknown = JSON.parse(output.log.join("\n"))
  if (!Array.isArray(parsed) || !parsed.every(isRecord)) throw new Error("expected memory store array")
  return parsed
}

afterEach(() => {
  process.exitCode = 0
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe("memory CLI", () => {
  test("shows text and JSON metadata through the public command", async () => {
    const directories = projectDirectories()
    const config = configFor(directories)
    const path = memoryStorePath(config, "project")
    mkdirSync(join(directories.projectRoot, ".flywheel", "memory"), { recursive: true })
    writeFileSync(path, JSON.stringify({ version: 1, entries: [{ content: "Uses Bun.", protected: true }] }))

    const text = await captureCli(() => runMemoryShow([], directories))
    expect(text.log.join("\n")).toContain("Project memory (MEMORY.json)")
    expect(text.log.join("\n")).toContain("[protected] Uses Bun.")
    expect(text.log.join("\n")).toContain("/2,500 chars")

    const stores = jsonStores(await captureCli(() => runMemoryShow(["--json"], directories)))
    const project = stores.find((store) => store.target === "project")
    expect(project).toEqual(expect.objectContaining({
      path: memoryStorePath(config, "project"),
      limit: 2_500,
      usage: expect.stringContaining("/2,500 chars"),
    }))
    expect(project?.entries).toEqual([{
      protected: true,
      content: "Uses Bun.",
    }])
  })

  test("keeps one project's memory out of another project's output", async () => {
    const directories = projectDirectories()
    const config = configFor(directories)
    await applyMemoryOperation(config, "project", { action: "add", content: "Project entry." })
    const other = projectDirectories()

    const stores = jsonStores(await captureCli(() => runMemoryShow(["--json"], other)))
    const project = stores.find((store) => store.target === "project")
    expect(project?.entries).toEqual([])
  })
})
