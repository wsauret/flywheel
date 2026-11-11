import { describe, expect, test } from "bun:test"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"

import { embeddedEntrySpecifier, flywheelCacheDirectory, runningSourceSnapshot, runsThroughBun, serveLaneFor, sourceCheckout } from "../../../src/infra/cli-subprocess.js"

describe("CLI runtime detection", () => {
  test("detects Bun by executable name", () => {
    expect(runsThroughBun("/Users/me/.bun/bin/bun")).toBe(true)
    expect(runsThroughBun("C:\\Users\\me\\.bun\\bin\\bun.exe")).toBe(true)
    expect(runsThroughBun("/Users/me/.local/bin/flywheel")).toBe(false)
  })

  test("detects the running packaged binary started as Bun through BUN_BE_BUN, and only that binary", () => {
    const packaged = "/Users/me/.flywheel/versions/1/flywheel-bin"
    expect(runsThroughBun(packaged, { execPath: packaged, env: { BUN_BE_BUN: "1" } })).toBe(true)
    expect(runsThroughBun(packaged, { execPath: packaged, env: {} })).toBe(false)
    expect(runsThroughBun("/opt/flywheel/flywheel", { execPath: packaged, env: { BUN_BE_BUN: "1" } })).toBe(false)
  })

  test("a source checkout serves in its own lane and an installed build in the installed one", () => {
    expect(serveLaneFor("/Users/me/.bun/bin/bun")).toBe("dev")
    expect(serveLaneFor("C:\\Users\\me\\.bun\\bin\\bun.exe")).toBe("dev")
    expect(serveLaneFor("/Users/me/.local/bin/flywheel")).toBe("installed")
    expect(serveLaneFor("C:\\Users\\me\\.flywheel\\bin\\flywheel.exe")).toBe("installed")
  })
})

describe("embedded entry specifier", () => {
  test("names the Windows module mount with the separators it answers to", () => {
    expect(embeddedEntrySpecifier("B:\\~BUN\\root", "worker-entry.js")).toBe("B:/~BUN/root/worker-entry.js")
  })

  test("leaves a Unix module mount unchanged", () => {
    expect(embeddedEntrySpecifier("/$bunfs/root", "worker-entry.js")).toBe("/$bunfs/root/worker-entry.js")
  })

})

describe("the checkout a source module belongs to", () => {
  const checkout = resolve("/scratch/flywheel")
  const moduleIn = (root: string) => pathToFileURL(join(root, "src", "infra", "cli-subprocess.ts")).href
  const snapshot = join(checkout, "node_modules", ".cache", "flywheel", "source", "0123456789abcdef")

  test("is the checkout that holds the snapshot a module runs from, with the build cache of that checkout", () => {
    expect(runningSourceSnapshot(moduleIn(snapshot))).toEqual({ checkout, digest: "0123456789abcdef" })
    expect(sourceCheckout(moduleIn(snapshot))).toBe(checkout)
    expect(flywheelCacheDirectory(moduleIn(snapshot))).toBe(join(checkout, "node_modules", ".cache", "flywheel"))
  })

  test("is the tree itself for a module of a live checkout, including a directory that only looks like a snapshot", () => {
    expect(runningSourceSnapshot(moduleIn(checkout))).toBeUndefined()
    expect(sourceCheckout(moduleIn(checkout))).toBe(checkout)
    expect(flywheelCacheDirectory(moduleIn(checkout))).toBe(join(checkout, "node_modules", ".cache", "flywheel"))
    const notADigest = join(checkout, "node_modules", ".cache", "flywheel", "source", "not-a-digest")
    expect(runningSourceSnapshot(moduleIn(notADigest))).toBeUndefined()
    const elsewhere = join(checkout, "node_modules", ".cache", "other", "source", "0123456789abcdef")
    expect(runningSourceSnapshot(moduleIn(elsewhere))).toBeUndefined()
  })
})
