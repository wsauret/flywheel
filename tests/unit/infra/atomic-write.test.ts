import { afterEach, describe, expect, spyOn, test } from "bun:test"
import { POSIX_FILE_MODES } from "../../helpers/posix-modes.js"
import * as fs from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { appendFileEnsuringDir, fsyncDirectory, writeFileAtomic } from "../../../src/infra/atomic-write.js"

describe("appendFileEnsuringDir", () => {
  const testDir = fs.mkdtempSync(join(tmpdir(), "atomic-write-test-"))

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true })
  })

  test("creates the parent directory on first write", async () => {
    const filePath = join(testDir, "nested", "log.jsonl")
    appendFileEnsuringDir(filePath, "first\n")

    expect(await Bun.file(filePath).text()).toBe("first\n")
  })

  test("appends without truncating existing content", async () => {
    const filePath = join(testDir, "log.jsonl")
    writeFileAtomic(filePath, "first\n")
    appendFileEnsuringDir(filePath, "second\n")

    expect(await Bun.file(filePath).text()).toBe("first\nsecond\n")
  })
})

describe("fsyncDirectory", () => {
  test("does not open the directory on Windows", () => {
    const open = spyOn(fs, "openSync").mockImplementation(() => { throw new Error("opened"); })
    try {
      expect(() => fsyncDirectory("C:\\unavailable", "win32")).not.toThrow()
      expect(open).not.toHaveBeenCalled()
    } finally {
      open.mockRestore()
    }
  })
})

describe("writeFileAtomic", () => {
  const testDir = fs.mkdtempSync(join(tmpdir(), "atomic-write-mode-test-"))

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true })
  })

  test("sets restrictive temp permissions before writing bytes", () => {
    const original = fs.writeFileSync
    const write = spyOn(fs, "writeFileSync").mockImplementation((fd, content, encoding) => {
      if (typeof fd !== "number") throw new Error("expected a file descriptor")
      if (POSIX_FILE_MODES) expect(fs.fstatSync(fd).mode & 0o777).toBe(0o600)
      return original(fd, content, encoding)
    })
    try {
      const filePath = join(testDir, "secret.json")
      writeFileAtomic(filePath, "secret", { mode: 0o600 })
      if (POSIX_FILE_MODES) expect(fs.statSync(filePath).mode & 0o777).toBe(0o600)
    } finally {
      write.mockRestore()
    }
  })

  test("fsyncs the parent directory after a durable rename", () => {
    if (process.platform === "win32") return
    const original = fs.fsyncSync
    let syncedDirectory = false
    const fsync = spyOn(fs, "fsyncSync").mockImplementation((fd) => {
      if (fs.fstatSync(fd).isDirectory()) syncedDirectory = true
      return original(fd)
    })
    try {
      writeFileAtomic(join(testDir, "config.toml"), "theme = \"default\"\n", { durableDirectorySync: true })
      expect(syncedDirectory).toBe(true)
    } finally {
      fsync.mockRestore()
    }
  })

  test("preserves raw byte content", () => {
    const filePath = join(testDir, "raw.bin")
    const bytes = Uint8Array.from([0, 0xef, 0xbb, 0xbf, 0xc3, 0xa9, 255])
    writeFileAtomic(filePath, bytes)
    expect(fs.readFileSync(filePath)).toEqual(Buffer.from(bytes))
  })
})
