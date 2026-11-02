import type { BuildConfig, BunPlugin } from "bun"
import { transformAsync } from "@babel/core"
import { createHash } from "node:crypto"
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { join, relative } from "node:path"
import sharp from "sharp"

import { brandTileSvg } from "../src/protocol/client/brand.js"
import { HOST_CONTRACT_VERSION } from "../src/protocol/client/host-contract.js"
import { stageLegalPayload } from "../scripts/legal-payload.js"

// Babel loads a preset from its resolved path, so the presets, which ship no
// type declarations, need no import here.
const PRESET_SOLID = Bun.resolveSync("babel-preset-solid", import.meta.dir)
const PRESET_TYPESCRIPT = Bun.resolveSync("@babel/preset-typescript", import.meta.dir)

export interface WebviewBuildOptions {
  readonly entrypoints: BuildConfig["entrypoints"]
  readonly outdir: string
  readonly minify: BuildConfig["minify"]
  readonly naming: BuildConfig["naming"]
  readonly sourcemap: BuildConfig["sourcemap"]
}

/** The host shells the runtime serves from its own build. Each one is the
 *  entry `webview/<host>/main.tsx`, built into `dist/<host>/webview.js` and
 *  `webview.css`: the local page fetches them under the client identity, the
 *  editor loads them from the directory the runtime names, and the phone's
 *  hosted page loads them through the relay, which asks the machine for them
 *  under the same identity. */
export const WEBVIEW_HOSTS = ["local", "editor", "phone"] as const
export type WebviewHost = (typeof WEBVIEW_HOSTS)[number]

/** Compiles TSX with Solid's DOM transform before Bun creates a browser IIFE. */
export const solidWebPlugin: BunPlugin = {
  name: "solid-web",
  setup(build) {
    build.onLoad({ filter: /\.tsx$/ }, async (args) => {
      const source = await Bun.file(args.path).text()
      const result = await transformAsync(source, {
        filename: args.path,
        configFile: false,
        babelrc: false,
        presets: [[PRESET_SOLID, { generate: "dom", hydratable: false }], [PRESET_TYPESCRIPT]],
      })
      if (result?.code == null) throw new Error(`solid transform produced no output for ${args.path}`)
      return { contents: result.code, loader: "js" }
    })
  },
}

/** Builds a Solid browser bundle with artifact policies supplied by its host. */
export function buildWebview(options: WebviewBuildOptions) {
  return Bun.build({
    ...options,
    target: "browser",
    format: "iife",
    plugins: [solidWebPlugin],
  })
}

/** The one identity of a built client: the SHA-256 of a manifest that lists
 *  every bundle file under `root` by path, size, and content digest, sorted by
 *  path. Only the bundles enter it. The page, `client.json`, the manifest, and
 *  the icons either embed the identity or change no behavior, so they stay
 *  out; otherwise the identity could never be written into the page. */
export async function clientIdentity(root: string, bundles: readonly string[]): Promise<string> {
  const rows = await Promise.all([...bundles].sort().map(async (path) => {
    const content = await readFile(join(root, path))
    return `${path}\t${content.byteLength}\t${createHash("sha256").update(content).digest("hex")}`
  }))
  return createHash("sha256").update(rows.join("\n")).digest("hex")
}

/** Fills the local page template: the identity of the client it belongs to,
 *  which names the bundle references too, and the host contract. The
 *  references are root-absolute because the page is served for every session
 *  address, so a relative link would resolve under `/session/`. */
export function renderLocalIndex(template: string, page: { readonly identity: string; readonly hostContract: number }) {
  return template
    .replaceAll("{{identity}}", page.identity)
    .replaceAll("{{hostContract}}", String(page.hostContract))
}

/** The installable identity of the local page: the same name and tile the
 *  phone app and the launcher show. The icon set is the brand tile at the
 *  sizes browsers ask for, drawn from the one SVG in the client core. */
export function localManifest(version: string) {
  return {
    name: "Flywheel",
    short_name: "Flywheel",
    description: `Flywheel ${version}: this project's sessions, in your browser.`,
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: "#1c1b19",
    theme_color: "#1c1b19",
    icons: [
      { src: "/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" },
      { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any maskable" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any maskable" },
    ],
  }
}

/** Writes `content` under `path` in one step: a runtime serving from this
 *  directory never reads a half-written file. */
async function writeWhole(path: string, content: string | Uint8Array): Promise<void> {
  const staging = `${path}.${process.pid}.tmp`
  await writeFile(staging, content)
  await rename(staging, path)
}

/** Builds one host shell into `<outdir>/<host>` and returns the emitted files
 *  relative to `outdir`. Bun emits into a staging directory beside the host
 *  directory and each file is renamed into place whole, so a runtime that is
 *  serving the previous build never hands out a half-written file. */
async function buildHost(webviewRoot: string, outdir: string, host: WebviewHost): Promise<string[]> {
  const hostDir = join(outdir, host)
  const staging = `${hostDir}.${process.pid}.tmp`
  await mkdir(hostDir, { recursive: true })
  await rm(staging, { recursive: true, force: true })

  const result = await buildWebview({
    entrypoints: [join(webviewRoot, host, "main.tsx")],
    outdir: staging,
    minify: true,
    naming: { entry: "webview.[ext]", asset: "webview.[ext]" },
    sourcemap: "none",
  })
  if (!result.success) {
    throw new AggregateError(result.logs, `${host} webview build failed`)
  }
  const emitted: string[] = []
  for (const output of result.outputs) {
    const path = join(hostDir, relative(staging, output.path))
    await rename(output.path, path)
    emitted.push(relative(outdir, path))
  }
  await rm(staging, { recursive: true, force: true })
  return emitted
}

/** Builds every host shell into `webview/dist` and writes the one identity of
 *  the result last, as `client.json`, so a runtime that reads it names a
 *  build whose files are all in place. The directory is never cleared: a
 *  runtime for another project may be serving the previous build from it, so
 *  every file is replaced whole instead. */
export async function buildWebviewHosts(options: { readonly outdir?: string } = {}) {
  const webviewRoot = import.meta.dir
  const repoRoot = join(webviewRoot, "..")
  const outdir = options.outdir ?? join(webviewRoot, "dist")
  await mkdir(outdir, { recursive: true })

  const bundles: string[] = []
  for (const host of WEBVIEW_HOSTS) bundles.push(...await buildHost(webviewRoot, outdir, host))
  const identity = await clientIdentity(outdir, bundles)

  const [template, packageJson] = await Promise.all([
    readFile(join(webviewRoot, "local", "index.html"), "utf8"),
    Bun.file(join(repoRoot, "package.json")).json(),
    stageLegalPayload(repoRoot, outdir),
  ])
  const version: string = packageJson.version
  const png = (size: number) => sharp(Buffer.from(brandTileSvg(size, { corners: "square" }))).png().toBuffer()
  await Promise.all([
    writeWhole(join(outdir, "local", "index.html"), renderLocalIndex(template, { identity, hostContract: HOST_CONTRACT_VERSION })),
    writeWhole(join(outdir, "manifest.webmanifest"), `${JSON.stringify(localManifest(version), null, 2)}\n`),
    writeWhole(join(outdir, "icon.svg"), brandTileSvg(512, { corners: "rounded" })),
    ...[180, 192, 512].map(async (size) => writeWhole(join(outdir, `icon-${size}.png`), await png(size))),
  ])
  await writeWhole(join(outdir, "client.json"), `${JSON.stringify({ identity })}\n`)
}

if (import.meta.main) await buildWebviewHosts()
