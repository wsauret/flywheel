import assert from "node:assert/strict"
import type { SpawnOptions } from "node:child_process"
import { EventEmitter } from "node:events"
import { existsSync, readFileSync } from "node:fs"
import { PassThrough } from "node:stream"
import { describe, test } from "node:test"

import { describeInstallFailure, installFlywheel, type InstallOptions } from "./bootstrap-install.js"

const LAUNCHER = "/home/a/.local/bin/flywheel"
const SCRIPT = "#!/usr/bin/env sh\necho installing\n"
const UNIX_URL = "https://github.com/wsauret/flywheel/releases/latest/download/install.sh"

/** A started installer the test finishes by hand: what it prints, then how it
 *  exits. Its script is read at spawn, before the runner removes it. */
// oxlint-disable-next-line unicorn/prefer-event-target -- boundary: it stands in for a ChildProcess, which is a Node EventEmitter
class FakeInstaller extends EventEmitter {
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()

  finish(exitCode: number | null, stdout: readonly string[] = [], stderr: readonly string[] = []): void {
    for (const line of stdout) this.stdout.write(`${line}\n`)
    for (const line of stderr) this.stderr.write(`${line}\n`)
    this.stdout.end()
    this.stderr.end()
    setImmediate(() => this.emit("close", exitCode))
  }
}

interface Spawned {
  readonly command: string
  readonly args: readonly string[]
  readonly options: SpawnOptions
  readonly script: string
}

const installs = (installer: FakeInstaller): void => {
  installer.finish(0, ["Downloading flywheel-linux-x64.tar.gz v0.0.12", "Installed flywheel 0.0.12"])
}

function scenario({ run = installs, ...overrides }: Partial<InstallOptions> & { readonly run?: (child: FakeInstaller) => void } = {}) {
  const spawned: Spawned[] = []
  const output: string[] = []
  const probed: string[] = []
  const fetched: string[] = []
  const options: InstallOptions = {
    platform: "linux",
    repository: "wsauret/flywheel",
    launcher: LAUNCHER,
    minimumVersion: "0.0.4",
    env: { HOME: "/home/a" },
    onOutput: (line) => output.push(line),
    fetch: async (url) => {
      fetched.push(url)
      return new Response(SCRIPT)
    },
    spawnProcess: (command, args, spawnOptions) => {
      const child = new FakeInstaller()
      spawned.push({ command, args, options: spawnOptions, script: readFileSync(args.at(-1)!, "utf8") })
      run(child)
      return child
    },
    probe: async (executable) => {
      probed.push(executable)
      return "0.0.12"
    },
    ...overrides,
  }
  return { options, spawned, output, probed, fetched }
}

describe("installing Flywheel through the bootstrap installer", () => {
  test("runs the fetched installer with stdin closed, then checks the launcher it placed", async () => {
    const { options, spawned, output, probed, fetched } = scenario()
    const result = await installFlywheel(options)

    assert.deepEqual(result, { ok: true, version: "0.0.12" })
    assert.deepEqual(fetched, [UNIX_URL])
    assert.equal(spawned.length, 1)
    const [run] = spawned
    assert.equal(run!.command, "sh")
    assert.equal(run!.script, SCRIPT)
    assert.deepEqual(run!.options.stdio, ["ignore", "pipe", "pipe"])
    assert.equal(run!.options.windowsHide, true)
    assert.deepEqual(run!.options.env, { HOME: "/home/a" })
    assert.deepEqual(output, ["Downloading flywheel-linux-x64.tar.gz v0.0.12", "Installed flywheel 0.0.12"])
    assert.deepEqual(probed, [LAUNCHER])
    // The script is the installer's to run once; nothing of it is left behind.
    assert.equal(existsSync(run!.args.at(-1)!), false)
  })

  test("runs the PowerShell installer on Windows", async () => {
    const { options, spawned, fetched } = scenario({ platform: "win32", launcher: String.raw`C:\L\Flywheel\bin\flywheel.exe` })
    const result = await installFlywheel(options)

    assert.ok(result.ok)
    assert.deepEqual(fetched, ["https://github.com/wsauret/flywheel/releases/latest/download/install.ps1"])
    assert.equal(spawned[0]!.command, "powershell")
    assert.deepEqual(spawned[0]!.args.slice(0, -1), ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File"])
    assert.match(spawned[0]!.args.at(-1)!, /install\.ps1$/)
  })

  test("reports a failed installer with its exit code and last lines, and checks nothing", async () => {
    const { options, probed } = scenario({
      run: (installer) => installer.finish(1, ["Downloading flywheel-linux-x64.tar.gz v0.0.12"], ["flywheel install: checksum mismatch for flywheel-linux-x64.tar.gz"]),
    })
    const result = await installFlywheel(options)

    assert.ok(!result.ok)
    assert.equal(result.failure.kind, "installer_failed")
    assert.deepEqual(probed, [])
    const message = describeInstallFailure(result.failure)
    assert.match(message, /install\.sh/)
    assert.ok(message.includes(UNIX_URL))
    assert.ok(message.includes("checksum mismatch for flywheel-linux-x64.tar.gz"))
  })

  test("reports an installer that could not start", async () => {
    const { options } = scenario({ run: (installer) => setImmediate(() => installer.emit("error", new Error("spawn sh ENOENT"))) })
    const result = await installFlywheel(options)

    assert.ok(!result.ok)
    assert.equal(result.failure.kind, "installer_failed")
    assert.ok(describeInstallFailure(result.failure).includes("spawn sh ENOENT"))
  })

  test("gives up on a download whose bytes stop arriving", async () => {
    const { options, spawned } = scenario({
      stallMs: 5,
      fetch: async (_url, init) => new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("#!/usr/bin/env sh\n"))
          init.signal.addEventListener("abort", () => controller.error(new DOMException("aborted", "AbortError")))
        },
      })),
    })
    const result = await installFlywheel(options)

    assert.ok(!result.ok)
    assert.equal(result.failure.kind, "fetch_failed")
    assert.equal(spawned.length, 0)
  })

  test("refuses an answer that is not the installer", async () => {
    const { options, spawned } = scenario({ fetch: async () => new Response("Not Found", { status: 404 }) })
    const result = await installFlywheel(options)

    assert.ok(!result.ok)
    assert.equal(result.failure.kind, "fetch_failed")
    assert.ok(describeInstallFailure(result.failure).includes("404"))
    assert.equal(spawned.length, 0)
  })

  test("reports a launcher that does not answer after a successful install", async () => {
    const { options } = scenario({ probe: async () => undefined })
    const result = await installFlywheel(options)

    assert.ok(!result.ok)
    assert.equal(result.failure.kind, "launcher_silent")
    const message = describeInstallFailure(result.failure)
    assert.ok(message.includes(LAUNCHER))
    assert.ok(message.includes("Installed flywheel 0.0.12"))
  })

  test("reports an installed release older than this extension needs", async () => {
    const { options } = scenario({ minimumVersion: "0.0.13" })
    const result = await installFlywheel(options)

    assert.ok(!result.ok)
    assert.deepEqual(result.failure, { kind: "launcher_too_old", url: UNIX_URL, launcher: LAUNCHER, version: "0.0.12", minimum: "0.0.13" })
    assert.ok(describeInstallFailure(result.failure).includes("0.0.13"))
  })
})
