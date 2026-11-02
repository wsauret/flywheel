import { fileURLToPath } from "node:url"
import type { OnLoadArgs, OnLoadResult } from "bun"
import { cachedSolidTransform, compilerIdentity, installedPackage } from "../../../tests/helpers/solid-transform-cache.js"

/** How a test fixture renders the client's Solid components.
 *
 *  - `memory-host`: Solid's universal renderer over the in-memory host in
 *    `render-ownership-host-fixture.ts`, so a test drives live reactivity.
 *  - `ssr`: Solid's server renderer, so a test reads the markup as a string. */
export type SolidFixtureRenderer = "memory-host" | "ssr"

const MEMORY_HOST = fileURLToPath(new URL("../app/render-ownership-host-fixture.ts", import.meta.url))

const SOLID_PRESET = {
  "memory-host": { generate: "universal", moduleName: MEMORY_HOST },
  ssr: { generate: "ssr", hydratable: false },
} as const satisfies { readonly [renderer in SolidFixtureRenderer]: object }

const SOLID_PRESET_PACKAGE = installedPackage("babel-preset-solid", import.meta.dir)
const COMPILER = compilerIdentity([
  installedPackage("@babel/core", import.meta.dir),
  SOLID_PRESET_PACKAGE,
  installedPackage("babel-plugin-jsx-dom-expressions", SOLID_PRESET_PACKAGE.directory),
  installedPackage("@babel/preset-typescript", import.meta.dir),
])

/** Compile one fixture source for `renderer`. Babel loads only when the shared
 *  test transform cache does not hold the output yet. */
export async function transformSolidFixture(source: string, path: string, renderer: SolidFixtureRenderer): Promise<string> {
  const preset = SOLID_PRESET[renderer]
  return await cachedSolidTransform({
    compiler: `${COMPILER} ${JSON.stringify(preset)}`,
    path,
    source,
    compile: async () => {
      const { transformAsync } = await import("@babel/core")
      const transformed = await transformAsync(source, {
        filename: path,
        configFile: false,
        babelrc: false,
        presets: [["babel-preset-solid", preset], ["@babel/preset-typescript"]],
      })
      if (typeof transformed?.code !== "string") throw new Error(`Solid ${renderer} transform failed for ${path}`)
      return transformed.code
    },
  })
}

/** A `Bun.build` load handler for `.tsx` files that compiles each one for `renderer`. */
export function loadSolidFixture(renderer: SolidFixtureRenderer): (args: OnLoadArgs) => Promise<OnLoadResult> {
  return async ({ path }) => ({ contents: await transformSolidFixture(await Bun.file(path).text(), path, renderer), loader: "js" })
}
