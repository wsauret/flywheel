import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { PassThrough } from "node:stream"
import { describe, test } from "node:test"

import { RUNTIME_PROTOCOL_VERSION } from "../../../src/protocol/runtime-liveness.js"
import { createServeStatusReader, encodeServeStartFailure, encodeServeStatusRecord } from "../../../src/protocol/serve-handshake.js"
import { describeStartFailure, judgeServeStatusLine, prepareAccountRuntime } from "./supervisor.js"

/** What public release v0.0.10 prints when it listens. It predates `lane`, so
 *  the strict decoder refuses it; judged by shape first, the extension waited
 *  out its whole start bound and then reported that the service never listened. */
const V0_0_10_LISTENING = '{"flywheel":"serve.listening","pid":4242,"version":"0.0.10","protocolVersion":4}'

describe("judging what the account service prints", () => {
  test("a release below the minimum is named by its version, before its record's shape is judged", () => {
    assert.deepEqual(judgeServeStatusLine(V0_0_10_LISTENING, "0.0.11", createServeStatusReader()), {
      kind: "failed",
      failure: { kind: "version_unsupported", version: "0.0.10", minimum: "0.0.11" },
    })
  })

  test("a release at the minimum that speaks another protocol is named by its protocol, not as a silent service", () => {
    const older = judgeServeStatusLine(V0_0_10_LISTENING, "0.0.4", createServeStatusReader())
    assert.deepEqual(older, {
      kind: "failed",
      failure: { kind: "protocol_unsupported", version: 4, required: RUNTIME_PROTOCOL_VERSION },
    })
    assert.equal(older.kind === "failed" ? describeStartFailure(older.failure) : "", "The running Flywheel is older than this extension. Run `flywheel update` in a terminal.")
    // A runtime newer than this extension names the extension as the part to update.
    const record = { flywheel: "serve.listening", version: "0.0.11", protocolVersion: RUNTIME_PROTOCOL_VERSION + 1, pid: 7, lane: "installed" } as const
    const newer = judgeServeStatusLine(encodeServeStatusRecord(record), "0.0.4", createServeStatusReader())
    assert.deepEqual(newer, {
      kind: "failed",
      failure: { kind: "protocol_unsupported", version: RUNTIME_PROTOCOL_VERSION + 1, required: RUNTIME_PROTOCOL_VERSION },
    })
    assert.equal(newer.kind === "failed" ? describeStartFailure(newer.failure) : "", "This extension is older than the running Flywheel. Update the Flywheel extension.")
  })

  test("a current listening record it cannot read is named in words, with the record left to the log", () => {
    const line = `{"flywheel":"serve.listening","version":"0.0.12","protocolVersion":${RUNTIME_PROTOCOL_VERSION}}`
    const verdict = judgeServeStatusLine(line, "0.0.4", createServeStatusReader())
    assert.deepEqual(verdict, { kind: "failed", failure: { kind: "no_endpoint", detail: "its listening record could not be read" } })
    assert.equal(verdict.kind === "failed" ? describeStartFailure(verdict.failure) : "", "Flywheel did not report where its background service listens (its listening record could not be read).")
  })

  test("an older service already listening is judged the same way", () => {
    const line = V0_0_10_LISTENING.replace("serve.listening", "serve.already-listening")
    assert.equal(judgeServeStatusLine(line, "0.0.11", createServeStatusReader()).kind, "failed")
  })

  test("a current record is the listening service", () => {
    const record = { flywheel: "serve.listening", version: "0.0.11", protocolVersion: RUNTIME_PROTOCOL_VERSION, pid: 7, lane: "installed" } as const
    assert.deepEqual(judgeServeStatusLine(encodeServeStatusRecord(record), "0.0.4", createServeStatusReader()), { kind: "listening", status: record })
  })

  test("a current version whose record cannot be read is a failure, not a wait", () => {
    const line = JSON.stringify({ flywheel: "serve.listening", version: "0.0.11", protocolVersion: RUNTIME_PROTOCOL_VERSION, pid: 7, lane: "elsewhere" })
    assert.equal(judgeServeStatusLine(line, "0.0.4", createServeStatusReader()).kind, "failed")
  })

  test("a startup failure is reported with its error", () => {
    assert.deepEqual(judgeServeStatusLine(encodeServeStatusRecord({ flywheel: "serve.startup.failed", error: "no disk" }), "0.0.4", createServeStatusReader()), {
      kind: "failed",
      failure: { kind: "startup_failed", error: "no disk" },
    })
  })

  // `flywheel kill` clears neither refusal, so the editor names the remedy
  // that works, in the words every client uses.
  test("a start that the lane's own directory refused is reported with the remedy for that refusal", () => {
    const refusal = { kind: "address-access", path: "/Users/me/.flywheel/serve/serve.sock", code: "EACCES" } as const
    const readStatus = createServeStatusReader()
    const [refused, failed] = encodeServeStartFailure("the account service address answered EACCES to a connection", refusal).trimEnd().split("\n")
    assert.deepEqual(judgeServeStatusLine(refused ?? "", "0.0.4", readStatus), { kind: "pending" })
    const verdict = judgeServeStatusLine(failed ?? "", "0.0.4", readStatus)
    assert.deepEqual(verdict, { kind: "failed", failure: { kind: "startup_failed", error: "the account service address answered EACCES to a connection", refusal } })
    assert.equal(
      verdict.kind === "failed" ? describeStartFailure(verdict.failure) : "",
      "Flywheel's background service could not start: its address refused this user's connection (EACCES). Fix the permissions of `/Users/me/.flywheel/serve/serve.sock` so that you can connect to it, or remove the file. Flywheel can start after that.",
    )
  })

  test("a start's step is shown and other output is not an answer yet", () => {
    assert.deepEqual(judgeServeStatusLine(encodeServeStatusRecord({ flywheel: "serve.startup.phase", label: "Opening" }), "0.0.4", createServeStatusReader()), { kind: "phase", label: "Opening" })
    assert.deepEqual(judgeServeStatusLine("plain text", "0.0.4", createServeStatusReader()), { kind: "pending" })
  })
})

/** A started `serve` command the test finishes by hand: what it prints, then how it exits. */
// oxlint-disable-next-line unicorn/prefer-event-target -- boundary: it stands in for a ChildProcess, which is a Node EventEmitter
class FakeServe extends EventEmitter {
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  unref(): void {}
  kill(): boolean { return true }

  finish(exitCode: number | null, stdout: readonly string[], stderr: readonly string[] = []): void {
    for (const line of stdout) this.stdout.write(line.endsWith("\n") ? line : `${line}\n`)
    for (const line of stderr) this.stderr.write(`${line}\n`)
    this.stdout.end()
    this.stderr.end()
    setImmediate(() => this.emit("close", exitCode))
  }
}

const LISTENING = encodeServeStatusRecord({ flywheel: "serve.listening", version: "0.0.11", protocolVersion: RUNTIME_PROTOCOL_VERSION, pid: 7, lane: "installed" })

/** Every line the supervisor logs, with the level it logged it at. */
function recordingLog() {
  const lines: { readonly level: "debug" | "info" | "warn" | "error"; readonly line: string }[] = []
  return {
    lines,
    log: {
      debug: (line: string) => { lines.push({ level: "debug", line }) },
      info: (line: string) => { lines.push({ level: "info", line }) },
      warn: (line: string) => { lines.push({ level: "warn", line }) },
      error: (line: string) => { lines.push({ level: "error", line }) },
    },
  }
}

async function startWith(answers: readonly ((child: FakeServe) => void)[], options: { readonly phases?: string[]; readonly log?: ReturnType<typeof recordingLog>["log"]; readonly projectRoot?: string } = {}) {
  const accountHome = mkdtempSync(join(tmpdir(), "flywheel-supervisor-"))
  mkdirSync(join(accountHome, ".flywheel", "serve"), { recursive: true })
  writeFileSync(join(accountHome, ".flywheel", "serve", "serve.token"), "token\n")
  const spawned: (readonly string[])[] = []
  try {
    const result = await prepareAccountRuntime({
      executable: "/installed/flywheel",
      projectRoot: options.projectRoot ?? accountHome,
      accountHome,
      minimumVersion: "0.0.4",
      probe: async () => "0.0.11",
      onPhase: (label) => { options.phases?.push(label) },
      ...(options.log === undefined ? {} : { log: options.log }),
      spawnProcess: (_command, args) => {
        const child = new FakeServe()
        const answer = answers[spawned.length]
        spawned.push(args)
        answer?.(child)
        return child
      },
    })
    return { result, spawned }
  } finally {
    rmSync(accountHome, { recursive: true, force: true })
  }
}

describe("starting the account service from the editor", () => {
  test("asks the executable to find or start the service, so a registered service is started by its service manager", async () => {
    const { result, spawned } = await startWith([(child) => child.finish(0, [LISTENING])])
    assert.equal(result.ok && result.service.pid, 7)
    assert.deepEqual(spawned, [["serve", "ensure"]])
  })

  test("waits for the find-or-start's own answer however long it takes, showing each step it reports", async () => {
    const phases: string[] = []
    const phase = encodeServeStatusRecord({ flywheel: "serve.startup.phase", label: "Starting account service" })
    // The start waits out a service manager's restart delay, and the
    // extension adds no bound of its own.
    const { result, spawned } = await startWith([(child) => {
      child.stdout.write(`${phase}\n`)
      setTimeout(() => child.finish(0, [LISTENING]), 60)
    }], { phases })
    assert.equal(result.ok && result.service.pid, 7)
    assert.deepEqual(phases, ["Starting account service"])
    assert.deepEqual(spawned, [["serve", "ensure"]])
  })

  test("names a project folder that does not exist before it runs anything", async () => {
    const projectRoot = join(tmpdir(), "flywheel-supervisor-missing-project")
    const { result, spawned } = await startWith([(child) => child.finish(0, [LISTENING])], { projectRoot })
    assert.deepEqual(result, { ok: false, failure: { kind: "project_root_missing", projectRoot } })
    assert.equal(!result.ok && describeStartFailure(result.failure), `The project folder ${projectRoot} does not exist. Fix flywheel.projectRoot, or clear it to use the open folder.`)
    assert.deepEqual(spawned, [])
  })

  test("reports a failed find-or-start with its own reason and starts nothing else", async () => {
    const failed = encodeServeStatusRecord({ flywheel: "serve.startup.failed", error: "the registered account service did not start listening within 65 seconds" })
    const { result, spawned } = await startWith([(child) => child.finish(1, [failed])])
    assert.deepEqual(result, { ok: false, failure: { kind: "startup_failed", error: "the registered account service did not start listening within 65 seconds" } })
    assert.deepEqual(spawned, [["serve", "ensure"]])
  })
})

describe("the editor's log of the account service start", () => {
  const record = (type: string, message: string) => JSON.stringify({ ts: 1, type, payload: { service: "process-supervisor", message } })

  test("names each run of the find-or-start and the service that answered it", async () => {
    const { log, lines } = recordingLog()
    await startWith([(child) => child.finish(0, [LISTENING])], { log })
    assert.deepEqual(lines, [
      { level: "info", line: "running /installed/flywheel serve ensure" },
      { level: "info", line: `serve ensure: the account service is listening: pid 7, lane installed, version 0.0.11, protocol ${RUNTIME_PROTOCOL_VERSION}` },
    ])
  })

  test("names the reason a run failed", async () => {
    const { log, lines } = recordingLog()
    const failed = encodeServeStatusRecord({ flywheel: "serve.startup.failed", error: "the registered account service did not start listening within 65 seconds" })
    await startWith([(child) => child.finish(1, [failed])], { log })
    assert.deepEqual(lines.at(-1), { level: "error", line: "serve ensure failed: The Flywheel runtime could not start: the registered account service did not start listening within 65 seconds" })
  })

  test("logs what the command writes on stderr as plain words at the record's own level, below the default level for its routine records", async () => {
    const { log, lines } = recordingLog()
    await startWith([(child) => {
      child.stderr.write(`${record("log.info", "launcher scope closing")}\n`)
      child.stderr.write(`${record("log.warn", "the login home could not be read")}\n`)
      child.stderr.write(`${record("log.error", "the account store is unreadable")}\n`)
      child.stderr.write("flywheel: plain words\n")
      setImmediate(() => child.finish(0, [LISTENING]))
    }], { log })
    const stderr = lines.filter((entry) => !entry.line.startsWith("running ") && !entry.line.startsWith("serve ensure"))
    assert.deepEqual(stderr, [
      { level: "debug", line: "launcher scope closing" },
      { level: "warn", line: "the login home could not be read" },
      { level: "error", line: "the account store is unreadable" },
      { level: "info", line: "flywheel: plain words" },
    ])
  })

  test("names an older release's refusal of serve ensure in its own words, not its record", async () => {
    const { log, lines } = recordingLog()
    const { result } = await startWith([(child) => child.finish(1, [], [JSON.stringify({ ts: 1, type: "log.error", payload: { service: "default", message: "Unknown serve option: ensure" } })])], { log })
    assert.equal(!result.ok && describeStartFailure(result.failure), "The Flywheel runtime exited with code 1.\nUnknown serve option: ensure")
    assert.ok(lines.every((entry) => !entry.line.includes("{")), JSON.stringify(lines))
  })
})
