import { expect, test } from "bun:test"
import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { runHeadlessTask } from "../../../../src/orchestration/headless/run-headless-task.js"
import { temporaryDirectories, testDirectories } from "../../../helpers/directories.js"
import { fakeModelsClient } from "../../../helpers/model-tier-fixtures.js"
import { startLoopbackMcpServer } from "../../../helpers/code-mode-loopback-mcp.js"
import { mcpService } from "../../../../src/orchestration/modules/mcp/service.js"

const directory = temporaryDirectories()
const launcher = { spawnOwned: async () => { throw new Error("unused") }, adoptOwned: async () => { throw new Error("unused") }, open() { return this }, close: async () => ({ settled: true as const }) }

test("connects the MCP servers the account configures before the task prepares its runner", async () => {
  const projectRoot = directory("headless-mcp-")
  const accountHome = directory("headless-mcp-home-")
  const userDataRoot = join(accountHome, ".flywheel")
  const server = startLoopbackMcpServer({ largeResultBytes: 1024 })
  let tools: readonly string[] | undefined
  try {
    await mkdir(userDataRoot, { recursive: true })
    await writeFile(join(userDataRoot, "flywheel.toml"), `[mcp.servers.loop]\nurl = "${server.url}"\n`)
    const result = await runHeadlessTask("work", {
      launcher, modelsClient: fakeModelsClient,
      directories: { ...testDirectories(projectRoot), accountHome, userDataRoot },
      printErrorsToStderr: false,
      prepareWorkflowDeps: async (input) => {
        tools = input.moduleServices?.get(mcpService)?.ports.tools().map((tool) => `${tool.server}.${tool.name}`)
        throw new Error("stop after deps preparation")
      },
    })
    expect(result.completed).toBe(false)
    expect(tools).toEqual(["loop.large", "loop.pending"])
  } finally {
    await server.close()
  }
})
