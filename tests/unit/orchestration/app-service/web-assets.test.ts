import { describe, expect, test } from "bun:test"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"

import { createControlUiAssets } from "../../../../src/orchestration/app-service/web-serving/control-ui-assets"
import { serveControlUiStatic } from "../../../../src/orchestration/app-service/web-serving/control-ui-static"
import { temporaryDirectories } from "../../../helpers/directories"
import { snapshotFixture } from "../../../helpers/source-snapshot-fixture"

const ok = { exitCode: 0, stdoutBytes: new Uint8Array(), stdout: "", stderr: "", timedOut: false }
const identity = "d".repeat(64)
const clientJson = `${JSON.stringify({ identity })}\n`

describe("Control UI asset lifecycle", () => {
  const temporaryDirectory = temporaryDirectories()

  test("a source checkout answers preparing at once, builds once, and resolves", async () => {
    const root = temporaryDirectory("flywheel-web-assets-")
    const webview = join(root, "webview")
    await mkdir(webview)
    const launches: Array<{ command: readonly string[]; options: unknown }> = []
    const built = Promise.withResolvers<void>()
    const assets = createControlUiAssets({
      execPath: "/usr/bin/bun",
      sourceRoot: root,
      run: async (command, options) => {
        launches.push({ command, options })
        await built.promise
        await mkdir(join(webview, "dist"))
        await writeFile(join(webview, "dist", "client.json"), clientJson)
        return ok
      },
    })

    const settled = assets.settle()
    expect(assets.prepare()).toEqual({ kind: "preparing" })
    expect(assets.prepare()).toEqual({ kind: "preparing" })
    expect(launches).toEqual([{
      command: ["/usr/bin/bun", "run", "--cwd", webview, "build"],
      options: { timeoutMs: 600_000 },
    }])

    built.resolve()
    await expect(settled).resolves.toEqual({ kind: "resolved", root: join(webview, "dist"), identity })
    expect(assets.prepare()).toEqual({ kind: "resolved", root: join(webview, "dist"), identity })
  })

  test("a dev service builds and serves its snapshot's client after the checkout changes", async () => {
    const fixture = snapshotFixture(temporaryDirectory("flywheel-snapshot-assets-"), ["src/orchestration/app-service/web-serving/control-ui-assets.ts"])
    const snapshotted = await fixture.importFromSnapshot<typeof import("../../../../src/orchestration/app-service/web-serving/control-ui-assets")>("src/orchestration/app-service/web-serving/control-ui-assets.ts")
    for (const root of [fixture.snapshot, fixture.checkout]) {
      await mkdir(join(root, "webview"), { recursive: true })
      await writeFile(join(root, "webview", "client.ts"), "original client")
    }
    await writeFile(join(fixture.checkout, "webview", "client.ts"), "incompatible client")
    const launches: Array<readonly string[]> = []
    const assets = snapshotted.createControlUiAssets({
      execPath: "/usr/bin/bun",
      run: async (command) => {
        launches.push(command)
        const webview = command[3]!
        await mkdir(join(webview, "dist", "phone"), { recursive: true })
        await writeFile(join(webview, "dist", "phone", "webview.js"), await readFile(join(webview, "client.ts")))
        await writeFile(join(webview, "dist", "client.json"), clientJson)
        return ok
      },
    })

    const state = await assets.settle()
    expect(launches).toEqual([["/usr/bin/bun", "run", "--cwd", join(fixture.snapshot, "webview"), "build"]])
    await mkdir(join(fixture.checkout, "webview", "dist", "phone"), { recursive: true })
    await writeFile(join(fixture.checkout, "webview", "dist", "phone", "webview.js"), "new build")
    const response = await serveControlUiStatic(new Request(`http://localhost/client/${identity}/phone/webview.js`), state, "/project")
    expect(response.status).toBe(200)
    expect(await response.text()).toBe("original client")
  })

  test("a failed build is terminal and carries the build's own words", async () => {
    const root = temporaryDirectory("flywheel-web-assets-")
    await mkdir(join(root, "webview"))
    const assets = createControlUiAssets({
      execPath: "/usr/bin/bun",
      sourceRoot: root,
      run: async () => ({ ...ok, exitCode: 1, stderr: "error: cannot resolve solid-js\n" }),
    })

    assets.prepare()
    while (assets.prepare().kind === "preparing") await Bun.sleep(1)
    expect(assets.prepare()).toEqual({ kind: "failed", error: "error: cannot resolve solid-js" })
  })

  test("installed assets resolve only beside the executable and never build", async () => {
    let launched = false
    const root = temporaryDirectory("flywheel-installed-assets-")
    const executable = join(root, "flywheel")
    await mkdir(join(root, "webview"))
    await writeFile(join(root, "webview", "client.json"), clientJson)
    const assets = createControlUiAssets({
      execPath: executable,
      sourceRoot: "/ignored",
      run: async () => {
        launched = true
        throw new Error("must not launch")
      },
    })

    assets.prepare()
    while (assets.prepare().kind === "preparing") await Bun.sleep(1)
    expect(assets.prepare()).toEqual({ kind: "resolved", root: join(root, "webview"), identity })
    expect(launched).toBe(false)
  })

  test("an installed binary without the client fails and names the missing directory", async () => {
    const root = temporaryDirectory("flywheel-installed-assets-")
    const assets = createControlUiAssets({
      execPath: join(root, "flywheel"),
      sourceRoot: "/ignored",
      run: async () => { throw new Error("must not launch") },
    })

    assets.prepare()
    while (assets.prepare().kind === "preparing") await Bun.sleep(1)
    expect(assets.prepare()).toEqual({ kind: "failed", error: `the web client is not at ${join(root, "webview")}` })

    // A browser open that still finds no client says why.
    await expect(assets.openable()).rejects.toThrow(`The web client is unavailable: the web client is not at ${join(root, "webview")}`)
    // A read or an attach keeps the failure; a browser open looks again,
    // so restored files serve without a restart.
    await mkdir(join(root, "webview"))
    await writeFile(join(root, "webview", "client.json"), clientJson)
    expect(assets.prepare().kind).toBe("failed")
    expect((await assets.settle()).kind).toBe("failed")
    await assets.openable()
    expect(assets.prepare()).toEqual({ kind: "resolved", root: join(root, "webview"), identity })
  })

  test("a client.json that is not one fails and names the file", async () => {
    for (const text of ["{ not json", '{"identity":"short"}', '["d"]']) {
      const root = temporaryDirectory("flywheel-installed-assets-")
      await mkdir(join(root, "webview"))
      await writeFile(join(root, "webview", "client.json"), text)
      const assets = createControlUiAssets({
        execPath: join(root, "flywheel"),
        sourceRoot: "/ignored",
        run: async () => { throw new Error("must not launch") },
      })

      await expect(assets.settle()).resolves.toEqual({ kind: "failed", error: `the web client identity at ${join(root, "webview", "client.json")} is malformed` })
    }
  })
})
