import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { selectStartupDirectories } from "../../../src/infra/directory-authorities.js"
import { Log } from "../../../src/infra/log.js"
import { resolveEventStoreDbFile } from "../../../src/infra/paths.js"
import { runMaintain } from "../../../src/cli/event-maintain.js"
import { ContainedDirectory } from "../../../src/infra/descriptor-directory.js"
import { registerSharedHolderIn, releaseSharedHolderIn } from "../../../src/infra/ownership-file-lock.js"
import { createSqliteEventStore } from "../../../src/infra/sqlite-event-store.js"

const created: string[] = []

function repository(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "flywheel-maintain-")))
  created.push(dir)
  mkdirSync(join(dir, ".git"), { recursive: true })
  return dir
}

/** The store path the command reports it looked for. No store exists in these
 *  temp projects, so the missing-store line is the report. */
async function reportedStorePath(projectRoot: string): Promise<string> {
  const originalError = console.error
  const lines: string[] = []
  console.error = (...values: unknown[]) => lines.push(values.map(String).join(" "))
  try {
    await runMaintain(["--stats"], projectRoot)
  } finally {
    console.error = originalError
    process.exitCode = 0
  }
  const missing = lines.find((line) => line.startsWith("No Flywheel SQLite event store found at "))
  if (!missing) throw new Error(`expected a missing-store report, got: ${lines.join(" | ")}`)
  return missing.slice("No Flywheel SQLite event store found at ".length)
}

afterEach(async () => {
  // runMaintain initializes the global log inside the project it was given;
  // release it before the temp project is removed.
  await Log.closeGlobal()
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe("flywheel maintain project directory", () => {
  test("maintains the store at the injected project root without rediscovering one", async () => {
    const root = repository()
    const nested = join(root, "packages", "cli")
    mkdirSync(nested, { recursive: true })

    expect(await reportedStorePath(nested)).toBe(resolveEventStoreDbFile(nested))
  })

  test("the selected root reaches the command canonicalized", async () => {
    const root = repository()
    const real = join(root, "workspace")
    const link = join(root, "workspace-link")
    mkdirSync(real)
    symlinkSync(real, link)
    const { projectRoot } = selectStartupDirectories({ env: { FLYWHEEL_PROJECT_ROOT: link }, cwd: root })

    expect(await reportedStorePath(projectRoot)).toBe(resolveEventStoreDbFile(real))
  })

  test("the command accepts no project directory argument of its own", async () => {
    const root = repository()
    const originalError = console.error
    const lines: string[] = []
    console.error = (...values: unknown[]) => lines.push(values.map(String).join(" "))
    try {
      await runMaintain(["--base-dir", root], root)
    } finally {
      console.error = originalError
      process.exitCode = 0
    }

    expect(lines[0]).toBe("Unknown option: --base-dir")
  })
})

describe("flywheel maintain and a live runtime", () => {
  async function runCapturing(argv: string[], projectRoot: string): Promise<{ errors: string[]; exitCode: number }> {
    const originalError = console.error
    const originalLog = console.log
    const errors: string[] = []
    console.error = (...values: unknown[]) => errors.push(values.map(String).join(" "))
    console.log = () => {}
    try {
      await runMaintain(argv, projectRoot)
      return { errors, exitCode: Number(process.exitCode ?? 0) }
    } finally {
      console.error = originalError
      console.log = originalLog
      process.exitCode = 0
    }
  }

  interface HeldProject {
    readonly root: string
    readonly release: () => void
  }

  function storeWithRuntimeHold(): HeldProject {
    const root = repository()
    const store = createSqliteEventStore(resolveEventStoreDbFile(root))
    store.close()
    // The shared hold a running project's runtime keeps on its generation.
    const flywheel = ContainedDirectory.openExisting(root, [".flywheel"])
    if (!flywheel) throw new Error("expected the .flywheel directory")
    const hold = registerSharedHolderIn(flywheel, "project-generation.lock")
    return { root, release: () => { releaseSharedHolderIn(flywheel, hold); flywheel.close() } }
  }

  test("a write refuses while another process holds the project", async () => {
    // Deleting rows under a live runtime left its search and summary indexes
    // past facts that no longer exist, for good.
    const { root, release } = storeWithRuntimeHold()
    try {
      const { errors, exitCode } = await runCapturing(["--vacuum", "--force"], root)
      expect(exitCode).toBe(1)
      expect(errors[0]).toContain("has this project open")
    } finally {
      release()
    }
  })

  test("a read-only report still runs while the project is open", async () => {
    const { root, release } = storeWithRuntimeHold()
    try {
      const { errors, exitCode } = await runCapturing(["--stats"], root)
      expect(exitCode).toBe(0)
      expect(errors).toEqual([])
    } finally {
      release()
    }
  })

  test("a write runs once the project is closed", async () => {
    const { root, release } = storeWithRuntimeHold()
    release()
    const { errors, exitCode } = await runCapturing(["--vacuum", "--force"], root)
    expect(errors).toEqual([])
    expect(exitCode).toBe(0)
  })
})
