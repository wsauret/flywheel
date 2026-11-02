import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test"
import * as fs from "node:fs"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { RetainedFileEditAuthority } from "../../../../../src/orchestration/file-edits/retained-file-edit-host.js"

const isPosix = process.platform !== "win32"
let workspace: string

beforeEach(() => { workspace = mkdtempSync(join(tmpdir(), "retained-file-edit-")) })
afterEach(() => { rmSync(workspace, { recursive: true, force: true }) })

describe("retained file edit authority", () => {
  it("checks existing and absent preconditions without publishing", () => {
    const target = join(workspace, "target.txt")
    const absent = RetainedFileEditAuthority.admitWritable(target)
    try {
      absent.verifyPrecondition()
      writeFileSync(target, "before")
      expect(() => absent.verifyPrecondition()).toThrow("no longer absent")
    } finally { absent.close() }
    const existing = RetainedFileEditAuthority.admit(target)
    try {
      existing.verifyPrecondition()
      writeFileSync(target, "changed")
      expect(() => existing.verifyPrecondition()).toThrow("changed after admission")
      expect(readFileSync(target, "utf8")).toBe("changed")
    } finally { existing.close() }
  })

  it("requires an admitted missing parent to remain absent without creating it", () => {
    const parent = join(workspace, "missing")
    const authority = RetainedFileEditAuthority.admitWritable(join(parent, "nested", "file.txt"))
    try {
      authority.verifyPrecondition()
      expect(existsSync(parent)).toBe(false)
      mkdirSync(parent)
      expect(() => authority.verifyPrecondition()).toThrow("parent changed")
      expect(existsSync(join(parent, "nested"))).toBe(false)
    } finally { authority.close() }
  })

  it.skipIf(!isPosix)("creates a project file and its missing parents with the permissions the user's own tools would give them", () => {
    const target = join(workspace, "new", "nested", "file.ts")
    const authority = RetainedFileEditAuthority.admitWritable(target)
    const umask = process.umask()
    try {
      expect(authority.publish(Buffer.from("made\n")).status).toBe("published")
    } finally { authority.close() }

    expect(fs.statSync(target).mode & 0o777).toBe(0o666 & ~umask)
    expect(fs.statSync(join(workspace, "new")).mode & 0o777).toBe(0o777 & ~umask)
    expect(fs.statSync(join(workspace, "new", "nested")).mode & 0o777).toBe(0o777 & ~umask)
  })

  it.skipIf(!isPosix)("refuses replaced directory identity during preflight", () => {
    const parent = join(workspace, "parent")
    mkdirSync(parent)
    writeFileSync(join(parent, "target"), "before")
    const authority = RetainedFileEditAuthority.admit(join(parent, "target"))
    try {
      renameSync(parent, join(workspace, "moved"))
      mkdirSync(parent)
      writeFileSync(join(parent, "target"), "before")
      expect(() => authority.verifyPrecondition()).toThrow()
    } finally { authority.close() }
  })

  it("refuses same-identity byte changes before publication", () => {
    const target = join(workspace, "target.txt")
    writeFileSync(target, "before")
    const authority = RetainedFileEditAuthority.admit(target)
    try {
      writeFileSync(target, "changed")
      expect(authority.publish(Buffer.from("after"))).toMatchObject({ status: "not_applied", error: expect.objectContaining({ message: expect.stringContaining("no longer matches") }) })
      expect(readFileSync(target, "utf8")).toBe("changed")
    } finally { authority.close() }
  })

  it("bounds publication comparison by the admitted byte length", () => {
    const target = join(workspace, "target.txt")
    writeFileSync(target, "before")
    const authority = RetainedFileEditAuthority.admit(target)
    try {
      writeFileSync(target, "x".repeat(1024 * 1024))
      expect(authority.publish(Buffer.from("after"))).toMatchObject({ status: "not_applied", error: expect.objectContaining({ message: expect.stringContaining("7-byte read limit") }) })
      expect(readFileSync(target).byteLength).toBe(1024 * 1024)
    } finally { authority.close() }
  })

  it.skipIf(!isPosix)("refuses same-identity access changes before publication", () => {
    const target = join(workspace, "target.txt")
    writeFileSync(target, "before", { mode: 0o644 })
    const authority = RetainedFileEditAuthority.admit(target)
    try {
      chmodSync(target, 0o600)
      expect(authority.publish(Buffer.from("after"))).toMatchObject({ status: "not_applied", error: expect.objectContaining({ message: expect.stringContaining("no longer matches") }) })
      expect(readFileSync(target, "utf8")).toBe("before")
    } finally { authority.close() }
  })

  it("does not create missing parents until publication", () => {
    const selected = join(workspace, "selected")
    const missing = join(selected, "missing")
    mkdirSync(selected)
    const authority = RetainedFileEditAuthority.admitWritable(join(missing, "nested", "target.bin"), selected)
    try {
      expect(authority.snapshot).toBeUndefined()
      expect(authority.text).toBeUndefined()
      expect(existsSync(missing)).toBe(false)
      authority.publish(Buffer.from([0, 1, 2]))
      expect(readFileSync(join(missing, "nested", "target.bin"))).toEqual(Buffer.from([0, 1, 2]))
    } finally { authority.close() }
  })

  it("reports indeterminate when publication fails after parent materialization starts", () => {
    const selected = join(workspace, "selected")
    const missing = join(selected, "missing")
    mkdirSync(selected)
    const authority = RetainedFileEditAuthority.admitWritable(join(missing, "blocked", "target.bin"), selected)
    try {
      mkdirSync(missing)
      writeFileSync(join(missing, "blocked"), "not a directory")
      expect(authority.publish(Buffer.from("content"))).toMatchObject({ status: "indeterminate" })
      expect(existsSync(join(missing, "blocked", "target.bin"))).toBe(false)
    } finally { authority.close() }
  })

  it.skipIf(!isPosix)("reports indeterminate when the backend returns not_applied after creating parents", () => {
    const parent = join(workspace, "missing", "nested")
    const target = join(parent, "target.txt")
    const authority = RetainedFileEditAuthority.admitWritable(target)
    const original = fs.fsyncSync
    const fsync = spyOn(fs, "fsyncSync").mockImplementation(fd => {
      if (fs.fstatSync(fd).isFile()) {
        expect(existsSync(parent)).toBe(true)
        throw new Error("staged file fsync failed")
      }
      return original(fd)
    })
    try {
      expect(authority.publish(Buffer.from("content"))).toMatchObject({
        status: "indeterminate", error: expect.objectContaining({ message: "staged file fsync failed" }),
      })
      expect(existsSync(parent)).toBe(true)
      expect(existsSync(target)).toBe(false)
    } finally { fsync.mockRestore(); authority.close() }
  })

  it("leaves no directory artifacts when planning fails after admission", () => {
    const selected = join(workspace, "selected")
    const missing = join(selected, "missing")
    mkdirSync(selected)
    const authority = RetainedFileEditAuthority.admitWritable(join(missing, "target.bin"), selected)
    try {
      expect(() => { throw new Error("plan rejected") }).toThrow("plan rejected")
    } finally { authority.close() }
    expect(existsSync(missing)).toBe(false)
  })

  it.skipIf(!isPosix)("refuses a link planted in a missing component before publication", () => {
    const selected = join(workspace, "selected")
    const outside = join(workspace, "outside")
    mkdirSync(selected)
    mkdirSync(outside)
    const authority = RetainedFileEditAuthority.admitWritable(join(selected, "missing", "target.bin"), selected)
    try {
      symlinkSync(outside, join(selected, "missing"))
      expect(authority.publish(Buffer.from("unsafe"))).toMatchObject({ status: "indeterminate", error: expect.objectContaining({ message: expect.stringMatching(/symlink|contained path escapes/i) }) })
      expect(existsSync(join(outside, "target.bin"))).toBe(false)
    } finally { authority.close() }
  })

  it.skipIf(!isPosix)("publishes through the retained physical parent after an authored alias is swapped", () => {
    const physical = join(workspace, "physical")
    const replacement = join(workspace, "replacement")
    mkdirSync(physical)
    mkdirSync(replacement)
    const alias = join(workspace, "alias")
    symlinkSync(physical, alias)
    const target = join(alias, "target.txt")
    writeFileSync(join(physical, "target.txt"), "before")
    const authority = RetainedFileEditAuthority.admitWritable(target, alias)
    try {
      renameSync(alias, join(workspace, "old-alias"))
      symlinkSync(replacement, alias)
      authority.publish(Buffer.from("after"))
      expect(readFileSync(join(physical, "target.txt"), "utf8")).toBe("after")
      expect(authority.canonicalPath).toBe(resolve(realpathSync(physical), "target.txt"))
    } finally { authority.close() }
  })

  it("conditionally deletes only the admitted target", () => {
    const target = join(workspace, "target.txt")
    writeFileSync(target, "before")
    const authority = RetainedFileEditAuthority.admitWritable(target, workspace)
    try {
      writeFileSync(target, "changed")
      expect(authority.delete()).toMatchObject({ status: "not_applied", error: expect.objectContaining({ message: expect.stringContaining("no longer matches") }) })
      expect(readFileSync(target, "utf8")).toBe("changed")
    } finally { authority.close() }
  })
})

describe("writable admission", () => {
  it("finds the deepest existing parent without creating directories", () => {
    const target = join(workspace, "missing", "nested", "file.txt")
    const authority = RetainedFileEditAuthority.admitWritable(target)
    try {
      expect(existsSync(join(workspace, "missing"))).toBe(false)
      authority.publish(Buffer.from("created"))
      expect(readFileSync(target, "utf8")).toBe("created")
    } finally { authority.close() }
  })

  it("verifies absence and refuses a planted final entry", () => {
    const target = join(workspace, "target.txt")
    const authority = RetainedFileEditAuthority.admitWritable(target)
    try {
      authority.verifyAbsent()
      writeFileSync(target, "planted")
      expect(() => authority.verifyAbsent()).toThrow(/not absent|planted/i)
    } finally { authority.close() }
  })
})
