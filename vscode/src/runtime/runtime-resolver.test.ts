import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { resolveRuntime } from "./runtime-resolver.js"

const LAUNCHER = "/home/a/.local/bin/flywheel"
const MINIMUM = "0.0.4"

/** A probe that answers only for the paths named, so a test states exactly
 *  which runtimes exist on the machine it describes. `flywheel` is the one on
 *  PATH. */
function probing(versions: { readonly [executable: string]: string }) {
  return async (executable: string) => versions[executable]
}

describe("runtime resolution", () => {
  test("an explicit setting outranks every discovered install", async () => {
    // Someone who names a binary means it, including a development build.
    const result = await resolveRuntime({
      configured: "/my/build/flywheel",
      launcher: LAUNCHER,
      minimumVersion: MINIMUM,
      probe: probing({ "/my/build/flywheel": "0.0.5", [LAUNCHER]: "0.0.9", flywheel: "0.0.9" }),
    })
    assert.deepEqual(result, { ok: true, runtime: { executable: "/my/build/flywheel", version: "0.0.5", source: "setting" } })
  })

  test("a setting that does not work is an error, not a reason to run something else", async () => {
    // Falling through would tell the user they are on the build they named
    // while they are not.
    const result = await resolveRuntime({
      configured: "/gone/flywheel",
      launcher: LAUNCHER,
      minimumVersion: MINIMUM,
      probe: probing({ [LAUNCHER]: "0.0.9" }),
    })
    assert.ok(!result.ok)
    assert.equal(result.failure.kind, "setting_unusable")
  })

  test("the launcher the installer placed comes before PATH", async () => {
    // The installer's PATH edit reaches a shell profile, never a host that is
    // already running, so the launcher is found by its installed path.
    const result = await resolveRuntime({
      launcher: LAUNCHER,
      minimumVersion: MINIMUM,
      probe: probing({ [LAUNCHER]: "0.0.6", flywheel: "0.0.7" }),
    })
    assert.deepEqual(result, { ok: true, runtime: { executable: LAUNCHER, version: "0.0.6", source: "launcher" } })
  })

  test("uses a compatible PATH install when the launcher is too old", async () => {
    const result = await resolveRuntime({
      launcher: LAUNCHER,
      minimumVersion: MINIMUM,
      probe: probing({ [LAUNCHER]: "0.0.1", flywheel: "0.0.4" }),
    })
    assert.ok(result.ok)
    assert.equal(result.runtime.source, "path")
  })

  test("names a too-old launcher as its own problem", async () => {
    // Having Flywheel but an older one is a different situation from having
    // none, and installing over it would bypass the account's own update
    // setting, so it is reported rather than replaced.
    const result = await resolveRuntime({
      launcher: LAUNCHER,
      minimumVersion: MINIMUM,
      probe: probing({ [LAUNCHER]: "0.0.2", flywheel: "0.0.3" }),
    })
    assert.deepEqual(result, { ok: false, failure: { kind: "too_old", executable: LAUNCHER, version: "0.0.2", source: "launcher" } })
  })

  test("reports nothing found when there is nothing to run", async () => {
    const result = await resolveRuntime({
      launcher: LAUNCHER,
      minimumVersion: MINIMUM,
      probe: probing({}),
    })
    assert.deepEqual(result, { ok: false, failure: { kind: "none_found" } })
  })
})
