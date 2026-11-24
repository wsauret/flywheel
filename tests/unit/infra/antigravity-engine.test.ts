import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs"
import { delimiter, dirname, join } from "node:path"

import PIN from "../../../scripts/antigravity-engine-pin.json" with { type: "json" }
import { antigravityEnginePath, requireQualifiedAntigravityVersion, separatedAntigravityEnvironment, type AntigravityEngineHost } from "../../../src/infra/antigravity-engine.js"
import { antigravityEngineFile, buildPlatformArch, checkoutAntigravityEngine } from "../../../src/infra/native-assets.js"
import type { OwnedCommandRunner } from "../../../src/infra/owned-command.js"
import { enterSourceSnapshot } from "../../../src/infra/distribution/source-snapshot.js"
import { temporaryDirectories } from "../../helpers/directories.js"
import { snapshotFixture } from "../../helpers/source-snapshot-fixture.js"

type EngineModule = typeof import("../../../src/infra/antigravity-engine.js")

const ENGINE_MODULE = "src/infra/antigravity-engine.ts"
const LOGIN = "/scratch/auth/antigravity/login-1"
const temporaryDirectory = temporaryDirectories()

function write(root: string, files: ReadonlyMap<string, string>): void {
  for (const [path, content] of files) {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), content)
  }
}

/** The pin of an `agy` whose bytes are `text`. */
function pinOf(text: string) {
  return { size: Buffer.byteLength(text), sha256: createHash("sha256").update(text).digest("hex") }
}

function host(platform: NodeJS.Platform, hostEnvironment: AntigravityEngineHost["hostEnvironment"]): AntigravityEngineHost {
  return { account: { home: "/Users/person", user: "person" }, platform, hostEnvironment }
}

describe("the environment of every Antigravity engine", () => {
  test("names only the login's private home, and inherits no Google credential, home, XDG folder, or session bus of the host", () => {
    const environment = separatedAntigravityEnvironment(host("linux", {
      PATH: "/usr/bin:/bin",
      SHELL: "/bin/zsh",
      HOME: "/Users/person",
      USER: "someone-else",
      GEMINI_API_KEY: "host-key",
      GEMINI_HOME: "/Users/person/.gemini",
      GOOGLE_GEMINI_BASE_URL: "http://host.invalid",
      GOOGLE_APPLICATION_CREDENTIALS: "/Users/person/adc.json",
      GOOGLE_CLOUD_PROJECT: "project",
      AGY_ACCOUNT: "person@example.com",
      DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus",
      XDG_CONFIG_HOME: "/x",
      LANG: "en_US.UTF-8",
      SystemRoot: "C:\\Windows",
    }), LOGIN)
    const home = join(LOGIN, "home")

    expect(environment).toEqual({
      PATH: "/usr/bin:/bin",
      SHELL: "/bin/zsh",
      HOME: home,
      USERPROFILE: home,
      APPDATA: join(home, "AppData", "Roaming"),
      LOCALAPPDATA: join(home, "AppData", "Local"),
      XDG_CONFIG_HOME: join(home, ".config"),
      XDG_DATA_HOME: join(home, ".local", "share"),
      XDG_CACHE_HOME: join(home, ".cache"),
      XDG_STATE_HOME: join(home, ".local", "state"),
      TMPDIR: join(home, "tmp"),
      TEMP: join(home, "tmp"),
      TMP: join(home, "tmp"),
      GEMINI_HOME: join(home, ".gemini"),
      USER: "person",
      AGY_CLI_DISABLE_AUTO_UPDATE: "true",
    })
  })

  test("inherits on Windows the variables that cmd.exe needs to run the gate hook", () => {
    const environment = separatedAntigravityEnvironment(host("win32", { PATH: "C:\\Windows\\system32", SystemRoot: "C:\\Windows", ComSpec: "C:\\Windows\\system32\\cmd.exe", PATHEXT: ".COM;.EXE", USERPROFILE: "C:\\Users\\person", APPDATA: "C:\\Users\\person\\AppData\\Roaming" }), LOGIN)

    expect(environment).toMatchObject({ SystemRoot: "C:\\Windows", ComSpec: "C:\\Windows\\system32\\cmd.exe", PATHEXT: ".COM;.EXE", USERPROFILE: join(LOGIN, "home"), APPDATA: join(LOGIN, "home", "AppData", "Roaming"), LOCALAPPDATA: join(LOGIN, "home", "AppData", "Local") })
  })

  test("adds the fake host's variables only through the test environment", () => {
    const environment = separatedAntigravityEnvironment({ ...host("linux", { PATH: "/usr/bin" }), testEnvironment: { GOOGLE_GEMINI_BASE_URL: "http://127.0.0.1:8791", GEMINI_API_KEY: "fake" } }, LOGIN)

    expect(environment).toMatchObject({ GOOGLE_GEMINI_BASE_URL: "http://127.0.0.1:8791", GEMINI_API_KEY: "fake", HOME: join(LOGIN, "home") })
  })
})

describe("the Antigravity engine that Flywheel runs", () => {
  test("is the build's own in a compiled build, never one on the PATH", () => {
    const native = temporaryDirectory("flywheel-antigravity-native-")
    const onPath = temporaryDirectory("flywheel-antigravity-path-")
    writeFileSync(join(onPath, "agy"), "#!/bin/sh\n")
    chmodSync(join(onPath, "agy"), 0o755)
    const inherited = { native: process.env.FLYWHEEL_NATIVE_DIR, path: process.env.PATH }
    process.env.FLYWHEEL_NATIVE_DIR = native
    process.env.PATH = `${onPath}${delimiter}${inherited.path ?? ""}`
    try {
      expect(antigravityEnginePath("/opt/flywheel/flywheel")).toBe(join(native, antigravityEngineFile(buildPlatformArch())))
    } finally {
      if (inherited.native === undefined) delete process.env.FLYWHEEL_NATIVE_DIR
      else process.env.FLYWHEEL_NATIVE_DIR = inherited.native
      process.env.PATH = inherited.path
    }
  })

  test("is refused in a source run whose checkout has no prepared copy, naming the prepare command", async () => {
    const fixture = snapshotFixture(temporaryDirectory("flywheel-antigravity-unprepared-"), [ENGINE_MODULE])
    const { antigravityEnginePath: enginePath } = await fixture.importFromSnapshot<EngineModule>(ENGINE_MODULE)

    expect(() => enginePath()).toThrow(`no verified Antigravity CLI ${PIN.version} for ${buildPlatformArch()}. Run \`bun run engine:antigravity:prepare\``)
  })

  test("in a dev service is the copy its snapshot pinned, so a prepare that replaces the checkout's copy leaves the service on its own", async () => {
    const root = temporaryDirectory("flywheel-antigravity-snapshot-")
    const engine = checkoutAntigravityEngine(PIN.version, buildPlatformArch())
    write(join(root, "checkout"), new Map([["package.json", "{}\n"], ["bun.lock", "{}\n"], ["src/cli/index.ts", "export {}\n"], [engine, "agy first"]]))
    const entry = await enterSourceSnapshot(realpathSync(join(root, "checkout")), { antigravityPin: pinOf("agy first") })
    if (entry.kind !== "created") throw new Error(`the entry did not create a snapshot: ${entry.kind}`)
    const fixture = snapshotFixture(root, [ENGINE_MODULE], { digest: entry.digest })
    const { antigravityEnginePath: enginePath } = await fixture.importFromSnapshot<EngineModule>(ENGINE_MODULE)
    const pinnedInode = statSync(join(fixture.checkout, engine)).ino

    expect(enginePath()).toBe(join(entry.root, engine))
    // The prepare step renames a new verified copy onto the checkout's path.
    rmSync(join(fixture.checkout, engine))
    write(fixture.checkout, new Map([[engine, "agy second"]]))
    expect(statSync(enginePath()).ino).toBe(pinnedInode)
    expect(readFileSync(enginePath(), "utf8")).toBe("agy first")
  })

  test("in a dev service whose snapshot pinned none is refused, also once the checkout holds one, and the next entry makes a snapshot that pins it", async () => {
    const root = temporaryDirectory("flywheel-antigravity-unpinned-")
    const engine = checkoutAntigravityEngine(PIN.version, buildPlatformArch())
    const checkout = join(root, "checkout")
    write(checkout, new Map([["package.json", "{}\n"], ["bun.lock", "{}\n"], ["src/cli/index.ts", "export {}\n"]]))
    const seams = { antigravityPin: pinOf("agy prepared") }
    const before = await enterSourceSnapshot(realpathSync(checkout), seams)
    if (before.kind !== "created") throw new Error(`the entry did not create a snapshot: ${before.kind}`)
    const fixture = snapshotFixture(root, [ENGINE_MODULE], { digest: before.digest })
    const { antigravityEnginePath: enginePath } = await fixture.importFromSnapshot<EngineModule>(ENGINE_MODULE)

    write(fixture.checkout, new Map([[engine, "agy prepared"]]))

    expect(() => enginePath()).toThrow(`The source snapshot that this Flywheel runs from has no verified Antigravity CLI ${PIN.version} for ${buildPlatformArch()}. Run \`bun run engine:antigravity:prepare\` in the checkout, and start Flywheel again.`)
    const after = await enterSourceSnapshot(fixture.checkout, seams)
    if (after.kind !== "created") throw new Error(`the entry after the prepare did not create a snapshot: ${after.kind}`)
    expect(after.digest).not.toBe(before.digest)
    expect(readFileSync(join(after.root, engine), "utf8")).toBe("agy prepared")
  })

  test("is never pinned by a snapshot when the checkout's copy is not the pinned bytes", async () => {
    const root = temporaryDirectory("flywheel-antigravity-unverified-")
    const engine = checkoutAntigravityEngine(PIN.version, buildPlatformArch())
    const source = new Map([["package.json", "{}\n"], ["bun.lock", "{}\n"], ["src/cli/index.ts", "export {}\n"]])
    write(join(root, "absent"), source)
    write(join(root, "unverified"), new Map([...source, [engine, "agy tampered"]]))
    const seams = { antigravityPin: pinOf("agy prepared") }

    const absent = await enterSourceSnapshot(realpathSync(join(root, "absent")), seams)
    const unverified = await enterSourceSnapshot(realpathSync(join(root, "unverified")), seams)

    if (absent.kind !== "created" || unverified.kind !== "created") throw new Error(`the entries did not create snapshots: ${absent.kind}, ${unverified.kind}`)
    expect(unverified.digest).toBe(absent.digest)
    expect(existsSync(join(unverified.root, engine))).toBe(false)
  })
})

describe("the version check of the Antigravity engine", () => {
  const answering = (stdout: string): OwnedCommandRunner => async () => ({ exitCode: 0, stdout, stdoutBytes: new TextEncoder().encode(stdout), stderr: "", timedOut: false })

  test("accepts the qualified version, as `agy --version` prints it", async () => {
    expect(await requireQualifiedAntigravityVersion("/engine/agy", answering(`${PIN.version}\n`))).toBe(PIN.version)
  })

  test("refuses another version, naming both", async () => {
    await expect(requireQualifiedAntigravityVersion("/engine/agy", answering("1.5.13\n"))).rejects.toThrow(`The Antigravity CLI at /engine/agy is version 1.5.13, and Flywheel is qualified only on version ${PIN.version}.`)
  })
})
