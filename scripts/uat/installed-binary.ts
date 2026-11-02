import { constants } from "node:fs"
import { access, realpath } from "node:fs/promises"
import { join, resolve } from "node:path"

export async function isExecutable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/** Resolve an installed Flywheel entry point and reject the source-tree wrapper. */
export async function resolveInstalledBinary(sourceProjectRoot: string): Promise<string> {
  const configured = process.env.FLYWHEEL_INSTALLED_BINARY
  const candidates = [
    configured,
    Bun.which("flywheel"),
    join(process.env.HOME ?? "", ".local", "bin", "flywheel"),
    "/usr/local/bin/flywheel",
  ].filter((candidate): candidate is string => candidate !== undefined && candidate !== "")
  const sourceWrapper = resolve(sourceProjectRoot, "bin", "flywheel")
  for (const candidate of candidates) {
    if (!await isExecutable(candidate)) continue
    const physical = await realpath(candidate)
    if (physical !== sourceWrapper) return candidate
  }
  throw new Error("installed flywheel binary was not found; run bun run install:local first")
}
