import { afterEach, describe, expect, test } from "bun:test"

import { createCliLauncher } from "../../../src/cli/runtime-launch.js"
import { BunStdioClientTransport } from "../../../src/orchestration/agent-runtime/mcp-stdio-client-transport.js"
import {
  containerHolds,
  createRealProcessFixture,
  processAlive,
  type RealProcessFixture,
} from "../../helpers/real-process-fixture.js"

/** MCP stdio servers against the real guardian: a server is a container the
 *  guardian owns before it runs, so the tree ends with the generation that
 *  launched it. Nothing in the MCP layer signals a process group itself. A
 *  crash of the owning process ends the container through the guardian, which
 *  owned-subprocess-guardian.test.ts proves for any payload tree. */

/** A server that ignores SIGTERM and leaves a SIGTERM-resistant descendant in
 *  its container, so only a container SIGKILL removes the tree. It reports both
 *  pids through files, because the point of the test is what survives the
 *  generation, not what the transport observed. */
function resistantServerSource(serverPidFile: string, childPidFile: string): string {
  return [
    `await Bun.write(${JSON.stringify(serverPidFile)}, String(process.pid));`,
    `const child = Bun.spawn([process.execPath, "-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { stdout: "ignore", stderr: "ignore", windowsHide: true });`,
    `await Bun.write(${JSON.stringify(childPidFile)}, String(child.pid));`,
    `process.on("SIGTERM", () => {});`,
    `setInterval(() => {}, 1000);`,
  ].join("\n")
}

const fixtures: RealProcessFixture[] = []

function fixture(name: string): RealProcessFixture {
  const created = createRealProcessFixture(name)
  fixtures.push(created)
  return created
}

afterEach(() => {
  for (const created of fixtures.splice(0)) created.cleanup()
})

async function guardedPid(scratch: RealProcessFixture, file: string): Promise<number> {
  return scratch.guard(Number((await scratch.waitForFile(file, 15_000)).trim()))
}

describe("MCP stdio process ownership", () => {
  test("closing the generation ends a server tree the transport still holds", async () => {
    const scratch = fixture("mcp-owned-generation")
    const serverPidFile = scratch.file("server.pid")
    const childPidFile = scratch.file("child.pid")
    const launcher = await createCliLauncher()
    const generation = launcher.scope.open()

    try {
      const transport = new BunStdioClientTransport({
        command: process.execPath,
        args: ["-e", resistantServerSource(serverPidFile, childPidFile)],
        cwd: scratch.dir,
        env: { PATH: process.env.PATH ?? "" },
        spawnOwned: generation.spawnOwned,
      })
      await transport.start()
      const serverPid = await guardedPid(scratch, serverPidFile)
      const childPid = await guardedPid(scratch, childPidFile)
      const owned = { pid: transport.pid ?? 0, token: transport.token ?? "" }
      expect(owned.token).not.toBe("")
      expect(containerHolds(owned, serverPid)).toBe(true)

      await generation.close()
      await scratch.waitForGone(serverPid, 20_000)
      await scratch.waitForGone(childPid, 20_000)

      expect(processAlive(serverPid)).toBe(false)
      expect(processAlive(childPid)).toBe(false)
    } finally {
      await launcher.dispose()
    }
  }, 60_000)
})
