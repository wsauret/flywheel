import { describe, expect, test } from "bun:test"

import { releaseFit } from "../../../../src/infra/update/release-fit.js"

/** PI-REMOTE-016: a terminal on another machine follows the machine's
 *  release, never the other way round. */
describe("release fit of a terminal and the machine it reaches", () => {
  const terminal = { version: "0.2.0", protocolVersion: 65 }

  test("attaches when both run one release", () => {
    expect(releaseFit(terminal, { version: "0.2.0", protocolVersion: 65 })).toEqual({ kind: "attach" })
  })

  test("catches up to a newer machine release even when the protocols agree", () => {
    expect(releaseFit(terminal, { version: "0.2.1", protocolVersion: 65 })).toEqual({ kind: "install", version: "0.2.1" })
    expect(releaseFit(terminal, { version: "0.3.0", protocolVersion: 66 })).toEqual({ kind: "install", version: "0.3.0" })
  })

  test("waits for an older machine", () => {
    expect(releaseFit(terminal, { version: "0.1.9", protocolVersion: 65 })).toEqual({ kind: "wait" })
  })

  test("orders releases it cannot compare by their protocols", () => {
    expect(releaseFit(terminal, { version: "nightly", protocolVersion: 65 })).toEqual({ kind: "attach" })
    expect(releaseFit(terminal, { version: "nightly", protocolVersion: 66 })).toEqual({ kind: "install", version: "nightly" })
    expect(releaseFit(terminal, { version: "nightly", protocolVersion: 64 })).toEqual({ kind: "wait" })
  })

  test("a machine that states this release with another protocol runs an unreleased build", () => {
    expect(releaseFit(terminal, { version: "0.2.0", protocolVersion: 66 })).toEqual({ kind: "cannot-install", reason: "unreleased" })
    expect(releaseFit(terminal, { version: "0.2.0", protocolVersion: 64 })).toEqual({ kind: "wait" })
  })

  test("a terminal from source compares protocols and cannot install a release", () => {
    const source = { version: undefined, protocolVersion: 65 }
    expect(releaseFit(source, { version: "0.9.0", protocolVersion: 65 })).toEqual({ kind: "attach" })
    expect(releaseFit(source, { version: "0.9.0", protocolVersion: 66 })).toEqual({ kind: "cannot-install", reason: "source" })
    expect(releaseFit(source, { version: "0.1.0", protocolVersion: 64 })).toEqual({ kind: "wait" })
  })
})
