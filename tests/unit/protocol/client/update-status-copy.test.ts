import { describe, expect, test } from "bun:test"
import { describeUpdateStatus } from "../../../../src/protocol/client/update-status-copy.js"

describe("update status copy", () => {
  // After a rollback the account runs an older release, and "up to date"
  // would be false while a newer release exists that this machine refused.
  test("a release that a rollback refused is named as one that could not start on this machine", () => {
    expect(describeUpdateStatus({ kind: "refused", version: "1.4.0" })).toBe("1.4.0 could not start on this machine")
  })

  // A local rebuild keeps its version, so the version alone would name the
  // build that runs.
  test("a refused build of the running build's version is named by its version and short build identity", () => {
    expect(describeUpdateStatus({ kind: "refused", version: "0.0.10", buildId: `3029f1ab${"0".repeat(56)}` })).toBe("0.0.10 build 3029f1ab could not start on this machine")
  })

  // After a dev service returns to its proved snapshot, both are named by
  // digest, so the words stay true after the checkout changes again.
  test("a dev service that runs the proved snapshot names the source that could not start and the one it runs", () => {
    expect(describeUpdateStatus({ kind: "source-refused", refused: "6acd416c00000000", running: "1b2c3d4e00000000" })).toBe("source 6acd416c could not start; running source 1b2c3d4e")
  })

  // A local install or a fork's build that names no release repository never
  // updates, and "up to date" would hide that.
  test("a build that names no release repository says that it does not update", () => {
    expect(describeUpdateStatus({ kind: "no-repository" })).toBe("updates off: this build names no release repository")
  })

  test("each other state keeps its words, and a view that has not arrived reads as up to date", () => {
    expect(describeUpdateStatus({ kind: "idle" })).toBe("up to date")
    expect(describeUpdateStatus(undefined)).toBe("up to date")
    expect(describeUpdateStatus({ kind: "available", version: "1.4.0", blocking: "nothing" })).toBe("1.4.0 available")
    expect(describeUpdateStatus({ kind: "installing", version: "1.4.0" })).toBe("installing 1.4.0")
    expect(describeUpdateStatus({ kind: "installed", version: "1.4.0" })).toBe("1.4.0 installed, restart to use it")
  })
})
