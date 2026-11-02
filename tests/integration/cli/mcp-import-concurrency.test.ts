import { expect, test } from "bun:test"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { temporaryDirectories } from "../../helpers/directories.js"

const temporaryDirectory = temporaryDirectories()

async function writeConfig(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, content)
}

test("serializes MCP import with a settings mutation without losing either update", async () => {
  const dir = temporaryDirectory("flywheel-mcp-concurrent-")
  const config = join(dir, "flywheel.toml")
  await writeConfig(config, "# original\n")
  const writerUrl = new URL("../../../src/orchestration/config/writer.ts", import.meta.url).href
  const mcpUrl = new URL("../../../src/orchestration/modules/mcp/cli/mcp.ts", import.meta.url).href
  const script = `
    const writer = await import(process.env.WRITER_URL)
    await Bun.stdin.text()
    const result = process.env.OP === "import"
      ? await (await import(process.env.MCP_URL)).runMcp(["add", "work", "--url", "https://mcp.example"], { userDataRoot: process.env.DIR, accountHome: process.env.DIR, projectRoot: process.env.DIR, executionCwd: process.env.DIR }, { configPath: process.env.CONFIG_PATH }).then(() => ({ ok: process.exitCode !== 1 }))
      : writer.updateShowThinking(true, { configPath: process.env.CONFIG_PATH })
    if (!result.ok) throw new Error("the write was refused")
  `
  const spawn = (op: "import" | "setting") => Bun.spawn({
    cmd: [process.execPath, "--conditions=browser", "-e", script],
    env: { ...process.env, CONFIG_PATH: config, OP: op, WRITER_URL: writerUrl, MCP_URL: mcpUrl, DIR: dir },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    windowsHide: true,
  })
  const importing = spawn("import")
  const setting = spawn("setting")
  importing.stdin.end()
  setting.stdin.end()

  expect(await Promise.all([importing.exited, setting.exited])).toEqual([0, 0])
  const text = await readFile(config, "utf8")
  expect(text).toContain("# original")
  expect(Bun.TOML.parse(text)).toMatchObject({ show_thinking: true, mcp: { servers: { work: { url: "https://mcp.example", enabled: true } } } })
})
