import { afterAll, afterEach, describe, expect, spyOn, test } from "bun:test"
import { Database } from "bun:sqlite"
import { Schema } from "effect"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { selectStartupDirectories, type StartupDirectories } from "../../../src/infra/directory-authorities.js"
import type { LauncherScope } from "../../../src/infra/process-supervisor.js"
import { createSqliteEventStore } from "../../../src/infra/sqlite-event-store.js"
import { prepareWorkspaceState } from "../../../src/orchestration/workspace-state.js"
import { testDirectories } from "../../helpers/directories.js"
import { operationsDir } from "../../../src/orchestration/modules/learning/skill-operation-manifest.js"
import { userSkillStoreDir } from "../../../src/workflows/skills.js"

const telemetry = await import("../../../src/orchestration/modules/learning/skill-load-stats.js")
const collectSkillLoadStats = telemetry.collectSkillLoadStats
const cleanupHost = await import("../../../src/orchestration/modules/learning/skill-corpus-cleanup-host.js")

/** Injected failure of the first read a command makes after it owns the state
 *  generation. */
let failLoadStats = false

const loadStatsSpy = spyOn(telemetry, "collectSkillLoadStats").mockImplementation((...args) => {
  if (failLoadStats) throw new Error("telemetry read boom")
  return collectSkillLoadStats(...args)
})

const cleanupCalls: Array<Parameters<typeof cleanupHost.runSkillCorpusCleanupForProject>[0]> = []
let cleanupResult: Awaited<ReturnType<typeof cleanupHost.runSkillCorpusCleanupForProject>> = { kind: "completed", corePackages: 0, candidates: 0, archived: [] }
const cleanupSpy = spyOn(cleanupHost, "runSkillCorpusCleanupForProject").mockImplementation((input) => {
  cleanupCalls.push(input)
  return Promise.resolve(cleanupResult)
})

const { runSkillsCleanup, runSkillsList, runSkillsPrune, runSkillsRestore, runSkillsWhy } = await import("../../../src/orchestration/modules/learning/cli/skills.js")

/** The directory authorities the CLI publishes for a command launched in `cwd`:
 *  the project root is discovered from the launch directory, never assumed to
 *  be it. */
function launchedIn(cwd: string): StartupDirectories {
  return testDirectories(selectStartupDirectories({ env: {}, cwd }).projectRoot, cwd)
}

const refusingScope: LauncherScope = {
  spawnOwned: () => Promise.reject(new Error("a unit test never launches a process")),
  adoptOwned: () => Promise.reject(new Error("a unit test never adopts a command")),
  open: () => refusingScope,
  close: () => Promise.resolve({ settled: true }),
}

const created: string[] = []

/** A project root the resolver recognizes: the `.git` marker is what makes a
 *  directory the root every subdirectory shares. */
function projectRoot(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "flywheel-skills-cli-")))
  created.push(dir)
  mkdirSync(join(dir, ".git"), { recursive: true })
  return dir
}

function installSkill(root: string, id: string): void {
  const dir = join(root, ".flywheel", "skills", id)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, "SKILL.md"), skillFile(id))
}

/** Backdate a package so the pruner's never-used clock, which anchors on the
 *  package file's own timestamp, reads it as long idle. */
function age(root: string, id: string, days: number): void {
  const file = join(root, ".flywheel", "skills", id, "SKILL.md")
  const when = new Date(Date.now() - days * 24 * 60 * 60 * 1000)
  utimesSync(file, when, when)
}

/** A package in the project archive: `skills:restore` looks for it there. */
function archiveSkill(root: string, id: string): void {
  const dir = join(root, ".flywheel", "skills", ".archive", id)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, "SKILL.md"), skillFile(id))
}

function skillFile(id: string): string {
  return `---\nname: ${id}\ndescription: Load for ${id}.\nmanaged: flywheel\n---\nBody of ${id}.\n`
}

/** One durable write fact in the workspace store the runtime writes to. */
function seedWriteFact(root: string, id: string): void {
  const prepared = prepareWorkspaceState(testDirectories(root))
  const store = createSqliteEventStore(prepared.dbFile)
  try {
    store.append({
      aggregateId: "session:s-1",
      type: "skill.written",
      version: 2,
      timestamp: 1,
      actor: "agent",
      sessionId: "s-1",
      payload: {
        name: id,
        action: "created",
        reach: "project",
        origin: { kind: "agent", sessionId: "s-1" },
        identity: { kind: "recorded", writeId: "w".repeat(36), proposalId: "a".repeat(64), packageIdentity: { sha256: "c".repeat(64), bytes: 10 } },
        contentHash: "b".repeat(64),
        description: `Load for ${id}.`,
      },
    })
  } finally {
    store.close()
    prepared.generation.release()
  }
}

/** The fields of the CLI's JSON output that these tests read. */
const WhyEvidence = Schema.Struct({ writes: Schema.Array(Schema.Struct({ reach: Schema.String })) })
const ListedSkills = Schema.Array(Schema.Struct({ name: Schema.String }))

async function whyEvidence(cwd: string, name: string): Promise<typeof WhyEvidence.Type> {
  const originalLog = console.log
  const lines: string[] = []
  console.log = (...args: unknown[]) => lines.push(args.map(String).join(" "))
  try {
    await runSkillsWhy(["--json", name], launchedIn(cwd))
  } finally {
    console.log = originalLog
  }
  return Schema.decodeUnknownSync(WhyEvidence)(JSON.parse(lines.join("\n")))
}

async function listedSkillNames(cwd: string): Promise<string[]> {
  const originalLog = console.log
  const lines: string[] = []
  console.log = (...args: unknown[]) => lines.push(args.map(String).join(" "))
  try {
    await runSkillsList(["--json"], launchedIn(cwd))
  } finally {
    console.log = originalLog
  }
  const rows = Schema.decodeUnknownSync(ListedSkills)(JSON.parse(lines.join("\n")))
  return rows.map((row) => row.name)
}

/** Shared-holder entries of one project's state generation. One left behind
 *  reads as a live owner for as long as this process runs, and blocks every
 *  later start from replacing an old generation. */
function generationHolders(root: string): string[] {
  const flywheel = join(root, ".flywheel")
  return existsSync(flywheel) ? readdirSync(flywheel).filter((entry) => entry.startsWith("project-generation.lock.shared")) : []
}

function stampEpoch(dbFile: string, epoch: number): void {
  const db = new Database(dbFile)
  try {
    db.exec(`PRAGMA user_version = ${epoch}`)
  } finally {
    db.close()
  }
}

/** Run a command that reports failure through the process exit code, and give
 *  the code back so it cannot leak into this test process's own result. Bun
 *  keeps the first nonzero code it was given, so the reset states zero. */
async function exitCodeOf(run: () => Promise<void>): Promise<number | undefined> {
  const before = process.exitCode
  try {
    await run()
    return process.exitCode === undefined ? undefined : Number(process.exitCode)
  } finally {
    process.exitCode = before ?? 0
  }
}

// The spies replace module exports that every later test file in this
// process shares, so they end with this file.
afterAll(() => {
  loadStatsSpy.mockRestore()
  cleanupSpy.mockRestore()
})

afterEach(() => {
  failLoadStats = false
  cleanupCalls.length = 0
  cleanupResult = { kind: "completed", corePackages: 0, candidates: 0, archived: [] }
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe("skills cleanup", () => {
  test("requires force before it calls the shared project host", async () => {
    const root = projectRoot()
    const originalError = console.error
    const errors: string[] = []
    console.error = (...args: unknown[]) => errors.push(args.map(String).join(" "))
    try {
      const exitCode = await exitCodeOf(() => runSkillsCleanup([], launchedIn(root), refusingScope))
      expect(exitCode).toBe(1)
    } finally {
      console.error = originalError
    }

    expect(errors.join("\n")).toContain("--force is required")
    expect(cleanupCalls).toEqual([])
  })

  test("rejects unknown flags and positional arguments", async () => {
    const root = projectRoot()
    const originalError = console.error
    console.error = () => {}
    try {
      expect(await exitCodeOf(() => runSkillsCleanup(["--force", "--bogus"], launchedIn(root), refusingScope))).toBe(1)
      expect(await exitCodeOf(() => runSkillsCleanup(["--force", "extra"], launchedIn(root), refusingScope))).toBe(1)
    } finally {
      console.error = originalError
    }

    expect(cleanupCalls).toEqual([])
  })

  test("forwards authorities and force, and reports only the human terminal outcome and counts", async () => {
    const directories = launchedIn(projectRoot())
    cleanupResult = { kind: "completed", corePackages: 2, candidates: 3, archived: ["one"] }
    const lines: string[] = []
    const originalLog = console.log
    console.log = (...args: unknown[]) => lines.push(args.map(String).join(" "))
    try {
      await runSkillsCleanup(["--force"], directories, refusingScope)
    } finally {
      console.log = originalLog
    }

    expect(cleanupCalls).toHaveLength(1)
    expect(cleanupCalls[0]).toMatchObject({ directories, launcher: refusingScope, force: true })
    expect(lines).toEqual(["Cleanup outcome: completed.", "Core packages audited: 2.", "Candidates classified: 3.", "Packages archived: 1."])
    expect(lines.join("\n")).not.toMatch(/recommend|note|notif/i)
  })

  test("reports a no-candidate completion as terminal outcome and zero counts", async () => {
    const lines: string[] = []
    const originalLog = console.log
    console.log = (...args: unknown[]) => lines.push(args.map(String).join(" "))
    try {
      await runSkillsCleanup(["--force", "--json"], launchedIn(projectRoot()), refusingScope)
    } finally {
      console.log = originalLog
    }

    expect(JSON.parse(lines.join("\n"))).toEqual({ outcome: "completed", corePackages: 0, candidates: 0, archived: 0 })
    expect(lines.join("\n")).not.toMatch(/recommend|note|notif/i)
  })

  test.each(["text", "json"])("reports failed classification with its reason and a nonzero exit in %s", async (format) => {
    cleanupResult = { kind: "campaign-deferred", reason: 'Model "missing-model" is unavailable.' }
    const lines: string[] = []
    const errors: string[] = []
    const originalLog = console.log
    const originalError = console.error
    console.log = (...args: unknown[]) => lines.push(args.map(String).join(" "))
    console.error = (...args: unknown[]) => errors.push(args.map(String).join(" "))
    try {
      expect(await exitCodeOf(() => runSkillsCleanup(["--force", ...(format === "json" ? ["--json"] : [])], launchedIn(projectRoot()), refusingScope))).toBe(1)
    } finally {
      console.log = originalLog
      console.error = originalError
    }
    if (format === "json") expect(JSON.parse(lines.join("\n"))).toEqual({ outcome: "campaign-deferred", reason: cleanupResult.reason })
    else expect(errors.join("\n")).toContain(cleanupResult.reason)
  })
})

describe("skills:list", () => {
  test("each invocation opens its own registry, so a package installed since the last one is listed", async () => {
    const root = projectRoot()

    expect(await listedSkillNames(root)).not.toContain("late-arrival")
    installSkill(root, "late-arrival")

    expect(await listedSkillNames(root)).toContain("late-arrival")
  })

  test("one project's store stays out of another project's listing", async () => {
    const one = projectRoot()
    const other = projectRoot()
    installSkill(one, "only-in-one")

    expect(await listedSkillNames(one)).toContain("only-in-one")
    expect(await listedSkillNames(other)).not.toContain("only-in-one")
  })

  test("the store is resolved from the project root, not from the directory the command runs in", async () => {
    const root = projectRoot()
    installSkill(root, "root-store-package")
    const nested = join(root, "packages", "nested")
    mkdirSync(nested, { recursive: true })

    expect(await listedSkillNames(nested)).toContain("root-store-package")
  })
})

describe("skills:why", () => {
  test("reads the workspace event store at the project root, not one under the launch directory", async () => {
    const root = projectRoot()
    seedWriteFact(root, "root-store-package")
    const nested = join(root, "packages", "nested")
    mkdirSync(nested, { recursive: true })

    const evidence = await whyEvidence(nested, "root-store-package")

    expect(evidence.writes.map((write) => write.reach)).toEqual(["project"])
    expect(existsSync(join(nested, ".flywheel", "flywheel.sqlite"))).toBe(false)
  })
})

describe("skills:restore", () => {
  test("restores into the project root's archive from a nested directory", async () => {
    const root = projectRoot()
    archiveSkill(root, "shelved")
    const nested = join(root, "packages", "nested")
    mkdirSync(nested, { recursive: true })

    await runSkillsRestore(["shelved"], launchedIn(nested))

    expect(existsSync(join(root, ".flywheel", "skills", "shelved", "SKILL.md"))).toBe(true)
    expect(existsSync(join(nested, ".flywheel", "skills"))).toBe(false)
  })
})

/** Every skills command owns this project's state generation for exactly as
 *  long as it reads the workspace store, and hands it back on every exit. */
describe("skills command state generation ownership", () => {
  test("skills:list hands the generation back", async () => {
    const root = projectRoot()
    installSkill(root, "listed")

    expect(await listedSkillNames(root)).toContain("listed")

    expect(generationHolders(root)).toEqual([])
  })

  test("skills:why hands the generation back", async () => {
    const root = projectRoot()
    seedWriteFact(root, "traced")

    expect((await whyEvidence(root, "traced")).writes).toHaveLength(1)

    expect(generationHolders(root)).toEqual([])
  })

  test("skills:restore hands the generation back", async () => {
    const root = projectRoot()
    archiveSkill(root, "shelved")

    await runSkillsRestore(["shelved"], launchedIn(root))

    expect(existsSync(join(root, ".flywheel", "skills", "shelved", "SKILL.md"))).toBe(true)
    expect(generationHolders(root)).toEqual([])
  })

  test("skills:prune hands the generation back", async () => {
    const root = projectRoot()
    installSkill(root, "unused")
    const originalLog = console.log
    console.log = () => {}
    try {
      await runSkillsPrune(["--dry-run"], launchedIn(root))
    } finally {
      console.log = originalLog
    }

    expect(generationHolders(root)).toEqual([])
  })

  test("a refusal after acquisition still hands the generation back", async () => {
    const root = projectRoot()
    const originalError = console.error
    console.error = () => {}
    let exitCode: number | undefined
    try {
      exitCode = await exitCodeOf(() => runSkillsRestore(["never-archived"], launchedIn(root)))
    } finally {
      console.error = originalError
    }

    expect(exitCode).toBe(1)
    expect(generationHolders(root)).toEqual([])
  })

  test("a read that throws after acquisition still hands the generation back", async () => {
    const root = projectRoot()
    failLoadStats = true

    await expect(runSkillsList(["--json"], launchedIn(root))).rejects.toThrow("telemetry read boom")

    expect(generationHolders(root)).toEqual([])
  })

  test("a flag rejected before acquisition owns nothing", async () => {
    const root = projectRoot()
    const originalError = console.error
    console.error = () => {}
    let exitCode: number | undefined
    try {
      exitCode = await exitCodeOf(() => runSkillsList(["--bogus"], launchedIn(root)))
    } finally {
      console.error = originalError
    }

    expect(exitCode).toBe(1)
    expect(existsSync(join(root, ".flywheel"))).toBe(false)
  })

  test("a generation another owner holds is refused, and that owner keeps it", async () => {
    const root = projectRoot()
    const owner = prepareWorkspaceState(testDirectories(root))
    try {
      stampEpoch(owner.dbFile, 1)

      await expect(runSkillsList(["--json"], launchedIn(root)))
        .rejects.toThrow("cannot be replaced while another owner holds this project's state generation")

      expect(generationHolders(root)).toHaveLength(1)
    } finally {
      owner.generation.release()
    }
  })
})

/** Managed-skill mutation from the CLI passes the same admission boundary the
 *  runtime uses, and read-only inspection passes none. */
describe("skills commands under capability policy", () => {
  /** One account data root of its own, so the selection a case states is the only
   *  one a command can read, holding one undecodable global operation record.
   *  Reconciliation quarantines that record, so its survival is the observable of
   *  a command that reconciled nothing. */
  function accountWith(root: string, features: string, extraConfig = "") {
    const home = realpathSync(mkdtempSync(join(tmpdir(), "flywheel-skills-account-")))
    created.push(home)
    const userDataRoot = join(home, ".flywheel")
    mkdirSync(userDataRoot, { recursive: true })
    writeFileSync(join(userDataRoot, "flywheel.toml"), `features = ${features}\n${extraConfig}`)
    const operations = operationsDir(userSkillStoreDir(userDataRoot))
    mkdirSync(operations, { recursive: true })
    const staleRecord = join(operations, `${"a".repeat(64)}.json`)
    writeFileSync(staleRecord, "{}\n")
    return { directories: { ...launchedIn(root), accountHome: home, userDataRoot }, staleRecord }
  }

  /** Run a command with both console streams silenced, and give back what it
   *  wrote to stderr plus the exit code it asked for. */
  async function refusalOf(run: () => Promise<void>): Promise<{ exitCode: number | undefined; stderr: string }> {
    const originalError = console.error
    const originalLog = console.log
    const lines: string[] = []
    console.error = (...args: unknown[]) => lines.push(args.map(String).join(" "))
    console.log = () => {}
    try {
      const exitCode = await exitCodeOf(run)
      return { exitCode, stderr: lines.join("\n") }
    } finally {
      console.error = originalError
      console.log = originalLog
    }
  }

  test("skills:list inspects the library while Learning is off, and reconciles nothing", async () => {
    const root = projectRoot()
    installSkill(root, "listed")
    const account = accountWith(root, '["skills"]')
    const originalLog = console.log
    const lines: string[] = []
    console.log = (...args: unknown[]) => lines.push(args.map(String).join(" "))
    try {
      await runSkillsList(["--json"], account.directories)
    } finally {
      console.log = originalLog
    }

    expect(lines.join("\n")).toContain("listed")
    expect(existsSync(account.staleRecord)).toBe(true)
  })

  test("skills:prune --dry-run reports without admission while Learning is off", async () => {
    const root = projectRoot()
    installSkill(root, "unused")
    const account = accountWith(root, '["skills"]')

    const { exitCode } = await refusalOf(() => runSkillsPrune(["--dry-run"], account.directories))

    expect(exitCode).toBe(0)
    expect(existsSync(account.staleRecord)).toBe(true)
  })

  test("skills:prune reads the configured archive window, so a zero window archives nothing", async () => {
    const root = projectRoot()
    installSkill(root, "ancient")
    age(root, "ancient", 200)
    const account = accountWith(root, '["skills", "learning"]', "[skills]\narchive_after_days = 0\n")

    const { exitCode } = await refusalOf(() => runSkillsPrune([], account.directories))

    // Unset and 0 both mean the command did not fail; only 1 is a refusal.
    expect(exitCode ?? 0).toBe(0)
    expect(existsSync(join(root, ".flywheel", "skills", "ancient", "SKILL.md"))).toBe(true)
  })

  test("skills:restore refuses before it writes a package while Learning is off", async () => {
    const root = projectRoot()
    archiveSkill(root, "shelved")
    const account = accountWith(root, '["skills"]')

    const { exitCode, stderr } = await refusalOf(() => runSkillsRestore(["shelved"], account.directories))

    expect(exitCode).toBe(1)
    expect(stderr).toContain("learning")
    expect(existsSync(join(root, ".flywheel", "skills", "shelved", "SKILL.md"))).toBe(false)
    expect(existsSync(account.staleRecord)).toBe(true)
  })

  test("skills:prune refuses before it archives anything while Skills is off", async () => {
    const root = projectRoot()
    installSkill(root, "unused")
    const account = accountWith(root, "[]")

    const { exitCode, stderr } = await refusalOf(() => runSkillsPrune([], account.directories))

    expect(exitCode).toBe(1)
    expect(stderr).toContain("skills")
    expect(existsSync(account.staleRecord)).toBe(true)
  })

  test("skills:restore restores and reconciles while Skills and Learning are enabled", async () => {
    const root = projectRoot()
    archiveSkill(root, "shelved")
    const account = accountWith(root, '["skills", "learning"]')

    await runSkillsRestore(["shelved"], account.directories)

    expect(existsSync(join(root, ".flywheel", "skills", "shelved", "SKILL.md"))).toBe(true)
    expect(existsSync(account.staleRecord)).toBe(false)
  })
})
