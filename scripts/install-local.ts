import { existsSync } from "node:fs"
import { join, resolve } from "node:path"

const ROOT = resolve(import.meta.dir, "..")

const platform = (() => {
  if (process.platform === "win32") return "win32"
  if (process.platform === "darwin") return "darwin"
  if (process.platform === "linux") return "linux"
  throw new Error(`Unsupported local install platform: ${process.platform}`)
})()

const architecture = (() => {
  if (process.arch === "x64") return "x64"
  if (process.arch === "arm64") return "arm64"
  throw new Error(`Unsupported local install architecture: ${process.arch}`)
})()

function run(command: string[], cwd: string): void {
  const result = Bun.spawnSync(command, {
    cwd,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
    windowsHide: true,
  })
  if (result.exitCode !== 0) process.exit(result.exitCode ?? 1)
}

// A pull can bring a new package.json and bun.lock without the packages, and
// the build then fails on missing modules. Syncing first makes the checkout
// match its lockfile; --frozen-lockfile refuses to rewrite the lockfile.
console.log("Syncing dependencies...")
run([process.execPath, "install", "--frozen-lockfile"], ROOT)

console.log("Building binary...")
run([process.execPath, "run", "build:binary"], ROOT)

const staging = join(ROOT, "dist", `flywheel-${platform}-${architecture}`)
const installer = join(staging, platform === "win32" ? "install.ps1" : "install.sh")
if (!existsSync(installer)) {
  throw new Error(`Build succeeded but its installer was not staged: ${installer}`)
}

if (platform === "win32") {
  run(["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", installer], staging)
} else {
  run([installer], staging)
}
