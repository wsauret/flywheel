/** The installed and dev lanes share one browser token file per project, and
 *  both can start the same project at once. The race that matters is between
 *  processes, so every start here is a real process. */

import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const MODULE = join(import.meta.dir, "..", "..", "..", "..", "src", "orchestration", "app-service", "web-serving", "token-auth.ts")
const created: string[] = []
afterEach(() => { for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true }) })

/** Reads a child's whole stdout, and resolves `ready` at its first line, or at
 *  its end when the child exits before it announces itself. */
function readOutput(stream: ReadableStream<Uint8Array>) {
  const ready = Promise.withResolvers<void>()
  const text = (async () => {
    const decoder = new TextDecoder()
    let output = ""
    for await (const chunk of stream) {
      output += decoder.decode(chunk, { stream: true })
      if (output.includes("\n")) ready.resolve()
    }
    ready.resolve()
    return output + decoder.decode()
  })()
  return { ready: ready.promise, text }
}

test("starts racing for the first token all adopt the one that was published", async () => {
  // A read-then-write let each start write its own token, so one lane
  // rejected the link the file named. The window between the read and the
  // write is tiny, so every process announces that it has loaded the module,
  // spins on one barrier file that the test creates only after all of them
  // announced, and then races over many fresh files.
  const dir = mkdtempSync(join(tmpdir(), "fw-web-token-race-"))
  created.push(dir)
  const barrier = join(dir, "go")
  const FILES = 200
  const script = [
    `import { existsSync } from "node:fs"`,
    `import { loadOrCreateToken } from ${JSON.stringify(MODULE)}`,
    `process.stdout.write("ready\\n")`,
    `while (!existsSync(${JSON.stringify(barrier)})) {}`,
    `const tokens = []`,
    `for (let i = 0; i < ${FILES}; i++) tokens.push(await loadOrCreateToken(${JSON.stringify(dir)} + "/p" + i + ".web-token"))`,
    `process.stdout.write(JSON.stringify(tokens))`,
  ].join("\n")
  const starts = Array.from({ length: 6 }, () => Bun.spawn([process.execPath, "-e", script], { stdout: "pipe", stderr: "pipe", windowsHide: true }))
  const outputs = starts.map((start) => readOutput(start.stdout))
  await Promise.all(outputs.map((output) => output.ready))
  writeFileSync(barrier, "")
  const texts = await Promise.all(outputs.map((output) => output.text))
  expect(await Promise.all(starts.map((start) => start.exited))).toEqual(starts.map(() => 0))
  const perProcess: string[][] = texts.map((text) => JSON.parse(text.slice(text.indexOf("\n") + 1)))
  const disagreements = Array.from({ length: FILES }, (_, i) => i)
    .filter((i) => new Set(perProcess.map((tokens) => tokens[i])).size !== 1 || readFileSync(join(dir, `p${i}.web-token`), "utf8") !== `${perProcess[0]?.[i]}\n`)
  expect(disagreements).toEqual([])
  expect(readdirSync(dir).filter((name) => name !== "go" && !name.endsWith(".web-token"))).toEqual([])
})
