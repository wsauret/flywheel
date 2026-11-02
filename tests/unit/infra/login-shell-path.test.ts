import { describe, expect, test } from "bun:test"

import { createLoginShellPath, parseLoginShellEnv, resolveLoginShell } from "../../../src/infra/login-shell-path.js"
import type { OwnedCommandOptions, OwnedCommandResult, OwnedCommandRunner } from "../../../src/infra/owned-command.js"

const PROBED_PATH = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"

function bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text)
}

function commandResult(overrides: Partial<OwnedCommandResult> & { readonly stdoutText?: string }): OwnedCommandResult {
  const stdoutBytes = bytes(overrides.stdoutText ?? "")
  return { exitCode: 0, stdoutBytes, stdout: overrides.stdoutText ?? "", stderr: "", timedOut: false, ...overrides }
}

/** A runner that records each launch and answers with one scripted result. */
function scriptedRunner(result: OwnedCommandResult | Error) {
  const launches: { readonly command: readonly string[]; readonly options: OwnedCommandOptions | undefined }[] = []
  const run: OwnedCommandRunner = async (command, options) => {
    launches.push({ command, options })
    if (result instanceof Error) throw result
    return result
  }
  return { run, launches }
}

interface LogRecord {
  readonly message: string
  readonly fields: { readonly [name: string]: unknown } | undefined
}

function recordingLog() {
  const warnings: LogRecord[] = []
  const infos: LogRecord[] = []
  const debugs: LogRecord[] = []
  return {
    warnings, infos, debugs,
    log: {
      warn(message: string, fields?: LogRecord["fields"]) { warnings.push({ message, fields }) },
      info(message: string, fields?: LogRecord["fields"]) { infos.push({ message, fields }) },
      debug(message: string, fields?: LogRecord["fields"]) { debugs.push({ message, fields }) },
    },
  }
}

function holder(options: { readonly platform?: NodeJS.Platform; readonly env?: { [name: string]: string | undefined }; readonly log?: ReturnType<typeof recordingLog>["log"] } = {}) {
  return createLoginShellPath({
    platform: options.platform ?? "darwin",
    env: () => options.env ?? { SHELL: "/bin/zsh", HOME: "/elsewhere", ZDOTDIR: "/poisoned", PATH: "/usr/bin:/bin" },
    home: () => "/Users/person",
    registeredShells: () => new Set(["/bin/sh", "/bin/zsh"]),
    log: options.log ?? recordingLog().log,
  })
}

describe("login shell environment parse", () => {
  test("ignores text a startup file prints before the NUL frame", () => {
    const env = parseLoginShellEnv(bytes(`Welcome back!\nPATH=/banner/bin\n\0PATH=${PROBED_PATH}\0HOME=/Users/person\0`))

    expect(env.get("PATH")).toBe(PROBED_PATH)
    expect(env.get("HOME")).toBe("/Users/person")
    expect([...env.keys()].some((key) => key.includes("Welcome"))).toBe(false)
  })

  test("reads nothing when the output has no NUL frame", () => {
    expect(parseLoginShellEnv(bytes(`PATH=${PROBED_PATH}\nHOME=/Users/person\n`)).size).toBe(0)
  })
})

describe("login shell selection", () => {
  const registered = new Set(["/bin/sh", "/bin/zsh", "/opt/homebrew/bin/fish"])

  test("uses $SHELL only when /etc/shells lists it", () => {
    expect(resolveLoginShell("/bin/zsh", registered)).toBe("/bin/zsh")
    expect(resolveLoginShell("/opt/homebrew/bin/fish", registered)).toBe("/opt/homebrew/bin/fish")
    expect(resolveLoginShell("/scratch/evil-shell", registered)).toBe("/bin/sh")
  })

  test("falls back to /bin/sh for a relative, non-normalized, missing, or unverifiable shell", () => {
    expect(resolveLoginShell("zsh", registered)).toBe("/bin/sh")
    expect(resolveLoginShell("/bin/../bin/zsh", registered)).toBe("/bin/sh")
    expect(resolveLoginShell(undefined, registered)).toBe("/bin/sh")
    expect(resolveLoginShell("/bin/zsh", null)).toBe("/bin/sh")
  })
})

describe("login shell PATH probe", () => {
  test("runs the trusted login shell with the real home and no ZDOTDIR, and adopts its PATH", async () => {
    const { run, launches } = scriptedRunner(commandResult({ stdoutText: `motd\0PATH=${PROBED_PATH}\0` }))
    const path = holder()

    expect(path.current()).toBeUndefined()
    await path.probe(run)

    expect(path.current()).toBe(PROBED_PATH)
    expect(launches).toHaveLength(1)
    expect(launches[0]?.command).toEqual(["/bin/zsh", "-l", "-c", "printf '\\0'; env -0"])
    expect(launches[0]?.options?.env?.HOME).toBe("/Users/person")
    expect(launches[0]?.options?.env && Object.hasOwn(launches[0].options.env, "ZDOTDIR")).toBe(false)
  })

  test("a probe that times out leaves the process PATH in use, runs again when asked, and warns once for a repeated reason", async () => {
    const records = recordingLog()
    const { run, launches } = scriptedRunner(commandResult({ exitCode: null, timedOut: true, stdoutText: `\0PATH=${PROBED_PATH}` }))
    const path = holder({ log: records.log })

    await path.probe(run)
    await path.probe(run)

    expect(path.current()).toBeUndefined()
    expect(launches).toHaveLength(2)
    expect(records.warnings).toHaveLength(1)
    expect(records.debugs).toHaveLength(1)
    expect(records.warnings[0]?.fields?.shell).toBe("/bin/zsh")
    expect(String(records.warnings[0]?.fields?.reason)).toContain("15")
    expect(JSON.stringify(records.warnings)).not.toContain(PROBED_PATH)
  })

  test("a probe that times out after the PATH entry is complete adopts that PATH and records the timeout", async () => {
    // A startup file left a background job running, so the container outlived
    // the shell that had already printed its whole environment.
    const records = recordingLog()
    const { run } = scriptedRunner(commandResult({ exitCode: 0, timedOut: true, stdoutText: `motd\0PATH=${PROBED_PATH}\0HOME=/Users/pers` }))
    const path = holder({ log: records.log })

    await path.probe(run)

    expect(path.current()).toBe(PROBED_PATH)
    expect(records.warnings).toHaveLength(0)
    expect(records.infos).toHaveLength(1)
    expect(records.infos[0]?.fields?.timedOut).toBe(true)
    expect(JSON.stringify(records.infos)).not.toContain(PROBED_PATH)
  })

  test("a login shell that fails or prints no PATH leaves the process PATH in use", async () => {
    for (const result of [
      commandResult({ exitCode: 1, stdoutText: `\0PATH=${PROBED_PATH}\0` }),
      commandResult({ stdoutText: "no frame here" }),
      new Error("guardian unavailable"),
    ]) {
      const records = recordingLog()
      const path = holder({ log: records.log })
      await path.probe(scriptedRunner(result).run)
      expect(path.current()).toBeUndefined()
      expect(records.warnings).toHaveLength(1)
    }
  })

  test("a request after a failure probes again with the first probe's runner and adopts the PATH; once known, it runs nothing", async () => {
    let answer = commandResult({ exitCode: 1 })
    const launches: (readonly string[])[] = []
    const run: OwnedCommandRunner = async (command) => { launches.push(command); return answer }
    const path = holder()

    path.request()
    expect(launches).toHaveLength(0)
    await path.probe(run)
    expect(path.current()).toBeUndefined()

    answer = commandResult({ stdoutText: `\0PATH=${PROBED_PATH}\0` })
    const heard: string[] = []
    const found = new Promise<void>((resolve) => path.watch((value) => { heard.push(value); resolve() }))
    path.request()
    await found
    path.request()
    await path.probe(run)

    expect(heard).toEqual([PROBED_PATH])
    expect(launches).toHaveLength(2)
  })

  test("Windows keeps its own PATH and runs no login shell", async () => {
    const records = recordingLog()
    const { run, launches } = scriptedRunner(commandResult({ stdoutText: `\0PATH=${PROBED_PATH}\0` }))
    const path = holder({ platform: "win32", log: records.log })

    await path.probe(run)

    expect(launches).toHaveLength(0)
    expect(path.current()).toBeUndefined()
    expect(records.warnings).toHaveLength(0)
  })

  test("a watcher hears the PATH at once when it is known and later when it arrives", async () => {
    const path = holder()
    const heard: string[] = []
    const stop = path.watch((value) => heard.push(value))
    path.adopt(PROBED_PATH)
    path.watch((value) => heard.push(`late:${value}`))
    stop()
    path.adopt("/second/bin")

    expect(heard).toEqual([PROBED_PATH, `late:${PROBED_PATH}`, "late:/second/bin"])
    expect(path.current()).toBe("/second/bin")
  })
})
