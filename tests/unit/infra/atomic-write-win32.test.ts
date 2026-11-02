import { describe, expect, test } from "bun:test"
import * as fs from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { renameThroughSharing, replaceFileOnWindows } from "../../../src/infra/windows-file-replacement.js"

type ReplacementError = Error & { readonly code: string }

function errno(code: string): ReplacementError {
  return Object.assign(new Error(code), { code })
}

describe("replaceFileOnWindows", () => {
  test("retries a sharing failure and publishes when rename succeeds", () => {
    const calls: string[] = []
    let attempts = 0

    replaceFileOnWindows("pending", "target", {
      rename: () => {
        attempts += 1
        calls.push(`rename-${attempts}`)
        if (attempts === 1) throw errno("EPERM")
      },
      unlink: () => calls.push("unlink"),
      lstat: () => ({ isFile: () => true, isSymbolicLink: () => false }),
      delay: (milliseconds) => calls.push(`delay-${milliseconds}`),
    })

    expect(attempts).toBe(2)
    expect(calls).toEqual(["rename-1", "delay-25", "rename-2"])
  })

  test("renames a verified regular target aside before publishing", () => {
    const calls: string[] = []
    let attempts = 0

    replaceFileOnWindows("pending", "target", {
      rename: (source, target) => {
        attempts += 1
        calls.push(`rename-${source}-${target}`)
        if (attempts <= 5) throw errno("EACCES")
      },
      unlink: (target) => calls.push(`unlink-${target}`),
      lstat: (target) => {
        calls.push(`lstat-${target}`)
        return { isFile: () => true, isSymbolicLink: () => false }
      },
      delay: (milliseconds) => calls.push(`delay-${milliseconds}`),
    })

    const aside = calls.find((call) => call.startsWith("rename-target-target.__flywheel-replaced__."))?.slice("rename-target-".length)
    expect(aside).toBeDefined()
    expect(calls).toContain(`rename-pending-target`)
    expect(calls.at(-1)).toBe(`unlink-${aside}`)
  })

  test("restores the original target when publication fails after rename-aside", () => {
    const failure = errno("EIO")
    const paths = new Map([["target", "old"], ["pending", "new"]])
    let attempts = 0
    const operations = {
      rename: (source: string, target: string) => {
        attempts += 1
        if (attempts <= 5) throw errno("EACCES")
        if (source === "pending" && target === "target") throw failure
        const content = paths.get(source)
        if (content === undefined) throw errno("ENOENT")
        paths.delete(source)
        paths.set(target, content)
      },
      unlink: (target: string) => { paths.delete(target) },
      lstat: () => ({ isFile: () => true, isSymbolicLink: () => false }),
      delay: () => {},
    }

    expect(() => replaceFileOnWindows("pending", "target", operations)).toThrow(failure)
    expect(paths.get("target")).toBe("old")
    expect(paths.get("pending")).toBe("new")
    expect([...paths.keys()].some((entry) => entry.includes(".__flywheel-replaced__."))).toBe(false)
  })

  test("removes the renamed-aside target after successful publication", () => {
    const paths = new Map([["target", "old"], ["pending", "new"]])
    let attempts = 0
    replaceFileOnWindows("pending", "target", {
      rename: (source, target) => {
        attempts += 1
        if (attempts <= 5) throw errno("EACCES")
        const content = paths.get(source)
        if (content === undefined) throw errno("ENOENT")
        paths.delete(source)
        paths.set(target, content)
      },
      unlink: (target) => { paths.delete(target) },
      lstat: () => ({ isFile: () => true, isSymbolicLink: () => false }),
      delay: () => {},
    })

    expect(paths.get("target")).toBe("new")
    expect([...paths.keys()].some((entry) => entry.includes(".__flywheel-replaced__."))).toBe(false)
  })

  test("preserves unrelated rename failures without inspecting or deleting the target", () => {
    for (const code of ["EINVAL", "ENOSPC", "ENOENT"]) {
      const failure = errno(code)
      let lstatCalls = 0
      let unlinkCalls = 0

      expect(() => replaceFileOnWindows("pending", "target", {
        rename: () => { throw failure },
        unlink: () => { unlinkCalls += 1 },
        lstat: () => {
          lstatCalls += 1
          return { isFile: () => true, isSymbolicLink: () => false }
        },
        delay: () => {},
      })).toThrow(failure)

      expect(lstatCalls).toBe(0)
      expect(unlinkCalls).toBe(0)
    }
  })

  test("does not delete a target that is absent, not regular, or not verifiable", () => {
    for (const targetState of ["absent", "directory", "acl"] as const) {
      const failure = errno("EPERM")
      let unlinkCalls = 0

      expect(() => replaceFileOnWindows("pending", "target", {
        rename: () => { throw failure },
        unlink: () => { unlinkCalls += 1 },
        lstat: () => {
          if (targetState === "absent") throw errno("ENOENT")
          if (targetState === "acl") throw errno("EACCES")
          return { isFile: () => false, isSymbolicLink: () => false }
        },
        delay: () => {},
      })).toThrow(failure)

      expect(unlinkCalls).toBe(0)
    }
  })

  test("requires a fresh target-type proof before rename-aside fallback", () => {
    const failure = errno("EPERM")
    let lstatCalls = 0
    let unlinkCalls = 0

    expect(() => replaceFileOnWindows("pending", "target", {
      rename: () => { throw failure },
      unlink: () => { unlinkCalls += 1 },
      lstat: () => {
        lstatCalls += 1
        if (lstatCalls === 6) return { isFile: () => false, isSymbolicLink: () => false }
        return { isFile: () => true, isSymbolicLink: () => false }
      },
      delay: () => {},
    })).toThrow(failure)

    expect(lstatCalls).toBe(6)
    expect(unlinkCalls).toBe(0)
  })

  test("never replaces a junction or a symlink through the aside rename", () => {
    const failure = errno("EPERM")
    let unlinkCalls = 0

    expect(() => replaceFileOnWindows("pending", "target", {
      rename: () => { throw failure },
      unlink: () => { unlinkCalls += 1 },
      lstat: () => ({ isFile: () => false, isSymbolicLink: () => true }),
      delay: () => {},
    })).toThrow(failure)

    expect(unlinkCalls).toBe(0)
  })

  test("replaces an open target on Windows when the platform permits it", () => {
    if (process.platform !== "win32") return

    const testDir = fs.mkdtempSync(join(tmpdir(), "flywheel-atomic-write-win32-"))
    const target = join(testDir, "target.txt")
    const pending = join(testDir, "pending.txt")
    fs.writeFileSync(target, "old")
    fs.writeFileSync(pending, "new")
    const handle = fs.openSync(target, "r")
    let content: string | undefined
    try {
      replaceFileOnWindows(pending, target)
      content = fs.readFileSync(target, "utf8")
    } finally {
      fs.closeSync(handle)
      fs.rmSync(testDir, { recursive: true, force: true })
    }

    expect(content).toBe("new")
  })
})

describe("renameThroughSharing", () => {
  /** A rename Windows refuses `refusals` times, as it does while another
   *  process holds the file, on a clock that advances by each pause. */
  function refusingRename(refusals: number, code = "EPERM") {
    let now = 0
    const attempts: number[] = []
    return {
      attempts,
      operations: {
        rename: () => {
          attempts.push(now)
          if (attempts.length <= refusals) throw errno(code)
        },
        nowMs: () => now,
        pause: (ms: number) => { now += ms },
      },
    }
  }

  test("retries while another process holds the file, and lands once it lets go", () => {
    const { attempts, operations } = refusingRename(3)

    renameThroughSharing("from", "to", operations)

    expect(attempts).toHaveLength(4)
  })

  test("gives up after its bound with the refusal, never moving the target aside", () => {
    const { attempts, operations } = refusingRename(Number.POSITIVE_INFINITY)

    expect(() => { renameThroughSharing("from", "to", operations) }).toThrow("EPERM")
    expect(attempts.at(-1)).toBeGreaterThanOrEqual(2_000)
    expect(attempts.at(-1)).toBeLessThan(2_010)
  })

  test("does not retry a failure that is not a sharing refusal", () => {
    const { attempts, operations } = refusingRename(1, "ENOENT")

    expect(() => { renameThroughSharing("from", "to", operations) }).toThrow("ENOENT")
    expect(attempts).toHaveLength(1)
  })
})
