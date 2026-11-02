/**
 * Packages this extension as one universal VSIX.
 *
 * The package carries no runtime. On a machine with no Flywheel the extension
 * installs the current release through the platform's bootstrap installer
 * (ARCH-DISTRIBUTION-032), so the one file serves every operating system, every CPU, and
 * every remote host.
 *
 * Usage:
 *   bun run scripts/package.ts
 */

import { rmSync } from "node:fs"
import { join, resolve } from "node:path"
import { stageLegalPayload, LEGAL_PAYLOAD_FILES } from "../../scripts/legal-payload.js"

const ROOT = resolve(import.meta.dir, "..")
const FLYWHEEL = resolve(ROOT, "..")

function run(cmd: string[]): void {
  const result = Bun.spawnSync(cmd, { cwd: ROOT, stdout: "inherit", stderr: "inherit", windowsHide: true })
  if (result.exitCode !== 0) process.exit(result.exitCode ?? 1)
}

await stageLegalPayload(FLYWHEEL, ROOT)
try {
  run(["bun", "run", "scripts/build.ts", "--production"])
  run(["bunx", "@vscode/vsce", "package", "--no-dependencies"])
} finally {
  for (const name of LEGAL_PAYLOAD_FILES) rmSync(join(ROOT, name), { force: true })
}
