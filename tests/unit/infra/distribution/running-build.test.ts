import { describe, expect, test } from "bun:test"

import { runningDisplayBuildId } from "../../../../src/infra/distribution/running-build.js"
import { temporaryDirectories } from "../../../helpers/directories.js"
import { snapshotFixture } from "../../../helpers/source-snapshot-fixture.js"

const temporaryDirectory = temporaryDirectories()

describe("a source checkout's displayed build identity", () => {
  test("is displayed as the snapshot digest it runs from, and as unknown from a live checkout", async () => {
    const fixture = snapshotFixture(temporaryDirectory("flywheel-snapshot-display-"), ["src/infra/distribution/running-build.ts"])
    const snapshotted = await fixture.importFromSnapshot<typeof import("../../../../src/infra/distribution/running-build.js")>("src/infra/distribution/running-build.ts")

    expect(snapshotted.runningDisplayBuildId({ kind: "source" })).toBe("0123456789abcdef")
    expect(runningDisplayBuildId({ kind: "source" })).toBeNull()
  })
})
