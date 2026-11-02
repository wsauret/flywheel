import { describe, expect, test } from "bun:test"
import { join, resolve } from "node:path"

import { MACOS_LAUNCHER_BUNDLE, MACOS_LAUNCHER_EXECUTABLE, macosLauncherDir, verifyMacosLauncherAsset } from "../../../scripts/binary-native-assets.js"

const root = resolve(import.meta.dir, "..", "..", "..")
const launcher = join(macosLauncherDir(root), MACOS_LAUNCHER_EXECUTABLE)
const darwin = process.platform === "darwin"

/** Reads the child's output until it prints its ready line. */
async function childReady(stdout: ReadableStream<Uint8Array>): Promise<void> {
  const decoder = new TextDecoder()
  let output = ""
  for await (const chunk of stdout) {
    output += decoder.decode(chunk, { stream: true })
    if (output.includes("ready\n")) return
  }
  throw new Error(`the child ended its output before it was ready: ${JSON.stringify(output)}`)
}

/** The tracked launcher is the program launchd runs for the account service
 *  on macOS: it must run the installed command as a child, hand back that
 *  child's exit status, and pass the signals launchd sends on to the child. */
describe.skipIf(!darwin)("the tracked macOS launcher", () => {
  test("is the bundle its manifest names", async () => {
    await verifyMacosLauncherAsset(root, join(macosLauncherDir(root), MACOS_LAUNCHER_BUNDLE))
  })

  test("returns the child's exit status", async () => {
    const child = Bun.spawn([launcher, "/bin/sh", "-c", "exit 7"], { stdout: "pipe", stderr: "pipe", windowsHide: true })
    expect(await child.exited).toBe(7)
  })

  test("forwards a termination request to the child and ends with it", async () => {
    const child = Bun.spawn([launcher, "/bin/sh", "-c", "trap 'exit 43' TERM; echo ready; sleep 30 & wait $!"], { stdout: "pipe", stderr: "pipe", windowsHide: true })
    // The child says it is ready only after its trap is in place, so the
    // request never lands before the child can answer it.
    await childReady(child.stdout)
    child.kill("SIGTERM")
    expect(await child.exited).toBe(43)
  })

  test("reports a command it cannot start", async () => {
    const child = Bun.spawn([launcher, "/nonexistent/flywheel"], { stdout: "pipe", stderr: "pipe", windowsHide: true })
    expect(await child.exited).toBe(126)
    expect(await new Response(child.stderr).text()).toContain("cannot start")
  })
})
