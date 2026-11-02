import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"

let root = ""
let configPath = ""

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "runtime-config-process-"))
  mkdirSync(join(root, ".flywheel"))
  configPath = join(root, ".flywheel", "flywheel.toml")
})

afterEach(() => { rmSync(root, { recursive: true, force: true }) })

const ownerModule = pathToFileURL(join(process.cwd(), "src/orchestration/config/runtime-config-owner.ts")).href
const childScript = `
  import { createRuntimeConfigOwner } from ${JSON.stringify(ownerModule)};
  const owner = await createRuntimeConfigOwner({ configPath: process.env.CONFIG_PATH, watch: false });
  const expected = JSON.parse(process.env.EXPECTED);
  const desired = JSON.parse(process.env.DESIRED);
  const result = await owner.mutate(process.env.SETTING, expected, desired);
  console.log(JSON.stringify(result.ok ? { kind: "committed", text: await Bun.file(process.env.CONFIG_PATH).text() } : { kind: result.kind }));
  await owner.dispose();
`

async function mutate(setting: string, expected: unknown, desired: unknown): Promise<{ kind: string; text?: string }> {
  const processHandle = Bun.spawn([process.execPath, "-e", childScript], {
    env: { ...process.env, CONFIG_PATH: configPath, SETTING: setting, EXPECTED: JSON.stringify(expected), DESIRED: JSON.stringify(desired) },
    stdout: "pipe",
    stderr: "pipe",
    windowsHide: true,
  })
  const [exitCode, stdout, stderr] = await Promise.all([
    processHandle.exited,
    new Response(processHandle.stdout).text(),
    new Response(processHandle.stderr).text(),
  ])
  if (exitCode !== 0) throw new Error(`Config mutation child failed (${exitCode}): ${stderr}`)
  return JSON.parse(stdout.trim())
}

describe("cross-process runtime config mutation", () => {
  it("preserves distinct-field edits and exposes committed bytes after rename", async () => {
    const results = await Promise.all([
      mutate("showThinking", false, true),
      mutate("diffColors", "theme", "standard"),
    ])
    expect(results.map((result) => result.kind)).toEqual(["committed", "committed"])
    const text = readFileSync(configPath, "utf8")
    expect(text).toContain("show_thinking = true")
    expect(text).toContain('diff_colors = "standard"')
    expect(results.every((result) => result.text?.includes("show_thinking = true") || result.text?.includes('diff_colors = "standard"'))).toBe(true)
  })

  it("allows exactly one mutation for the same expected field value", async () => {
    writeFileSync(configPath, "show_thinking = true\n")
    const results = await Promise.all([
      mutate("showThinking", true, false),
      mutate("showThinking", true, false),
    ])
    expect(results.map((result) => result.kind).sort()).toEqual(["committed", "stale"])
    expect(readFileSync(configPath, "utf8")).toBe("show_thinking = false\n")
  })
})
