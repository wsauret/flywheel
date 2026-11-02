import { describe, expect, spyOn, test } from "bun:test"
import { join } from "node:path"
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, unlinkSync, writeFileSync } from "node:fs"

import { comparisonPlan, publishedDriverPath, resolvePublishedDriver, suiteLaunch, watchAccountTask, type StateQuery } from "../../../scripts/perf-gate.js"
import { RELEASE_HARNESS_ENVIRONMENT } from "../../helpers/real-process-fixture.js"
import { temporaryDirectories } from "../../helpers/directories.js"
import { activatePlacedBuild, copyActiveBuild } from "../../helpers/placed-build.js"
import { activeBuildDir } from "../../../src/infra/update/active-build.js"
import { createHash } from "node:crypto"
import { readRevisionDriver, runRevisionDriver } from "../../release/lib/revision-driver.js"
import { parseReleaseArgs } from "../../release/run.js"
import { createTimeline } from "../../release/lib/timeline.js"

const temporary = temporaryDirectories()

describe("perf gate suite launch", () => {
  test("runs only the published comparison unless a pinned driver is supplied", () => {
    expect(comparisonPlan().comparisons).toEqual(["published"])
    expect(comparisonPlan().driver).toBeUndefined()
  })

  test("resolves the published driver override before the per-tag cache", () => {
    const cache = join("/cache", "baselines", "v0.0.12-darwin-arm64")
    expect(publishedDriverPath(cache, "/explicit/driver.json")).toBe("/explicit/driver.json")
    expect(publishedDriverPath(cache)).toBe(join(cache, "driver", "published-driver.json"))
  })

  test("reuses only a valid published driver and rematerializes a stale cache", () => {
    const cache = temporary("perf-published-driver-")
    const manifestPath = publishedDriverPath(cache)
    const archivePath = join(cache, "archive")
    const entrypoint = join(cache, "driver", "published-driver.js")
    const dependency = join(cache, "driver", "dependency.js")
    mkdirSync(join(cache, "driver"))
    writeFileSync(archivePath, "archive")
    const hash = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex")
    let setups = 0
    const setup = (tag: string, directory: string) => {
      expect(directory).toBe(cache)
      setups++
      writeFileSync(entrypoint, "driver")
      writeFileSync(dependency, "dependency")
      writeFileSync(manifestPath, JSON.stringify({
        sourceRevision: "published-revision", sourceRoot: join(cache, "driver"), releaseTag: tag,
        entrypoint, driverSha256: hash(entrypoint), archivePath, archiveSha256: hash(archivePath),
        files: [{ path: dependency, sha256: hash(dependency) }],
      }))
    }
    const previousOverride = process.env.FLYWHEEL_RELEASE_PUBLISHED_DRIVER
    delete process.env.FLYWHEEL_RELEASE_PUBLISHED_DRIVER
    try {
      expect(resolvePublishedDriver("v0.0.12", cache, setup)).toBe(manifestPath)
      expect(setups).toBe(1)
      expect(resolvePublishedDriver("v0.0.12", cache, setup)).toBe(manifestPath)
      expect(setups).toBe(1)
      const legacySource = temporary("perf-published-source-")
      const legacyDependency = join(legacySource, "dependency.ts")
      const legacyEntrypoint = join(cache, "driver", "published-driver.ts")
      writeFileSync(legacyDependency, "export const value = 1")
      writeFileSync(legacyEntrypoint, `import { value } from ${JSON.stringify(legacyDependency)}`)
      writeFileSync(manifestPath, JSON.stringify({
        sourceRevision: "published-revision", sourceRoot: legacySource, releaseTag: "v0.0.12",
        entrypoint: legacyEntrypoint, driverSha256: hash(legacyEntrypoint), archivePath, archiveSha256: hash(archivePath),
        files: [{ path: legacyDependency, sha256: hash(legacyDependency) }],
      }))
      expect(readRevisionDriver(manifestPath, "v0.0.12").entrypoint).toBe(legacyEntrypoint)
      expect(resolvePublishedDriver("v0.0.12", cache, setup)).toBe(manifestPath)
      expect(setups).toBe(2)
      for (const invalidate of [
        () => unlinkSync(dependency),
        () => writeFileSync(dependency, "changed"),
        () => writeFileSync(manifestPath, "{}"),
      ]) {
        invalidate()
        expect(resolvePublishedDriver("v0.0.12", cache, setup)).toBe(manifestPath)
        expect(readRevisionDriver(manifestPath, "v0.0.12").entrypoint).toBe(entrypoint)
      }
      expect(setups).toBe(5)
      process.env.FLYWHEEL_RELEASE_PUBLISHED_DRIVER = "/explicit/driver.json"
      expect(resolvePublishedDriver("v0.0.12", cache, setup)).toBe("/explicit/driver.json")
      expect(setups).toBe(5)
    } finally {
      if (previousOverride === undefined) delete process.env.FLYWHEEL_RELEASE_PUBLISHED_DRIVER
      else process.env.FLYWHEEL_RELEASE_PUBLISHED_DRIVER = previousOverride
    }
  })

  test("rejects ambiguous baseline routing and infers a single scenario's comparison before setup", () => {
    const args = ["--binary", "/candidate", "--binary-home", "/candidate-home", "--out", "/evidence"]
    for (const set of ["startup", "release"]) {
      expect(() => parseReleaseArgs([...args, "--set", set])).toThrow("one comparison family")
      expect(() => parseReleaseArgs([...args, "--set", set, "--comparison", "all"])).toThrow("one comparison family")
      for (const comparison of ["published", "workflow"] as const) {
        expect(parseReleaseArgs([...args, "--set", set, "--comparison", comparison]).comparison).toBe(comparison)
      }
    }
    for (const only of ["startup-empty", "runner-reconciliation", "account-service"]) {
      expect(parseReleaseArgs([...args, "--only", only]).comparison).toBe("published")
    }
    for (const only of ["workflow-agent-upgrade", "parallel-workflow-agents", "parallel-children"]) {
      expect(parseReleaseArgs([...args, "--only", only]).comparison).toBe("workflow")
    }
    expect(() => parseReleaseArgs([...args, "--only", "workflow-agent-upgrade", "--comparison", "published"])).toThrow("not in")
    expect(() => parseReleaseArgs([...args, "--only", "runner-reconciliation", "--comparison", "workflow"])).toThrow("not in")
  })

  test("the suite runner carries the release harness marker and names its run, so the gate's sweeps match it", () => {
    const root = join("/cache", "flywheel", "perf-gate", "run-abc")

    const candidate = { binary: join(root, "candidate-bin", "flywheel"), home: join(root, "independent-home") }
    const baseline = { binary: join(root, "baseline-bin", "flywheel"), home: join(root, "published-home") }
    const operatorProfile = process.env.FLYWHEEL_AUTH_PROFILE
    process.env.FLYWHEEL_AUTH_PROFILE = "operator-profile"
    let launch: ReturnType<typeof suiteLaunch>
    try {
      launch = suiteLaunch({ candidate, baseline, set: "startup", evidence: join(root, "perf-evidence"), work: join(root, "w") })
    } finally {
      if (operatorProfile === undefined) delete process.env.FLYWHEEL_AUTH_PROFILE
      else process.env.FLYWHEEL_AUTH_PROFILE = operatorProfile
    }

    expect(launch.env.FLYWHEEL_INTERNAL_RELEASE_HARNESS).toBe(RELEASE_HARNESS_ENVIRONMENT.FLYWHEEL_INTERNAL_RELEASE_HARNESS)
    expect(launch.env).not.toHaveProperty("FLYWHEEL_AUTH_PROFILE")
    expect(launch.command.some((argument) => argument.includes(root))).toBe(true)
    expect(launch.command).toEqual(["bun", "run", "tests/release/run.ts", "--binary", candidate.binary, "--binary-home", candidate.home, "--baseline", baseline.binary, "--baseline-home", baseline.home, "--set", "startup", "--out", join(root, "perf-evidence"), "--work", join(root, "w")])
    expect(suiteLaunch({ candidate, baseline: undefined, set: "startup", evidence: root, work: root }).command).not.toContain("--baseline-home")
  })

  test("isolated homes receive the complete selected payload and activation, but no account state", () => {
    const source = temporary("perf-source-")
    const first = temporary("perf-first-")
    const second = temporary("perf-second-")
    const build = { version: "0.0.11", buildId: "a".repeat(64) }
    const root = join(source, ".flywheel")
    const payload = join(root, "versions", build.version, build.buildId)
    mkdirSync(join(payload, "native", "nested"), { recursive: true })
    writeFileSync(join(payload, "build.json"), JSON.stringify({ ...build, asset: "flywheel-win32-x64.tar.gz" }))
    writeFileSync(join(payload, "payload"), "actual payload bytes")
    writeFileSync(join(payload, "native", "nested", "tokenizer"), "native asset bytes")
    writeFileSync(join(root, "auth.json"), "must not copy")
    activatePlacedBuild(root, build)
    for (const home of [first, second]) {
      copyActiveBuild(source, home, false)
      const copied = join(home, ".flywheel", "versions", build.version, build.buildId)
      expect(activeBuildDir(join(home, ".flywheel"))).toBe(realpathSync(copied))
      expect(readFileSync(join(copied, "payload"), "utf8")).toBe("actual payload bytes")
      expect(readFileSync(join(copied, "native", "nested", "tokenizer"), "utf8")).toBe("native asset bytes")
      expect(readdirSync(join(home, ".flywheel")).sort()).toEqual(["current", "versions"])
    }
    writeFileSync(join(first, ".flywheel", "versions", build.version, build.buildId, "payload"), "changed")
    expect(readFileSync(join(second, ".flywheel", "versions", build.version, build.buildId, "payload"), "utf8")).toBe("actual payload bytes")
    expect(readFileSync(join(payload, "payload"), "utf8")).toBe("actual payload bytes")
  })

  test("pins each workflow suite to a verified archive and revision-matched driver", () => {
    const root = temporary("perf-driver-")
    const archivePath = join(root, "archive")
    const entrypoint = join(root, "driver")
    const dependency = join(root, "dependency")
    for (const file of [archivePath, entrypoint, dependency]) writeFileSync(file, file)
    const hash = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex")
    const manifest = {
      sourceRevision: "01612ddbd517c1dc76eea1797ad1f07f06a5ef99", sourceRoot: root,
      archivePath, entrypoint, archiveSha256: hash(archivePath), driverSha256: hash(entrypoint),
      files: [{ path: dependency, sha256: hash(dependency) }],
    }
    const path = join(root, "manifest.json")
    expect(() => comparisonPlan(path)).toThrow()
    writeFileSync(path, "{}")
    expect(() => comparisonPlan(path)).toThrow()
    writeFileSync(path, JSON.stringify(manifest))
    expect(readRevisionDriver(path).archivePath).toBe(archivePath)
    expect(comparisonPlan(path).comparisons).toEqual(["published", "workflow"])
    expect(comparisonPlan(path).driver?.archivePath).toBe(archivePath)
    writeFileSync(path, JSON.stringify({ ...manifest, sourceRevision: "9a4b264de790cc309908c957dba1e8057ef00fbb", releaseTag: "v0.0.12" }))
    expect(readRevisionDriver(path, "v0.0.12").releaseTag).toBe("v0.0.12")
    expect(() => readRevisionDriver(path, "v0.0.13")).toThrow("release tag")
    expect(() => readRevisionDriver(path)).toThrow("pinned")
    writeFileSync(path, JSON.stringify({ ...manifest, sourceRevision: "wrong" }))
    expect(() => readRevisionDriver(path)).toThrow("pinned")
    writeFileSync(path, JSON.stringify(manifest))
    writeFileSync(archivePath, "different")
    expect(() => readRevisionDriver(path)).toThrow("archive hash")
    expect(() => comparisonPlan(path)).toThrow("archive hash")
    unlinkSync(archivePath)
    expect(() => comparisonPlan(path)).toThrow()
    writeFileSync(archivePath, archivePath)
    writeFileSync(dependency, "different")
    expect(() => readRevisionDriver(path)).toThrow("dependency changed")
    const launch = suiteLaunch({ candidate: { binary: "/candidate", home: "/candidate-home" }, baseline: { binary: "/pinned", home: "/pinned-home" }, set: "release", evidence: root, work: root, comparison: "workflow" })
    expect(launch.command.slice(-2)).toEqual(["--comparison", "workflow"])
    expect(launch.command).toContain("/pinned")
  })

  test.skipIf(process.platform === "win32")("keeps pinned drivers' private sockets short with a long work root and removes them after the run", async () => {
    const root = temporary("perf-driver-environment-")
    const work = join(root, "long-work-root-".repeat(10))
    mkdirSync(work)
    const archivePath = join(root, "archive")
    const entrypoint = join(root, "driver")
    writeFileSync(archivePath, "archive")
    writeFileSync(entrypoint, "driver")
    const manifestPath = join(root, "manifest.json")
    writeFileSync(manifestPath, JSON.stringify({
      sourceRevision: "01612ddbd517c1dc76eea1797ad1f07f06a5ef99", sourceRoot: root, archivePath, entrypoint,
      archiveSha256: createHash("sha256").update("archive").digest("hex"),
      driverSha256: createHash("sha256").update("driver").digest("hex"), files: [],
    }))
    const previousManifest = process.env.FLYWHEEL_RELEASE_BASELINE_DRIVER
    process.env.FLYWHEEL_RELEASE_BASELINE_DRIVER = manifestPath
    const socketDirectories: string[] = []
    const stopped = new Error("stop before launching the pinned driver")
    const spawn = spyOn(Bun, "spawn")
    spawn.mockImplementation(() => {
      const directory = spawn.mock.calls.at(-1)?.[1]?.env?.TMUX_TMPDIR
      expect(directory).toBeString()
      socketDirectories.push(directory!)
      expect(existsSync(directory!)).toBe(true)
      const socket = join(directory!, `tmux-${process.getuid!()}`, "default")
      expect(Buffer.byteLength(socket)).toBeLessThan(104)
      throw stopped
    })
    try {
      const context = {
        measurementRole: "baseline" as const, binaryPath: "/installed/flywheel", workDir: work,
        evidenceDir: root, tmuxServer: join(work, "tmux"), sessionName: "pinned-driver",
        environment: {}, timeline: createTimeline(),
      }
      for (let run = 0; run < 2; run++) {
        await expect(runRevisionDriver(context, "parallel-sessions")).rejects.toBe(stopped)
      }
      expect(socketDirectories[0]).not.toBe(socketDirectories[1])
      for (const directory of socketDirectories) expect(existsSync(directory)).toBe(false)
    } finally {
      spawn.mockRestore()
      if (previousManifest === undefined) delete process.env.FLYWHEEL_RELEASE_BASELINE_DRIVER
      else process.env.FLYWHEEL_RELEASE_BASELINE_DRIVER = previousManifest
    }
  })

  test("only an absent activation qualifies for the self-contained legacy baseline", () => {
    const source = temporary("perf-legacy-")
    const target = temporary("perf-legacy-target-")
    copyActiveBuild(source, target, true)
    expect(existsSync(join(target, ".flywheel"))).toBe(false)
    expect(() => copyActiveBuild(source, target, false)).toThrow("No active immutable build")
    const root = join(source, ".flywheel")
    mkdirSync(root)
    activatePlacedBuild(root, { version: "0.0.11", buildId: "b".repeat(64) })
    expect(() => copyActiveBuild(source, target, true)).toThrow()
    unlinkSync(join(root, "current"))
    writeFileSync(join(root, "current"), "not a build pointer")
    expect(() => copyActiveBuild(source, target, true)).toThrow()
  })
})

/** A Windows machine as the gate's state queries see it: the account task's
 *  XML (nothing when Task Scheduler holds no task). It records every command
 *  asked. */
type WindowsMachineState = { task: string | undefined; taskListed?: boolean }

function windowsMachine(state: WindowsMachineState) {
  const asked: string[][] = []
  const query: StateQuery = (command) => {
    asked.push([...command])
    const [program, ...args] = command
    if (program === "schtasks" && args.includes("/XML")) return state.task === undefined ? { exitCode: 1, stdout: "" } : { exitCode: 0, stdout: state.task }
    if (program === "schtasks" && args.includes("CSV")) return { exitCode: 0, stdout: state.taskListed ? '"\\Flywheel Serve","N/A","Running"\r\n' : '"\\Other Task","N/A","Ready"\r\n' }
    throw new Error(`unexpected command ${command.join(" ")}`)
  }
  return { query, asked }
}

const taskXml = (command: string) => `<?xml version="1.0" encoding="UTF-16"?>\r\n<Task><Actions Context="Author"><Exec><Command>${command}</Command><Arguments>serve --scheduled-task</Arguments></Exec></Actions></Task>\r\n`
const realLauncher = String.raw`C:\Users\operator\.flywheel\bin\flywheel-serve.exe`
const gateLauncher = String.raw`C:\Users\operator\.cache\flywheel\perf-gate\baselines\v0.0.12-win32-x64\baseline-bin\flywheel-serve.exe`

describe("perf gate Windows account task guard", () => {
  test("passes when the account task is unchanged after the run", () => {
    const machine = windowsMachine({ task: taskXml(realLauncher) })
    const changed = watchAccountTask("win32", machine.query)
    expect(changed()).toBeUndefined()
  })

  test("fails a run that changed the account task and names both commands and the repair", () => {
    const state: WindowsMachineState = { task: taskXml(realLauncher) }
    const machine = windowsMachine(state)
    const changed = watchAccountTask("win32", machine.query)
    state.task = taskXml(gateLauncher)
    const message = changed()
    expect(message).toContain(realLauncher)
    expect(message).toContain(gateLauncher)
    expect(message).toContain("flywheel serve install")
  })

  test("a task the run created is repaired by deleting it, and no task before and after passes", () => {
    const state: WindowsMachineState = { task: undefined }
    const machine = windowsMachine(state)
    const changed = watchAccountTask("win32", machine.query)
    expect(changed()).toBeUndefined()
    state.task = taskXml(gateLauncher)
    const message = changed()
    expect(message).toContain(gateLauncher)
    expect(message).toContain('schtasks /Delete /F /TN "Flywheel Serve"')
  })

  test("refuses to start when the account task exists but its definition cannot be read", () => {
    const machine = windowsMachine({ task: undefined, taskListed: true })
    expect(() => watchAccountTask("win32", machine.query)).toThrow("Flywheel Serve")
  })

  test("runs no Windows check on another platform", () => {
    const machine = windowsMachine({ task: undefined })
    for (const platform of ["darwin", "linux"] as const) {
      expect(watchAccountTask(platform, machine.query)()).toBeUndefined()
    }
    expect(machine.asked).toEqual([])
  })
})
