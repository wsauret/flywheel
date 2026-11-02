/** Adoption of the quarantine targets an older release completed.
 *
 *  A release before this one preserved every retired generation for ever. Those
 *  archives are adopted and dropped, but only the ones whose contents prove what
 *  they are: anything else is a user's own bytes and stays where it is. */

import { afterEach, describe, expect, it } from "bun:test"
import * as fs from "node:fs"
import * as path from "node:path"
import { resolveSessionsDir } from "../../../src/infra/paths.js"
import { prepareWorkspaceState } from "../../../src/orchestration/workspace-state.js"
import {
  observeRetirementCheckpoints,
  WORKSPACE_STATE_EPOCH,
  type RetirementCheckpoint,
} from "../../../src/orchestration/workspace-state-retirement.js"
import {
  cleanupRetirementWorkspaces,
  flywheelDir,
  makeWorkspace,
  makeWorkspaceFixture,
  manifestPath,
  prepareAndRelease,
  stageCompletedQuarantine,
  stampEpoch,
  stateEntries,
  validManifest,
  writeManifest,
  writeUnder,
} from "../../helpers/workspace-retirement.js"

afterEach(() => {
  observeRetirementCheckpoints(undefined)
  cleanupRetirementWorkspaces()
})

describe("a quarantine an older release completed", () => {
  it("is deleted when it holds nothing but a database of a retired epoch", () => {
    const directories = makeWorkspace()
    const target = stageCompletedQuarantine(directories.projectRoot, { epoch: 1 })

    prepareAndRelease(directories)

    expect(fs.existsSync(target)).toBe(false)
    expect(stateEntries(directories.projectRoot)).toEqual(["flywheel.sqlite"])
  })

  it("is deleted whole when its manifest accounts for its sidecars and its session tree", () => {
    const directories = makeWorkspace()
    const target = stageCompletedQuarantine(directories.projectRoot, {
      epoch: 1,
      existing: ["flywheel.sqlite", "flywheel.sqlite-wal", "flywheel.sqlite-shm", "sessions"],
    })

    prepareAndRelease(directories)

    expect(fs.existsSync(target)).toBe(false)
    expect(stateEntries(directories.projectRoot)).toEqual(["flywheel.sqlite"])
  })

  it("is adopted into an operation manifest before the first of its entries is unlinked", () => {
    const directories = makeWorkspace()
    const seen: RetirementCheckpoint[] = []
    stageCompletedQuarantine(directories.projectRoot, { epoch: 1 })
    observeRetirementCheckpoints((checkpoint) => seen.push(checkpoint))

    prepareAndRelease(directories)

    expect(seen).toEqual([
      "legacy-adopted",
      "member-discarded:flywheel.sqlite",
      "member-discarded:quarantine.json",
      "phase-recorded:discarded",
    ])
  })

  it("is finished from its operation manifest when a start died inside the deletion", () => {
    const { directories, baseDir } = makeWorkspaceFixture()
    const target = stageCompletedQuarantine(baseDir, { epoch: 1 })
    observeRetirementCheckpoints((checkpoint) => {
      if (checkpoint === "member-discarded:flywheel.sqlite") throw new Error("a start died inside the deletion")
    })

    expect(() => prepareWorkspaceState(directories)).toThrow("a start died inside the deletion")

    observeRetirementCheckpoints(undefined)
    expect(fs.existsSync(path.join(target, "flywheel.sqlite"))).toBe(false)
    // The proof outlives the entries it licensed: the legacy manifest is still
    // there, and this release's own manifest is the last thing to go.
    expect(fs.existsSync(path.join(target, "quarantine.json"))).toBe(true)
    expect(fs.existsSync(path.join(flywheelDir(baseDir), "retiring", "retirement.json"))).toBe(true)

    const migrationPhases: string[] = []
    prepareWorkspaceState(directories, (reached) => migrationPhases.push(reached.step)).generation.release()

    expect(migrationPhases.length).toBeGreaterThan(0)
    expect(fs.existsSync(target)).toBe(false)
    expect(fs.existsSync(path.join(flywheelDir(baseDir), "retiring", "retirement.json"))).toBe(false)
    expect(fs.existsSync(path.join(flywheelDir(baseDir), "flywheel.sqlite"))).toBe(true)
  })

  it("discards the sidecars the epoch probe recovered beside the database it licensed", () => {
    const directories = makeWorkspace()
    const target = stageCompletedQuarantine(directories.projectRoot, { epoch: 1 })
    // A write-capable epoch probe of a database missing its sidecars makes
    // SQLite recreate them (see readUserVersion). The probe runs at adoption,
    // so the residue appears after the target was proven to hold nothing else.
    observeRetirementCheckpoints((checkpoint) => {
      if (checkpoint !== "legacy-adopted") return
      fs.writeFileSync(path.join(target, "flywheel.sqlite-wal"), "")
      fs.writeFileSync(path.join(target, "flywheel.sqlite-shm"), "recovered shm bytes")
    })

    prepareAndRelease(directories)

    expect(fs.existsSync(target)).toBe(false)
    expect(stateEntries(directories.projectRoot)).toEqual(["flywheel.sqlite"])
  })

  it("is finished from a published manifest when a start died on probe-recovered sidecars", () => {
    // The wedge a released binary produced: every manifested member is gone,
    // the probe's recreated sidecars remain, and the published manifest replays
    // the discard on every start.
    const { directories, baseDir } = makeWorkspaceFixture()
    fs.mkdirSync(flywheelDir(baseDir), { recursive: true })
    stampEpoch(path.join(flywheelDir(baseDir), "flywheel.sqlite"), WORKSPACE_STATE_EPOCH)
    const name = crypto.randomUUID()
    const target = path.join(flywheelDir(baseDir), "quarantine", "workspace-state", name)
    fs.mkdirSync(target, { recursive: true })
    fs.writeFileSync(path.join(target, "flywheel.sqlite-wal"), "")
    fs.writeFileSync(path.join(target, "flywheel.sqlite-shm"), "recovered shm bytes")
    writeManifest(baseDir, validManifest({
      phase: "discarding",
      location: { kind: "legacy", name },
      members: ["flywheel.sqlite", "flywheel.sqlite-wal.preserved", "flywheel.sqlite-shm.preserved", "sessions", "quarantine.json"],
    }))

    prepareAndRelease(directories)

    expect(fs.existsSync(target)).toBe(false)
    expect(fs.existsSync(manifestPath(baseDir))).toBe(false)
  })

  it("still refuses to discard a target holding an entry no probe can have written", () => {
    const directories = makeWorkspace()
    const target = stageCompletedQuarantine(directories.projectRoot, { epoch: 1 })
    observeRetirementCheckpoints((checkpoint) => {
      if (checkpoint === "legacy-adopted") fs.writeFileSync(path.join(target, "notes.txt"), "a user's bytes")
    })

    expect(() => prepareWorkspaceState(directories)).toThrow("refuses to discard a target holding notes.txt")

    expect(fs.readFileSync(path.join(target, "notes.txt"), "utf8")).toBe("a user's bytes")
  })

  it("is kept when it holds a session tree", () => {
    const directories = makeWorkspace()
    const target = stageCompletedQuarantine(directories.projectRoot, { epoch: 1 })
    writeUnder(path.join(target, "sessions", "old-session"), "notes.txt", "keep")

    prepareAndRelease(directories)

    expect(fs.readFileSync(path.join(target, "sessions", "old-session", "notes.txt"), "utf8")).toBe("keep")
  })

  it("is kept when a detached write-ahead log leaves its generation unproven", () => {
    const directories = makeWorkspace()
    const target = stageCompletedQuarantine(directories.projectRoot, { epoch: 1 })
    fs.writeFileSync(path.join(target, "flywheel.sqlite-wal.preserved"), "unmerged facts")

    prepareAndRelease(directories)

    expect(fs.readFileSync(path.join(target, "flywheel.sqlite-wal.preserved"), "utf8")).toBe("unmerged facts")
  })

  it("is kept when its manifest declares a write-ahead log the target does not hold", () => {
    const directories = makeWorkspace()
    const target = stageCompletedQuarantine(directories.projectRoot, {
      epoch: 1,
      existing: ["flywheel.sqlite", "flywheel.sqlite-wal"],
      present: ["flywheel.sqlite"],
    })

    prepareAndRelease(directories)

    expect(fs.existsSync(path.join(target, "flywheel.sqlite"))).toBe(true)
  })

  it("is kept when its manifest names a target other than the one holding it", () => {
    const directories = makeWorkspace()
    const target = stageCompletedQuarantine(directories.projectRoot, { epoch: 1, id: "a-target-that-is-not-this-one" })

    prepareAndRelease(directories)

    expect(fs.existsSync(path.join(target, "flywheel.sqlite"))).toBe(true)
  })

  it("is kept when its manifest declares one member twice", () => {
    const directories = makeWorkspace()
    const target = stageCompletedQuarantine(directories.projectRoot, {
      epoch: 1,
      declared: ["flywheel.sqlite", "flywheel.sqlite", "sessions"],
    })

    prepareAndRelease(directories)

    expect(fs.existsSync(path.join(target, "flywheel.sqlite"))).toBe(true)
  })

  it("is kept when its database is the current epoch, which this release does not retire", () => {
    const directories = makeWorkspace()
    const target = stageCompletedQuarantine(directories.projectRoot, { epoch: WORKSPACE_STATE_EPOCH })

    prepareAndRelease(directories)

    expect(fs.existsSync(path.join(target, "flywheel.sqlite"))).toBe(true)
  })

  it("is kept when its database is an epoch newer than this release knows", () => {
    const directories = makeWorkspace()
    const target = stageCompletedQuarantine(directories.projectRoot, { epoch: WORKSPACE_STATE_EPOCH + 5 })

    prepareAndRelease(directories)

    expect(fs.existsSync(path.join(target, "flywheel.sqlite"))).toBe(true)
  })

  it("is kept when its database will not open", () => {
    const directories = makeWorkspace()
    const target = stageCompletedQuarantine(directories.projectRoot, { epoch: 1 })
    fs.writeFileSync(path.join(target, "flywheel.sqlite"), "not a sqlite database")

    prepareAndRelease(directories)

    expect(fs.readFileSync(path.join(target, "flywheel.sqlite"), "utf8")).toBe("not a sqlite database")
  })

  it("is kept when it was never finalized", () => {
    const directories = makeWorkspace()
    const target = stageCompletedQuarantine(directories.projectRoot, { epoch: 1, finalized: false })

    prepareAndRelease(directories)

    expect(fs.existsSync(path.join(target, "flywheel.sqlite"))).toBe(true)
  })

  it("is kept while the live generation is one this release refuses", () => {
    const directories = makeWorkspace()
    const target = stageCompletedQuarantine(directories.projectRoot, { epoch: 1 })
    writeUnder(path.join(resolveSessionsDir(directories.projectRoot), "stale-session"), "blocks.json", "[]")

    expect(() => prepareWorkspaceState(directories)).toThrow("orphaned workspace members")

    expect(fs.existsSync(path.join(target, "flywheel.sqlite"))).toBe(true)
  })

  it("is kept when its manifest declares no member at all", () => {
    const directories = makeWorkspace()
    const target = stageCompletedQuarantine(directories.projectRoot, { epoch: 1, declared: [], existing: [] })

    prepareAndRelease(directories)

    expect(fs.existsSync(path.join(target, "flywheel.sqlite"))).toBe(true)
  })

  it("is kept when its manifest does not declare the database it holds", () => {
    const directories = makeWorkspace()
    const target = stageCompletedQuarantine(directories.projectRoot, {
      epoch: 1,
      declared: ["flywheel.sqlite-wal", "flywheel.sqlite-shm", "sessions", "agent-outputs"],
      existing: [],
    })

    prepareAndRelease(directories)

    expect(fs.existsSync(path.join(target, "flywheel.sqlite"))).toBe(true)
  })

  it("is kept when its manifest omits a sidecar of the vocabulary that release wrote", () => {
    const directories = makeWorkspace()
    const target = stageCompletedQuarantine(directories.projectRoot, {
      epoch: 1,
      declared: ["flywheel.sqlite", "flywheel.sqlite-shm", "sessions"],
    })

    prepareAndRelease(directories)

    expect(fs.existsSync(path.join(target, "flywheel.sqlite"))).toBe(true)
  })

  it("is kept when its manifest declares the database it holds as one it never moved", () => {
    const directories = makeWorkspace()
    const target = stageCompletedQuarantine(directories.projectRoot, { epoch: 1, moved: [] })

    prepareAndRelease(directories)

    expect(fs.existsSync(path.join(target, "flywheel.sqlite"))).toBe(true)
  })

  it("is kept when its manifest declares a session tree it does not hold", () => {
    const directories = makeWorkspace()
    const target = stageCompletedQuarantine(directories.projectRoot, {
      epoch: 1,
      existing: ["flywheel.sqlite", "sessions"],
      present: ["flywheel.sqlite"],
    })

    prepareAndRelease(directories)

    expect(fs.existsSync(path.join(target, "flywheel.sqlite"))).toBe(true)
  })

  it("is kept when it holds an entry its manifest accounts for nowhere", () => {
    const directories = makeWorkspace()
    const target = stageCompletedQuarantine(directories.projectRoot, { epoch: 1 })
    fs.writeFileSync(path.join(target, "notes.txt"), "someone else's file")

    prepareAndRelease(directories)

    expect(fs.readFileSync(path.join(target, "notes.txt"), "utf8")).toBe("someone else's file")
    expect(fs.existsSync(path.join(target, "flywheel.sqlite"))).toBe(true)
  })

  it("is kept when its manifest is not the shape that release wrote", () => {
    const directories = makeWorkspace()
    const target = stageCompletedQuarantine(directories.projectRoot, { epoch: 1 })
    fs.writeFileSync(path.join(target, "quarantine.json"), "{\"version\":1,")

    prepareAndRelease(directories)

    expect(fs.existsSync(path.join(target, "flywheel.sqlite"))).toBe(true)
  })
})
