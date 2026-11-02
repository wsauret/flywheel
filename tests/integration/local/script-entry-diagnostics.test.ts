/** A script entry that launches an owned process and configures no
 *  diagnostics sink, run in its own process.
 *
 *  `bench/chat-ab/bench-login.ts` printed the process supervisor's raw JSONL
 *  records on the terminal around its one line for a person. Diagnostics
 *  belong in the log directory, so the whole entry is the seam to prove: the
 *  launcher start, the guardian handshake, the owned launch, and the dispose. */

import { afterEach, beforeEach, expect, test } from "bun:test"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { listDebugLogFiles, resolveDebugLogDirectory, scanDebugLogFiles } from "../../../src/infra/debug-log.js"

const ENTRY = join(import.meta.dir, "..", "..", "fixtures", "owned-launch-entry.ts")

let home = ""

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "flywheel-script-entry-"))
})

afterEach(() => {
  rmSync(home, { recursive: true, force: true })
})

test("a script entry that launches an owned process prints only its own output, and its diagnostics reach the account log", async () => {
  const proc = Bun.spawn([process.execPath, "--conditions=browser", ENTRY], {
    env: { ...process.env, HOME: home, USERPROFILE: home, FLYWHEEL_UNCONFIGURED_LOG: "account-log" },
    stdout: "pipe",
    stderr: "pipe",
    windowsHide: true,
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])

  expect({ stdout, stderr, exitCode }).toEqual({ stdout: "the entry's own line\n", stderr: "", exitCode: 0 })
  const records = scanDebugLogFiles(listDebugLogFiles(resolveDebugLogDirectory(home)), { types: ["log.info"] })
  const messages = [...records].map(({ payload }) => payload)
  expect(messages).toContainEqual(expect.objectContaining({ service: "process-supervisor", message: "guardian started" }))
}, 30_000)

test("a script entry launched by a test inherits the drop selection from .env.test and writes no account log", async () => {
  const proc = Bun.spawn([process.execPath, "--conditions=browser", ENTRY], {
    env: { ...process.env, HOME: home, USERPROFILE: home },
    stdout: "pipe",
    stderr: "pipe",
    windowsHide: true,
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])

  expect({ stdout, stderr, exitCode }).toEqual({ stdout: "the entry's own line\n", stderr: "", exitCode: 0 })
  expect(existsSync(resolveDebugLogDirectory(home))).toBe(false)
}, 30_000)
