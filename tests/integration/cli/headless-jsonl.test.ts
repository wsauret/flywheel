import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

// A source run, as `bin/flywheel` starts it.
const ENTRY = join(import.meta.dir, "..", "..", "..", "scripts", "dev.ts")
const MODEL = "fixture-model"
const TASK_MESSAGE = "fixture task complete"

type FixtureMode = "success" | "failure"
interface JsonRecord { [key: string]: unknown }

let home = ""
let projectRoot = ""
let mode: FixtureMode = "success"
let server: ReturnType<typeof Bun.serve>

function sse(data: JsonRecord): string {
  return `data: ${JSON.stringify(data)}\n\n`
}

function successfulResponse(): Response {
  const delta = { content: TASK_MESSAGE }
  const stream = [
    sse({ id: "fixture", object: "chat.completion.chunk", model: MODEL, choices: [{ index: 0, delta, finish_reason: null }] }),
    sse({ id: "fixture", object: "chat.completion.chunk", model: MODEL, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }),
    sse({ id: "fixture", object: "chat.completion.chunk", model: MODEL, choices: [], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } }),
    "data: [DONE]\n\n",
  ].join("")
  return new Response(stream, { headers: { "content-type": "text/event-stream" } })
}

beforeEach(() => {
  // Outside the repository: a project inside a git checkout makes Flywheel add
  // an ignore rule for its state to the shared `.git/info/exclude` on every run.
  // Canonical, as Flywheel reports the project root (macOS /var is /private/var).
  home = realpathSync(mkdtempSync(join(tmpdir(), "flywheel-headless-jsonl-")))
  projectRoot = join(home, "project")
  mkdirSync(projectRoot, { recursive: true })
  mkdirSync(join(home, ".flywheel", "auth", "profiles", "default"), { recursive: true })
  for (const directory of [join(home, ".flywheel"), join(home, ".flywheel", "auth"), join(home, ".flywheel", "auth", "profiles"), join(home, ".flywheel", "auth", "profiles", "default")]) chmodSync(directory, 0o700)
  mode = "success"
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      if (new URL(request.url).pathname.endsWith("/models")) {
        return Response.json({ object: "list", data: [{ id: MODEL, object: "model", created: 0, owned_by: "fixture" }] })
      }
      if (mode === "failure") return Response.json({ error: { message: "fixture provider failure" } }, { status: 400 })
      return successfulResponse()
    },
  })
  const baseUrl = `http://127.0.0.1:${server.port}/v1`
  writeFileSync(join(home, ".flywheel", "flywheel.toml"), [
    "[custom_providers.fixture]",
    `base_url = ${JSON.stringify(baseUrl)}`,
    `models = [${JSON.stringify(MODEL)}]`,
    "",
  ].join("\n"))
  writeFileSync(join(home, ".flywheel", "auth", "profiles", "default", "auth.json"), JSON.stringify({ fixture: { type: "api_key", key: "fixture-placeholder-key" } }), { mode: 0o600 })
})

afterEach(() => {
  server.stop(true)
  rmSync(home, { recursive: true, force: true })
})

async function runEntry(args: readonly string[], entry = ENTRY): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const child = Bun.spawn([process.execPath, "--conditions=browser", entry, ...args], {
    cwd: projectRoot,
    env: { PATH: Bun.env.PATH, HOME: home, FLYWHEEL_PROJECT_ROOT: projectRoot, FLYWHEEL_AUTH_PROFILE: "default", FLYWHEEL_DISABLE_UPDATE_CHECK: "1" },
    stdout: "pipe",
    stderr: "pipe",
    windowsHide: true,
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  return { stdout, stderr, exitCode }
}

function jsonlRecords(stdout: string): JsonRecord[] {
  expect(stdout.endsWith("\n")).toBe(true)
  return stdout.trimEnd().split("\n").map((line) => JSON.parse(line))
}

function expectTerminalContract(records: JsonRecord[]): JsonRecord {
  const terminals = records.filter((record) => record.kind === "chat.terminal")
  expect(terminals).toHaveLength(1)
  expect(records.at(-1)).toBe(terminals[0])
  expect(records.every((record) => record.version === 4)).toBe(true)
  expect(typeof terminals[0]?.sessionId).toBe("string")
  for (const record of records.slice(0, -1)) expect(record).not.toHaveProperty("finalMessage")
  return terminals[0] ?? {}
}

async function expectProviderFailure(args: readonly string[]): Promise<void> {
  mode = "failure"
  const result = await runEntry(args)
  const records = jsonlRecords(result.stdout)
  const terminal = expectTerminalContract(records)
  expect(result.exitCode).not.toBe(0)
  expect(terminal.completed).toBe(false)
  expect(result.stderr.length).toBeGreaterThan(0)
  expect(result.stdout).not.toContain(result.stderr.trim())
}

describe("headless process output contracts", () => {
  it("publishes a successful task JSONL stream with one last terminal", async () => {
    const result = await runEntry(["--headless", "--task", "complete fixture", "--jsonl"])
    const terminal = expectTerminalContract(jsonlRecords(result.stdout))
    expect(result.exitCode).toBe(0)
    expect(terminal).toMatchObject({ completed: true, finalMessage: TASK_MESSAGE, projectRoot })
  })

  it("keeps task provider failure diagnostics off JSONL stdout", async () => {
    await expectProviderFailure(["--headless", "--task", "fail fixture", "--jsonl"])
  })

  it("preserves exact legacy task stdout ordering and bytes", async () => {
    const result = await runEntry(["--headless", "--task", "complete fixture"])
    const [message, summaryLine, trailing] = result.stdout.split("\n")
    const summary = JSON.parse(summaryLine ?? "")
    expect(result.exitCode).toBe(0)
    expect(message).toBe(TASK_MESSAGE)
    expect(summary).not.toHaveProperty("finalMessage")
    expect(result.stdout).toBe(`${TASK_MESSAGE}\n${JSON.stringify(summary)}\n`)
    expect(trailing).toBe("")
  })

  it("rejects JSONL without headless before bootstrap and keeps stdout empty", async () => {
    const result = await runEntry(["--jsonl"])
    expect(result.exitCode).toBe(1)
    expect(result.stdout).toBe("")
    expect(result.stderr).toContain("--jsonl is only valid with --headless")
  })
})
