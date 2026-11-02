/**
 * Packages the universal VSIX and installs it into the local VS Code, the
 * extension counterpart of the repository's `install:local` for the binary.
 *
 * The package carries no runtime, so the installed extension serves from the
 * account's installed Flywheel, and installs the current release when there is
 * none. To exercise a checkout's runtime instead, point `flywheel.executablePath`
 * at the checkout's `bin/flywheel`.
 *
 * Usage:
 *   bun run install:local            # from vscode/
 *   bun run install:extension        # from the repository root
 */

import { existsSync } from "node:fs"
import { join, resolve } from "node:path"

const ROOT = resolve(import.meta.dir, "..")

function run(cmd: string[]): void {
  const result = Bun.spawnSync(cmd, { cwd: ROOT, stdout: "inherit", stderr: "inherit", windowsHide: true })
  if (result.exitCode !== 0) process.exit(result.exitCode ?? 1)
}

run(["bun", "run", "scripts/package.ts"])

const manifest: unknown = await Bun.file(join(ROOT, "package.json")).json()
if (typeof manifest !== "object" || manifest === null || !("name" in manifest) || typeof manifest.name !== "string" || !("version" in manifest) || typeof manifest.version !== "string") {
  throw new Error("package.json must define string name and version fields")
}
const vsix = `${manifest.name}-${manifest.version}.vsix`
if (!existsSync(join(ROOT, vsix))) {
  console.error(`Packaging reported success but did not create ${vsix} in ${ROOT}.`)
  process.exit(1)
}

// `code` from PATH is the user's own VS Code; --force replaces an installed
// copy of the same version, which a local build always is.
run(["code", "--install-extension", join(ROOT, vsix), "--force"])

console.log(`\ninstalled ${vsix}. Reload VS Code windows to pick it up.`)
