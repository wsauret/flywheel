import { afterEach, describe, expect, mock, spyOn, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Script } from "node:vm"
import { HOST_CONTRACT_VERSION } from "../../../src/protocol/client/host-contract.js"
import { buildWebview, buildWebviewHosts, clientIdentity, localManifest, renderLocalIndex, solidWebPlugin } from "../../../webview/build.js"
import { buildBootstrapBundles } from "../../../relay/app/build.js"
import { buildExtension } from "../../../vscode/scripts/build.js"

const successfulBuild = {
  success: true,
  logs: [],
  outputs: [],
}

afterEach(() => {
  mock.restore()
})

describe("shared Solid browser build", () => {
  test("builds only the extension host bundle for the editor package", async () => {
    const build = spyOn(Bun, "build").mockResolvedValue(successfulBuild)

    await buildExtension(true)

    expect(build).toHaveBeenCalledTimes(1)
    expect(build.mock.calls[0]?.[0]).toMatchObject({ target: "node", format: "cjs", external: ["vscode"] })
  })

  test("builds every host shell with one artifact policy, staged beside its directory, and writes the identity last", async () => {
    const build = spyOn(Bun, "build").mockResolvedValue(successfulBuild)
    const outdir = await mkdtemp(join(tmpdir(), "flywheel-hosts-build-"))
    const webviewRoot = join(import.meta.dir, "..", "..", "..", "webview")

    await buildWebviewHosts({ outdir })

    expect(build).toHaveBeenCalledTimes(3)
    for (const [index, host] of ["local", "editor", "phone"].entries()) {
      expect(build.mock.calls[index]?.[0]).toMatchObject({
        entrypoints: [join(webviewRoot, host, "main.tsx")],
        outdir: `${join(outdir, host)}.${process.pid}.tmp`,
        minify: true,
        naming: { entry: "webview.[ext]", asset: "webview.[ext]" },
        sourcemap: "none",
        target: "browser",
        format: "iife",
        plugins: [solidWebPlugin],
      })
    }
    const identity = await clientIdentity(outdir, [])
    expect(JSON.parse(await readFile(join(outdir, "client.json"), "utf8"))).toEqual({ identity })
    const page = await readFile(join(outdir, "local", "index.html"), "utf8")
    expect(page).toContain(`data-client-identity="${identity}"`)
    expect(page).toContain(`data-host-contract="${HOST_CONTRACT_VERSION}"`)
    expect(page).toContain(`href="/client/${identity}/local/webview.css"`)
    expect(page).toContain(`src="/client/${identity}/local/webview.js"`)
    await rm(outdir, { recursive: true, force: true })
  })

  test("emits a bundle that loads as a classic script when a dependency reads import.meta", async () => {
    const root = await mkdtemp(join(tmpdir(), "flywheel-classic-script-"))
    await writeFile(join(root, "entry.ts"), "export const env = globalThis.process?.env ?? import.meta?.env\nconsole.log(env)\n")

    const result = await buildWebview({ entrypoints: [join(root, "entry.ts")], outdir: join(root, "out"), minify: true, naming: "[name].[ext]", sourcemap: "none" })

    expect(result.success).toBe(true)
    const bundle = await result.outputs[0]!.text()
    expect(() => new Script(bundle)).not.toThrow()
    await rm(root, { recursive: true, force: true })
  })

  test("builds only the bootstrap and the service worker for the hosted phone page", async () => {
    const build = spyOn(Bun, "build").mockResolvedValue(successfulBuild)

    await buildBootstrapBundles(true)

    expect(build).toHaveBeenCalledWith({
      entrypoints: [
        join(import.meta.dir, "..", "..", "..", "relay", "app", "bootstrap.ts"),
        join(import.meta.dir, "..", "..", "..", "relay", "app", "sw", "sw.ts"),
      ],
      outdir: join(import.meta.dir, "..", "..", "..", "relay", "app", "dist"),
      minify: true,
      naming: { entry: "[name].[ext]", asset: "[name].[ext]" },
      sourcemap: "linked",
      target: "browser",
      format: "iife",
      define: { "import.meta": "{}" },
      plugins: [solidWebPlugin],
    })
  })

})

describe("client identity", () => {
  test("digests a sorted manifest of path, size, and content digest, and nothing else", async () => {
    const root = await mkdtemp(join(tmpdir(), "flywheel-client-identity-"))
    await mkdir(join(root, "local"))
    await mkdir(join(root, "editor"))
    await writeFile(join(root, "local", "webview.js"), "local script")
    await writeFile(join(root, "editor", "webview.js"), "editor script")
    await writeFile(join(root, "index.html"), "page one")
    const digest = (text: string) => createHash("sha256").update(text).digest("hex")
    const manifest = [
      `editor/webview.js\t${Buffer.byteLength("editor script")}\t${digest("editor script")}`,
      `local/webview.js\t${Buffer.byteLength("local script")}\t${digest("local script")}`,
    ].join("\n")

    const identity = await clientIdentity(root, ["local/webview.js", "editor/webview.js"])
    expect(identity).toBe(digest(manifest))
    expect(await clientIdentity(root, ["editor/webview.js", "local/webview.js"])).toBe(identity)

    await writeFile(join(root, "index.html"), "page two")
    expect(await clientIdentity(root, ["local/webview.js", "editor/webview.js"])).toBe(identity)
    await writeFile(join(root, "local", "webview.js"), "local script!")
    expect(await clientIdentity(root, ["local/webview.js", "editor/webview.js"])).not.toBe(identity)
    await rm(root, { recursive: true, force: true })
  })
})

describe("local webview build", () => {
  test("renders the identity and the host contract into the page", () => {
    const identity = "c".repeat(64)
    const html = renderLocalIndex(
      '<link rel="stylesheet" href="/client/{{identity}}/local/webview.css">\n<script type="module" src="/client/{{identity}}/local/webview.js"></script>\n<div id="root" data-client-identity="{{identity}}" data-host-contract="{{hostContract}}"></div>\n',
      { identity, hostContract: 3 },
    )

    expect(html).toContain(`<div id="root" data-client-identity="${identity}" data-host-contract="3"></div>`)
    expect(html).toContain(`<link rel="stylesheet" href="/client/${identity}/local/webview.css">`)
    expect(html).toContain(`<script type="module" src="/client/${identity}/local/webview.js"></script>`)
    expect(html).not.toContain("{{")
  })

  test("describes the installable page with the brand tile at every size browsers ask for", () => {
    const manifest = localManifest("0.0.8")
    expect(manifest.name).toBe("Flywheel")
    expect(manifest.display).toBe("standalone")
    expect(manifest.start_url).toBe("/")
    expect(manifest.icons.map((icon) => icon.src)).toEqual(["/icon.svg", "/icon-192.png", "/icon-512.png"])
    expect(manifest.description).toContain("0.0.8")
  })
})
