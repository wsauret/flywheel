import { afterAll, afterEach, describe, expect, it } from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { Schema } from "effect"

import { scanDebugLogFiles } from "../../../src/infra/debug-log.js"
import { Log } from "../../../src/infra/log.js"

const TMP_ROOT = path.join(os.tmpdir(), `flywheel-log-redaction-${process.pid}`)
const roots = new Set<string>()

function makeTmpDir(): string {
  const dir = path.join(TMP_ROOT, crypto.randomUUID())
  roots.add(dir)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

afterEach(async () => {
  await Log.closeGlobal()
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true })
  roots.clear()
})

afterAll(() => {
  fs.rmSync(TMP_ROOT, { recursive: true, force: true })
})

describe("Log secret redaction", () => {
  it("scrubs known secret patterns from stream records and diagnostic stderr output", async () => {
    const baseDir = makeTmpDir()
    const secret = "sk-proj-abcdefghijklmnopqrstuvwxyz123456"
    await Log.init({ dir: baseDir })

    Log.create({ service: "redaction-test" }).error("auth failed", { apiKey: secret })
    await Log.closeGlobal()

    const logDir = path.join(baseDir, ".flywheel", "log")
    const file = fs.readdirSync(logDir).find((f) => f.endsWith(".jsonl"))!
    const text = fs.readFileSync(path.join(logDir, file), "utf8")
    expect(text).not.toContain(secret)

    const [record] = [...scanDebugLogFiles([path.join(logDir, file)], { types: ["log.error"] })]
    expect(record!.payload).toMatchObject({ message: "auth failed", apiKey: "[redacted secret]" })

    const chunks: string[] = []
    const originalWrite = process.stderr.write
    const captureWrite: typeof process.stderr.write = (chunk: string | Uint8Array) => { chunks.push(String(chunk)); return true }
    process.stderr.write = captureWrite
    try {
      Log.writeDiagnosticStderr(`OPENAI_API_KEY=${secret}\n`)
    } finally {
      process.stderr.write = originalWrite
    }
    expect(chunks.join("")).toBe("OPENAI_API_KEY=[redacted secret]\n")
  })
})

describe("Log record content", () => {
  it("writes an error nested in a field object as structured detail, never its schema tree", async () => {
    const baseDir = makeTmpDir()
    await Log.init({ dir: baseDir })
    let decodeError: unknown
    try {
      Schema.decodeUnknownSync(Schema.Struct({ kind: Schema.Literal("tool") }))({ kind: "workflowRoster" })
    } catch (error) {
      decodeError = error
    }

    Log.create({ service: "content-test" }).info("read failed; retrying", { detail: { attempt: 1, cause: decodeError } })
    await Log.closeGlobal()

    const logDir = path.join(baseDir, ".flywheel", "log")
    const file = path.join(logDir, fs.readdirSync(logDir).find((f) => f.endsWith(".jsonl"))!)
    const text = fs.readFileSync(file, "utf8")
    expect(text).not.toContain("\"issue\"")
    expect(text).not.toContain("\"ast\"")
    const [record] = [...scanDebugLogFiles([file], { types: ["log.info"] })]
    expect(record!.payload).toMatchObject({ detail: { attempt: 1, cause: { kind: "error", name: "SchemaError" } } })
  })
})
