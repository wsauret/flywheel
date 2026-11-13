import { Schema } from "effect"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { logFileWriter } from "../src/infra/debug-log.ts"
import { LOG_MARKER } from "./lead-store-compat/fixture.ts"

/** Proves that a store that the lead-agent branch wrote opens and runs a turn
 *  under the main checkout's code on disk, and reports what that code does
 *  with a config in which the branch turned `lead` off.
 *
 *  Run: `bun --env-file=.env.test run scripts/lead-store-compat.ts [main checkout]`
 *  The main checkout defaults to the checkout that owns this worktree. The
 *  script only reads it: it runs no build, no install, and no git command
 *  that writes. Four steps run in their own processes over one temporary
 *  project, which is removed at the end, also after a failure:
 *  1. branch: the lead routes one person message to a new chat.
 *  2. main: lists the chats and runs one turn in the started chat.
 *  3. branch: turns `lead` off through the settings mutation.
 *  4. main: the same as step 2 over the config of step 3.
 *  It prints every warning and error record of each main step, marks the ones
 *  about a fact that the main code does not know, and exits 1 when a step fails. */

const branchRoot = path.resolve(import.meta.dir, "..")
const stepDirectory = path.join(import.meta.dir, "lead-store-compat")

async function capture(command: readonly string[], cwd: string): Promise<string> {
  const child = Bun.spawn([...command], { cwd, stdout: "pipe", stderr: "inherit", windowsHide: true })
  const [text, code] = await Promise.all([new Response(child.stdout).text(), child.exited])
  if (code !== 0) throw new Error(`${command.join(" ")} exited ${code}`)
  return text.trim()
}

/** Runs one step in its own Bun process with its output on this terminal. Answers the exit code and the pid, which
 *  names the step's log files. */
async function step(script: string, args: readonly string[], cwd: string, home: string): Promise<{ readonly code: number; readonly pid: number }> {
  const child = Bun.spawn([process.execPath, path.join(stepDirectory, script), ...args], {
    cwd,
    env: { ...process.env, HOME: home },
    stdout: "inherit",
    stderr: "inherit",
    windowsHide: true,
  })
  return { code: await child.exited, pid: child.pid }
}

const LogRecordSchema = Schema.Struct({ type: Schema.String })

const UNKNOWN_FACT = /unknown fact|not registered|lead\.(chat|request|result)\./i

/** Each warning and error record that the process `pid` wrote under `directory`, as its line. */
function warningsOf(directory: string, pid: number): readonly string[] {
  if (!fs.existsSync(directory)) return []
  return fs.readdirSync(directory, { recursive: true, encoding: "utf8" })
    .filter((file) => file.endsWith(".jsonl") && logFileWriter(path.basename(file))?.pid === String(pid))
    .flatMap((file) => fs.readFileSync(path.join(directory, file), "utf8").split("\n"))
    .filter((line) => line.trim() && ["log.warn", "log.error"].includes(Schema.decodeUnknownSync(LogRecordSchema)(JSON.parse(line)).type))
}

/** Prints the warnings of one main step and the count of those about an unknown fact. Answers false when the step's
 *  own marker warning is missing, so a count of zero never stands for a log that the scan did not find. */
function reportWarnings(label: string, lines: readonly string[]): boolean {
  const found = lines.some((line) => line.includes(LOG_MARKER))
  const product = lines.filter((line) => !line.includes(LOG_MARKER))
  const unknownFacts = product.filter((line) => UNKNOWN_FACT.test(line))
  for (const line of product) console.log(`${UNKNOWN_FACT.test(line) ? "unknown-fact " : ""}${label} warning: ${line}`)
  console.log(`${label}: ${unknownFacts.length} unknown-fact warnings; ${product.length} warning and error records in all; log ${found ? "found" : "NOT FOUND"}`)
  return found
}

const mainRoot = process.argv[2] ?? path.dirname(await capture(["git", "rev-parse", "--path-format=absolute", "--git-common-dir"], branchRoot))
const mainHead = await capture(["git", "-C", mainRoot, "rev-parse", "HEAD"], branchRoot)
const mainChanges = (await capture(["git", "-C", mainRoot, "--no-optional-locks", "status", "--porcelain"], branchRoot)).split("\n").filter(Boolean).length
console.log(`main checkout ${mainRoot} at ${mainHead}, ${mainChanges === 0 ? "clean" : `${mainChanges} uncommitted paths`}`)

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "flywheel-lead-store-compat-"))
const home = path.join(tempRoot, "home")
const failures: string[] = []
try {
  const steps = [
    { label: "branch store", script: "write-with-branch.ts", args: [tempRoot, "store"], cwd: branchRoot },
    { label: "main lead-on", script: "read-with-main.ts", args: [tempRoot, mainRoot, "lead-on"], cwd: mainRoot },
    { label: "branch lead-off", script: "write-with-branch.ts", args: [tempRoot, "lead-off"], cwd: branchRoot },
    { label: "main lead-off", script: "read-with-main.ts", args: [tempRoot, mainRoot, "lead-off"], cwd: mainRoot },
  ] as const
  for (const { label, script, args, cwd } of steps) {
    console.log(`\n=== ${label}`)
    if (label === "main lead-off") console.log(`config that the branch wrote: ${fs.readFileSync(path.join(home, ".flywheel", "flywheel.toml"), "utf8").split("\n").find((line) => line.startsWith("disabled_modules")) ?? "(no disabled_modules line)"}`)
    const { code, pid } = await step(script, args, cwd, home)
    if (script === "read-with-main.ts" && !reportWarnings(label, [...warningsOf(path.join(tempRoot, "logs"), pid), ...warningsOf(path.join(tempRoot, "project", ".flywheel"), pid)])) failures.push(`${label}: its log was not found, so its warnings are unknown`)
    if (code !== 0) {
      failures.push(code === 2 ? `${label}: the main checkout refused to open the project; its REFUSED line above names the refusal` : `${label} exited ${code}`)
      break
    }
  }
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true })
}

console.log(failures.length === 0 ? "\nPASS: the main checkout opened the branch's store and config and ran a turn in the started chat" : `\nFAIL: ${failures.join("; ")}`)
process.exit(failures.length === 0 ? 0 : 1)
