import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, dirname, join } from "node:path"

import { createProcessTemporaryDirectory, removeProcessTemporaryDirectory } from "../../../src/infra/process-temporary-directory.js"

// A pid far above every platform's pid limit, so no process ever holds it.
const DEAD_PID = 2_147_483_646

let temporary: string

beforeEach(() => { temporary = mkdtempSync(join(tmpdir(), "flywheel-process-dirs-")) })
afterEach(() => { rmSync(temporary, { recursive: true, force: true }) })

describe.skipIf(process.platform === "win32")("process temporary directories", () => {
  test("a new directory is private, lives in this user's root, and names this process", async () => {
    const directory = await createProcessTemporaryDirectory("fw-ipc", temporary)

    expect(dirname(directory)).toBe(join(temporary, `fw-ipc-${process.getuid!()}`))
    expect(basename(directory).startsWith(`${process.pid}-`)).toBe(true)
    expect(statSync(directory).mode & 0o777).toBe(0o700)
    expect(statSync(dirname(directory)).mode & 0o777).toBe(0o700)
  })

  test("removal takes everything still in the directory", async () => {
    const directory = await createProcessTemporaryDirectory("fw-ipc", temporary)
    writeFileSync(join(directory, "c.sock"), "")

    await removeProcessTemporaryDirectory(directory)

    expect(existsSync(directory)).toBe(false)
  })

  test("a new directory removes the directories of processes that no longer run", async () => {
    const first = await createProcessTemporaryDirectory("fw-ipc", temporary)
    const root = dirname(first)
    const abandoned = join(root, `${DEAD_PID}-abcdef`)
    const foreign = join(root, "not-an-endpoint")
    mkdirSync(abandoned)
    writeFileSync(join(abandoned, "c.sock"), "")
    mkdirSync(foreign)

    const second = await createProcessTemporaryDirectory("fw-ipc", temporary)

    expect(existsSync(abandoned)).toBe(false)
    expect(existsSync(first)).toBe(true)
    expect(existsSync(second)).toBe(true)
    expect(existsSync(foreign)).toBe(true)
  })
})
