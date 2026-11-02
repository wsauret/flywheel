/** The contract of the retirement operation itself.
 *
 *  Retirement is the one thing in Flywheel that deletes a user's own bytes, so
 *  the licence to delete is narrow and every part of it is proven here: the
 *  epoch table that declares which generations may go, the manifest that owns a
 *  half-finished operation, the staging directory that may hold nothing else,
 *  and the adoption an older release's quarantine goes through before its first
 *  entry is unlinked. Every refusal below must also leave the project exactly as
 *  it found it.
 *
 *  The sequence itself, killed at each of its durable checkpoints in a real
 *  process, is proven in tests/integration/workspace-state-concurrency. */

import { afterEach, describe, expect, it } from "bun:test"
import * as fs from "node:fs"
import * as path from "node:path"
import { resolveEventStoreDbFile, resolveSessionsDir } from "../../../src/infra/paths.js"
import { prepareWorkspaceState } from "../../../src/orchestration/workspace-state.js"
import { EPOCH_DISPOSITIONS, WORKSPACE_STATE_EPOCH } from "../../../src/orchestration/workspace-state-retirement.js"
import {
  cleanupRetirementWorkspaces,
  expectStagedDatabase,
  flywheelDir,
  makeWorkspace,
  makeWorkspaceFixture,
  pendingManifestPath,
  prepareAndRelease,
  readEpoch,
  readManifest,
  readPendingManifest,
  stagedMember,
  stageTarget,
  stampEpoch,
  stateEntries,
  validManifest,
  WORKSPACE_DATABASE_MEMBERS,
  writeManifest,
  writePendingManifest,
  writeUnder,
  type JsonObject,
} from "../../helpers/workspace-retirement.js"

afterEach(() => {
  cleanupRetirementWorkspaces()
})

describe("the epoch transition table", () => {
  it("declares an explicit disposition for the current epoch and every epoch below it", () => {
    const declared = [...EPOCH_DISPOSITIONS.keys()].toSorted((left, right) => left - right)

    // Epoch 0 is the absence of a stamp, so the table starts at 1. A raised
    // current epoch whose predecessor edge was not declared fails here rather
    // than at a user's project.
    expect(declared).toEqual(Array.from({ length: WORKSPACE_STATE_EPOCH }, (_unused, index) => index + 1))
    for (const retired of declared.filter((epoch) => epoch !== WORKSPACE_STATE_EPOCH)) {
      expect(EPOCH_DISPOSITIONS.get(retired)).toEqual({ transition: "retire", cleanup: "delete" })
    }
    expect(EPOCH_DISPOSITIONS.get(WORKSPACE_STATE_EPOCH)).toEqual({ transition: "current", cleanup: "keep" })
  })
})

describe("the workspace database generation", () => {
  it("retires every derived database and its sidecars with the source", () => {
    const { directories, baseDir } = makeWorkspaceFixture()
    stampEpoch(resolveEventStoreDbFile(baseDir), 1)
    for (const name of WORKSPACE_DATABASE_MEMBERS.slice(3)) {
      fs.writeFileSync(path.join(flywheelDir(baseDir), name), `old ${name}`)
    }

    prepareAndRelease(directories)

    expect(stateEntries(baseDir)).toEqual(["flywheel.sqlite"])
    expect(readEpoch(resolveEventStoreDbFile(baseDir))).toBe(WORKSPACE_STATE_EPOCH)
  })
})

describe("a staging directory", () => {
  it("refuses one no operation manifest owns, and deletes none of what it holds", () => {
    const { directories, baseDir } = makeWorkspaceFixture()
    writeUnder(path.join(flywheelDir(baseDir), "retiring", "unowned"), "flywheel.sqlite", "someone else's bytes")

    expect(() => prepareWorkspaceState(directories)).toThrow("refuses a staging directory no operation owns: unowned")

    expect(fs.readFileSync(path.join(flywheelDir(baseDir), "retiring", "unowned", "flywheel.sqlite"), "utf8"))
      .toBe("someone else's bytes")
    expect(fs.existsSync(resolveEventStoreDbFile(baseDir))).toBe(false)
  })

  it("refuses one holding an entry its manifest does not name", () => {
    const { directories, baseDir } = makeWorkspaceFixture()
    writeManifest(baseDir, validManifest())
    writeUnder(path.join(flywheelDir(baseDir), "retiring", "someone-elses-target"), "notes.txt", "keep")

    expect(() => prepareWorkspaceState(directories)).toThrow("holding someone-elses-target, which no operation owns")

    expect(fs.existsSync(path.join(flywheelDir(baseDir), "retiring", "someone-elses-target", "notes.txt"))).toBe(true)
    expect(fs.existsSync(resolveEventStoreDbFile(baseDir))).toBe(false)
  })

  it("fails closed on an unmanifested derived SQLite sidecar", () => {
    const { directories, baseDir } = makeWorkspaceFixture()
    writeManifest(baseDir, validManifest())
    stageTarget(baseDir, ["flywheel.sqlite"])
    fs.writeFileSync(stagedMember(baseDir, "session-summary.sqlite-wal"), "unowned derived bytes")

    expect(() => prepareWorkspaceState(directories)).toThrow(
      "workspace retirement refuses to discard a target holding session-summary.sqlite-wal",
    )

    expect(fs.readFileSync(stagedMember(baseDir, "session-summary.sqlite-wal"), "utf8")).toBe("unowned derived bytes")
  })

  it("sweeps one a finished operation left empty", () => {
    const { directories, baseDir } = makeWorkspaceFixture()
    fs.mkdirSync(path.join(flywheelDir(baseDir), "retiring"), { recursive: true })

    prepareAndRelease(directories)

    expect(fs.existsSync(path.join(flywheelDir(baseDir), "retiring"))).toBe(false)
  })

  it("refuses a derived database without its generation event store", () => {
    const { directories, baseDir } = makeWorkspaceFixture()
    fs.mkdirSync(flywheelDir(baseDir), { recursive: true })
    fs.writeFileSync(path.join(flywheelDir(baseDir), "session-summary.sqlite"), "derived bytes")

    expect(() => prepareWorkspaceState(directories)).toThrow(
      "orphaned workspace members without an event store: session-summary.sqlite",
    )

    expect(fs.readFileSync(path.join(flywheelDir(baseDir), "session-summary.sqlite"), "utf8")).toBe("derived bytes")
    expect(fs.existsSync(resolveEventStoreDbFile(baseDir))).toBe(false)
  })
})

/** A manifest whose shape this release's schema does not describe at all. */
const UNDECODABLE_MANIFESTS: readonly { readonly what: string; readonly manifest: JsonObject }[] = [
  { what: "an unknown version", manifest: validManifest({ version: 2 }) },
  { what: "an unknown phase", manifest: validManifest({ phase: "quarantining" }) },
  { what: "a location of no known kind", manifest: validManifest({ location: { kind: "archive" } }) },
]

/** A manifest this release can read and still refuses to act on. A manifest is a
 *  licence to delete, so every invariant its writer always holds is a condition
 *  of acting on it. */
const UNCONTRACTED_MANIFESTS: readonly { readonly what: string; readonly manifest: JsonObject }[] = [
  { what: "an undeclared source epoch", manifest: validManifest({ sourceEpoch: 0 }) },
  { what: "a source epoch this release does not retire", manifest: validManifest({ sourceEpoch: WORKSPACE_STATE_EPOCH }) },
  { what: "the target epoch of another release", manifest: validManifest({ targetEpoch: WORKSPACE_STATE_EPOCH + 1 }) },
  { what: "an operation id that escapes the staging directory", manifest: validManifest({ id: ".." }) },
  { what: "an operation id holding a path separator", manifest: validManifest({ id: "nested/target" }) },
  { what: "a duplicated generation member", manifest: validManifest({ members: ["flywheel.sqlite", "flywheel.sqlite"] }) },
  { what: "no event store member", manifest: validManifest({ members: ["sessions"] }) },
  { what: "no members at all", manifest: validManifest({ members: [] }) },
  { what: "a member of no generation", manifest: validManifest({ members: ["flywheel.sqlite", "auth.json"] }) },
  {
    what: "an adopted legacy target that has not reached deletion",
    manifest: validManifest({ location: { kind: "legacy", name: "old" }, members: ["flywheel.sqlite", "quarantine.json"] }),
  },
  {
    what: "an adopted legacy target that escapes the legacy directory",
    manifest: validManifest({
      location: { kind: "legacy", name: ".." },
      phase: "discarding",
      members: ["flywheel.sqlite", "quarantine.json"],
    }),
  },
]

const CONTRACT_REFUSAL = "workspace retirement manifest violates its writer contract"

describe("a retirement manifest", () => {
  for (const rejected of UNDECODABLE_MANIFESTS) {
    it(`refuses ${rejected.what}, and mutates nothing`, () => {
      const baseDir = expectRefusedManifest(rejected.manifest)

      expect(readManifest(baseDir)).toEqual(rejected.manifest)
    })
  }

  for (const rejected of UNCONTRACTED_MANIFESTS) {
    it(`refuses ${rejected.what}, and mutates nothing`, () => {
      const baseDir = expectRefusedManifest(rejected.manifest, CONTRACT_REFUSAL)

      expect(readManifest(baseDir)).toEqual(rejected.manifest)
    })
  }
})

/** Stage `manifest` in a fresh workspace, prove the start refuses it, and prove
 *  the refusal created no replacement. Returns the project root so the case can
 *  add what else it wants left alone. */
function expectRefusedManifest(manifest: JsonObject, refusal?: string): string {
  const directories = makeWorkspace()
  const baseDir = directories.projectRoot
  writeManifest(baseDir, manifest)

  if (refusal === undefined) expect(() => prepareWorkspaceState(directories)).toThrow()
  else expect(() => prepareWorkspaceState(directories)).toThrow(refusal)

  expect(fs.existsSync(resolveEventStoreDbFile(baseDir))).toBe(false)
  return baseDir
}

describe("a resumed retirement", () => {
  it("refuses a member that is in the held directory and the staging target at once", () => {
    const { directories, baseDir } = makeWorkspaceFixture()
    writeManifest(baseDir, validManifest({ phase: "staged" }))
    stageTarget(baseDir, ["flywheel.sqlite"])
    fs.writeFileSync(resolveEventStoreDbFile(baseDir), "live bytes")

    expect(() => prepareWorkspaceState(directories)).toThrow("cannot prove the location of flywheel.sqlite")

    expect(fs.readFileSync(resolveEventStoreDbFile(baseDir), "utf8")).toBe("live bytes")
    expectStagedDatabase(baseDir, 1)
  })

  it("discards a staged sidecar the epoch probe recovered beside the database it licensed", () => {
    const { directories, baseDir } = makeWorkspaceFixture()
    writeManifest(baseDir, validManifest({ phase: "discarding" }))
    stageTarget(baseDir, ["flywheel.sqlite"])
    // The staged epoch proof opens the database write-capable when a readonly
    // open fails (see readUserVersion), and that recovery recreates a sidecar
    // the manifest never inventoried.
    fs.writeFileSync(stagedMember(baseDir, "flywheel.sqlite-wal"), "")
    stampEpoch(resolveEventStoreDbFile(baseDir), WORKSPACE_STATE_EPOCH)

    prepareAndRelease(directories)

    expect(stateEntries(baseDir)).toEqual(["flywheel.sqlite"])
    expect(fs.existsSync(pendingManifestPath(baseDir))).toBe(false)
  })

  it("refuses a member that is in neither place", () => {
    const { directories, baseDir } = makeWorkspaceFixture()
    writeManifest(baseDir, validManifest({ phase: "staged" }))
    stageTarget(baseDir, [])

    expect(() => prepareWorkspaceState(directories)).toThrow("cannot prove the location of flywheel.sqlite")

    expect(fs.existsSync(resolveEventStoreDbFile(baseDir))).toBe(false)
  })

  it("refuses a replacement database that appeared before the stamp began", () => {
    const { directories, baseDir } = makeWorkspaceFixture()
    writeManifest(baseDir, validManifest({ phase: "staged" }))
    stageTarget(baseDir, ["flywheel.sqlite"])
    fs.writeFileSync(path.join(flywheelDir(baseDir), "retiring-operation-1.sqlite"), "not this operation's")

    expect(() => prepareWorkspaceState(directories)).toThrow("found a replacement database it had not begun to stamp")

    expect(fs.readFileSync(path.join(flywheelDir(baseDir), "retiring-operation-1.sqlite"), "utf8"))
      .toBe("not this operation's")
    expectStagedDatabase(baseDir, 1)
  })

  it("refuses to discard the staged generation while the replacement it published is gone", () => {
    const { directories, baseDir } = makeWorkspaceFixture()
    writeManifest(baseDir, validManifest({ phase: "discarding" }))
    stageTarget(baseDir, ["flywheel.sqlite"])

    expect(() => prepareWorkspaceState(directories))
      .toThrow("cannot discard the generation it staged without the replacement it published")

    expectStagedDatabase(baseDir, 1)
    expect(readManifest(baseDir)).toEqual(validManifest({ phase: "discarding" }))
  })

  it("refuses to finish a discard whose replacement is gone, even once every member is deleted", () => {
    const { directories, baseDir } = makeWorkspaceFixture()
    writeManifest(baseDir, validManifest({ phase: "discarded" }))
    stageTarget(baseDir, ["flywheel.sqlite"])

    expect(() => prepareWorkspaceState(directories))
      .toThrow("cannot discard the generation it staged without the replacement it published")

    expectStagedDatabase(baseDir, 1)
    expect(readManifest(baseDir)).toEqual(validManifest({ phase: "discarded" }))
  })

  it("preserves a discarded manifest when its operation target becomes nonempty", () => {
    const { directories, baseDir } = makeWorkspaceFixture()
    const manifest = validManifest({ phase: "discarded" })
    writeManifest(baseDir, manifest)
    stageTarget(baseDir, [])
    fs.writeFileSync(stagedMember(baseDir, "unexpected.txt"), "unowned bytes")
    stampEpoch(resolveEventStoreDbFile(baseDir), WORKSPACE_STATE_EPOCH)

    expect(() => prepareWorkspaceState(directories)).toThrow("target that is no longer empty")

    expect(fs.readFileSync(stagedMember(baseDir, "unexpected.txt"), "utf8")).toBe("unowned bytes")
    expect(readManifest(baseDir)).toEqual(manifest)
  })

  it("refuses a staged member that reappeared beside the published replacement", () => {
    const { directories, baseDir } = makeWorkspaceFixture()
    const manifest = validManifest({ phase: "discarding", members: ["flywheel.sqlite", "sessions"] })
    writeManifest(baseDir, manifest)
    stageTarget(baseDir, ["flywheel.sqlite", "sessions"])
    stampEpoch(resolveEventStoreDbFile(baseDir), WORKSPACE_STATE_EPOCH)
    writeUnder(path.join(resolveSessionsDir(baseDir), "reappeared"), "owner.pid", "1")

    expect(() => prepareWorkspaceState(directories)).toThrow("cannot prove the location of sessions")

    expect(fs.readFileSync(stagedMember(baseDir, "sessions"), "utf8")).toBe("staged bytes")
    expect(fs.readFileSync(path.join(resolveSessionsDir(baseDir), "reappeared", "owner.pid"), "utf8")).toBe("1")
    expect(readManifest(baseDir)).toEqual(manifest)
  })

  it("refuses a staged member that reappeared after every member was deleted", () => {
    const { directories, baseDir } = makeWorkspaceFixture()
    const manifest = validManifest({ phase: "discarded", members: ["flywheel.sqlite", "agent-outputs"] })
    writeManifest(baseDir, manifest)
    stageTarget(baseDir, ["flywheel.sqlite"])
    stampEpoch(resolveEventStoreDbFile(baseDir), WORKSPACE_STATE_EPOCH)
    writeUnder(path.join(flywheelDir(baseDir), "agent-outputs", "reappeared"), "read_1.txt", "crumb")

    expect(() => prepareWorkspaceState(directories)).toThrow("cannot prove the location of agent-outputs")

    expectStagedDatabase(baseDir, 1)
    expect(fs.readFileSync(path.join(flywheelDir(baseDir), "agent-outputs", "reappeared", "read_1.txt"), "utf8")).toBe("crumb")
    expect(readManifest(baseDir)).toEqual(manifest)
  })

  it("refuses to stage a live generation that no longer carries the epoch its manifest owns", () => {
    const { directories, baseDir } = makeWorkspaceFixture()
    writeManifest(baseDir, validManifest())
    stampEpoch(resolveEventStoreDbFile(baseDir), WORKSPACE_STATE_EPOCH)

    expect(() => prepareWorkspaceState(directories))
      .toThrow(`found the live generation stamped epoch ${WORKSPACE_STATE_EPOCH}, not the epoch 1`)

    expect(readEpoch(resolveEventStoreDbFile(baseDir))).toBe(WORKSPACE_STATE_EPOCH)
    expect(readManifest(baseDir)).toEqual(validManifest())
  })

  it("refuses to stage a live generation of an epoch newer than this release knows", () => {
    const { directories, baseDir } = makeWorkspaceFixture()
    writeManifest(baseDir, validManifest())
    stampEpoch(resolveEventStoreDbFile(baseDir), WORKSPACE_STATE_EPOCH + 5)

    expect(() => prepareWorkspaceState(directories))
      .toThrow(`found the live generation stamped epoch ${WORKSPACE_STATE_EPOCH + 5}, not the epoch 1`)

    expect(readEpoch(resolveEventStoreDbFile(baseDir))).toBe(WORKSPACE_STATE_EPOCH + 5)
  })

  it("refuses to stage a live generation whose database will not open", () => {
    const { directories, baseDir } = makeWorkspaceFixture()
    writeManifest(baseDir, validManifest())
    fs.mkdirSync(flywheelDir(baseDir), { recursive: true })
    fs.writeFileSync(resolveEventStoreDbFile(baseDir), "not a sqlite database")

    expect(() => prepareWorkspaceState(directories)).toThrow("cannot read the epoch of the live generation")

    expect(fs.readFileSync(resolveEventStoreDbFile(baseDir), "utf8")).toBe("not a sqlite database")
  })

  it("refuses to discard a staged generation that no longer carries the epoch its manifest owns", () => {
    const { directories, baseDir } = makeWorkspaceFixture()
    writeManifest(baseDir, validManifest({ phase: "discarding" }))
    stageTarget(baseDir, ["flywheel.sqlite"], WORKSPACE_STATE_EPOCH)
    stampEpoch(resolveEventStoreDbFile(baseDir), WORKSPACE_STATE_EPOCH)

    expect(() => prepareWorkspaceState(directories))
      .toThrow(`found the staged generation stamped epoch ${WORKSPACE_STATE_EPOCH}, not the epoch 1`)

    expectStagedDatabase(baseDir, WORKSPACE_STATE_EPOCH)
    expect(readManifest(baseDir)).toEqual(validManifest({ phase: "discarding" }))
  })

  it("refuses to discard a staged generation of an epoch newer than this release knows", () => {
    const { directories, baseDir } = makeWorkspaceFixture()
    writeManifest(baseDir, validManifest({ phase: "discarding" }))
    stageTarget(baseDir, ["flywheel.sqlite"], WORKSPACE_STATE_EPOCH + 5)
    stampEpoch(resolveEventStoreDbFile(baseDir), WORKSPACE_STATE_EPOCH)

    expect(() => prepareWorkspaceState(directories))
      .toThrow(`found the staged generation stamped epoch ${WORKSPACE_STATE_EPOCH + 5}, not the epoch 1`)

    expectStagedDatabase(baseDir, WORKSPACE_STATE_EPOCH + 5)
  })

  it("refuses to discard a staged generation whose database will not open", () => {
    const { directories, baseDir } = makeWorkspaceFixture()
    writeManifest(baseDir, validManifest({ phase: "discarding" }))
    stageTarget(baseDir, [])
    fs.writeFileSync(stagedMember(baseDir, "flywheel.sqlite"), "not a sqlite database")
    stampEpoch(resolveEventStoreDbFile(baseDir), WORKSPACE_STATE_EPOCH)

    expect(() => prepareWorkspaceState(directories)).toThrow("cannot read the epoch of the staged generation")

    expect(fs.readFileSync(stagedMember(baseDir, "flywheel.sqlite"), "utf8")).toBe("not a sqlite database")
  })
})

/** The manifest is published through one entry this protocol names, so the only
 *  remainder a start killed inside a manifest write can leave is one the next
 *  start knows what to do with. */
describe("a manifest publication a start died inside", () => {
  it("publishes a pending initial manifest, and finishes the operation it owes", () => {
    const { directories, baseDir } = makeWorkspaceFixture()
    writePendingManifest(baseDir, validManifest())
    stampEpoch(resolveEventStoreDbFile(baseDir), 1)

    prepareAndRelease(directories)

    expect(stateEntries(baseDir)).toEqual(["flywheel.sqlite"])
    expect(readEpoch(resolveEventStoreDbFile(baseDir))).toBe(WORKSPACE_STATE_EPOCH)
  })

  it("drops a pending phase record its operation had only begun, and replays from the published phase", () => {
    const { directories, baseDir } = makeWorkspaceFixture()
    writeManifest(baseDir, validManifest({ phase: "staged" }))
    writePendingManifest(baseDir, validManifest({ phase: "stamping" }))
    stageTarget(baseDir, ["flywheel.sqlite"])

    prepareAndRelease(directories)

    expect(stateEntries(baseDir)).toEqual(["flywheel.sqlite"])
    expect(readEpoch(resolveEventStoreDbFile(baseDir))).toBe(WORKSPACE_STATE_EPOCH)
  })

  it("drops a pending phase record of a step that was done, and replays from the published phase", () => {
    const { directories, baseDir } = makeWorkspaceFixture()
    writeManifest(baseDir, validManifest({ phase: "stamping" }))
    writePendingManifest(baseDir, validManifest({ phase: "stamped" }))
    stageTarget(baseDir, ["flywheel.sqlite"])

    prepareAndRelease(directories)

    expect(stateEntries(baseDir)).toEqual(["flywheel.sqlite"])
    expect(readEpoch(resolveEventStoreDbFile(baseDir))).toBe(WORKSPACE_STATE_EPOCH)
  })

  it("refuses a pending manifest it cannot read, and mutates nothing", () => {
    const { directories, baseDir } = makeWorkspaceFixture()
    fs.mkdirSync(path.dirname(pendingManifestPath(baseDir)), { recursive: true })
    fs.writeFileSync(pendingManifestPath(baseDir), "{\"version\":3,")

    expect(() => prepareWorkspaceState(directories)).toThrow()

    expect(fs.readFileSync(pendingManifestPath(baseDir), "utf8")).toBe("{\"version\":3,")
    expect(fs.existsSync(resolveEventStoreDbFile(baseDir))).toBe(false)
  })

  it("refuses a pending manifest of another operation, and mutates nothing", () => {
    const { directories, baseDir } = makeWorkspaceFixture()
    writeManifest(baseDir, validManifest({ phase: "staged" }))
    writePendingManifest(baseDir, validManifest({ id: "operation-2", phase: "stamping" }))
    stageTarget(baseDir, ["flywheel.sqlite"])

    expect(() => prepareWorkspaceState(directories)).toThrow("refuses a pending manifest of another operation")

    expect(readManifest(baseDir)).toEqual(validManifest({ phase: "staged" }))
    expect(readPendingManifest(baseDir)).toEqual(validManifest({ id: "operation-2", phase: "stamping" }))
    expectStagedDatabase(baseDir, 1)
  })
})