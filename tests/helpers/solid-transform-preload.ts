import { dirname, join } from "node:path"
import { plugin, type OnLoadArgs, type OnLoadCallback, type PluginBuilder } from "bun"
import { keepingStackTraceSettings } from "../../src/tui/solid-transform-stack-trace.js"
import { cachedSolidTransform, compilerIdentity, installedPackage } from "./solid-transform-cache.js"

// Registers the OpenTUI Solid JSX transform, as `@opentui/solid/preload` does,
// with its output cached across test processes. The OpenTUI plugin stays the
// only compiler: it is built on the first cache miss, because building it
// loads Babel.

/** The files the OpenTUI plugin compiles: first-party JSX. */
const SOLID_SOURCE = /^(?!.*[/\\]node_modules[/\\]).*\.[cm]?[jt]sx(?:[?#].*)?$/
/** Solid's server builds, which a process without the browser condition, such
 *  as a bare `bun test <file>`, resolves for `solid-js`, `solid-js/store`, and
 *  `solid-js/web`. Group 1 names the subpath, whose client build is
 *  `<subpath>.js`; the root's client build is `solid.js`. */
const SOLID_SERVER_BUILD = /[/\\]node_modules[/\\]solid-js[/\\](?:(store|web)[/\\])?dist[/\\]server\.js(?:[?#].*)?$/

/** Loads a Solid server build as a re-export of its client build, so a process
 *  without the browser condition renders as the suite does. Every entry point
 *  needs it: `@solid-primitives/keyed` reads `isServer` from `solid-js/web`, and
 *  the server value `true` makes `<Key>` map its list once and never update it.
 *  A re-export, not a copy of the client source as the OpenTUI plugin loads it,
 *  keeps one Solid runtime: OpenTUI imports `solid-js/dist/solid.js` directly,
 *  and a copy at the server path is a second runtime whose owners and contexts
 *  never meet OpenTUI's. */
function solidClientBuild(args: OnLoadArgs) {
  const path = args.path.replace(/[?#].*$/, "")
  const client = `${SOLID_SERVER_BUILD.exec(path)?.[1] ?? "solid"}.js`
  return { contents: `export * from ${JSON.stringify(join(dirname(path), client))}`, loader: "js" as const }
}

const OPENTUI_SOLID = installedPackage("@opentui/solid", import.meta.dir)
const SOLID_PRESET = installedPackage("babel-preset-solid", OPENTUI_SOLID.directory)
// Each package resolves from the package that loads it, so a nested copy
// under the OpenTUI plugin counts, not the copy at the repository root.
const COMPILER = `opentui-solid-plugin ${compilerIdentity([
  OPENTUI_SOLID,
  SOLID_PRESET,
  installedPackage("babel-plugin-jsx-dom-expressions", SOLID_PRESET.directory),
  installedPackage("@babel/core", OPENTUI_SOLID.directory),
  installedPackage("@babel/preset-typescript", OPENTUI_SOLID.directory),
  installedPackage("babel-plugin-module-resolver", OPENTUI_SOLID.directory),
])}`

interface UpstreamHandler {
  readonly filter: RegExp
  readonly load: OnLoadCallback
}

let upstream: Promise<readonly UpstreamHandler[]> | undefined

async function loadUpstream(args: OnLoadArgs) {
  upstream ??= import("@opentui/solid/bun-plugin").then(({ createSolidTransformPlugin }) => {
    const handlers: UpstreamHandler[] = []
    // The OpenTUI plugin only declares load handlers, so a builder that
    // records them is all its setup needs.
    const unexpected = (hook: string) => (): never => { throw new Error(`the OpenTUI Solid plugin declared an unexpected ${hook} hook`) }
    const recorder: PluginBuilder = {
      onLoad(constraints, load) {
        handlers.push({ filter: constraints.filter, load: keepingStackTraceSettings(load) })
        return recorder
      },
      onStart: unexpected("onStart"),
      onEnd: unexpected("onEnd"),
      onBeforeParse: unexpected("onBeforeParse"),
      onResolve: unexpected("onResolve"),
      module: unexpected("module"),
      config: { entrypoints: [], plugins: [] },
    }
    void createSolidTransformPlugin().setup(recorder)
    return handlers
  })
  const handler = (await upstream).find(({ filter }) => filter.test(args.path))
  if (handler === undefined) throw new Error(`the OpenTUI Solid plugin has no load handler for ${args.path}`)
  return await handler.load(args)
}

plugin({
  name: "cached-opentui-solid-transform",
  setup(build) {
    build.onLoad({ filter: SOLID_SERVER_BUILD }, solidClientBuild)
    build.onLoad({ filter: SOLID_SOURCE }, async (args) => {
      const path = args.path.replace(/[?#].*$/, "")
      const contents = await cachedSolidTransform({
        compiler: COMPILER,
        path,
        source: await Bun.file(path).text(),
        compile: async () => {
          const compiled = await loadUpstream(args)
          if (!compiled || !("contents" in compiled) || typeof compiled.contents !== "string") throw new Error(`the OpenTUI Solid plugin returned no source for ${path}`)
          return compiled.contents
        },
      })
      return { contents, loader: "js" }
    })
  },
})
