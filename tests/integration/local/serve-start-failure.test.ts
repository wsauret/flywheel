/** A start of the account service that fails before it listens, run through
 *  the real entry in its own process. Its cause must reach the account log,
 *  where the person reads it, and not only the standard error that a service
 *  manager may discard. */

import { afterEach, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readdirSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { scanDebugLogFiles } from "../../../src/infra/debug-log.js"

const ENTRY = join(import.meta.dir, "..", "..", "..", "src", "cli", "index.ts")
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

test("a start that fails before it listens writes its fatal record to the account log and exits 1", async () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "fw-serve-fatal-")))
  roots.push(home)
  // A hub port override without the release harness's identity is refused
  // before the service reads its address.
  const { FLYWHEEL_INTERNAL_RELEASE_HARNESS: _harness, FLYWHEEL_INTERNAL_RELEASE_HUB_RECORD: _record, FLYWHEEL_PROJECT_ROOT: _project, ...inherited } = process.env
  const child = Bun.spawn([process.execPath, "--conditions=browser", ENTRY, "serve"], {
    cwd: home,
    env: { ...inherited, HOME: home, FLYWHEEL_INTERNAL_RELEASE_HUB_PORT: "5" },
    stdout: "ignore",
    stderr: "pipe",
    windowsHide: true,
  })
  const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()])

  expect(code).toBe(1)
  expect(stderr).toContain("isolated hub binding is reserved")
  const logDir = join(home, ".flywheel", "log")
  const files = existsSync(logDir) ? readdirSync(logDir).map((name) => join(logDir, name)) : []
  const fatal = [...scanDebugLogFiles(files, { types: ["log.error"] })].map((record) => record.payload)
  expect(fatal).toContainEqual(expect.objectContaining({ message: "fatal", error: expect.stringContaining("isolated hub binding is reserved") }))
}, 60_000)
