import { buildMemoryHostFixture } from "../../app/budget-render-test-loader.js"

let loaded: Promise<typeof import("./stats-render-fixture.js")> | undefined

export function loadStatsRenderFixture(): Promise<typeof import("./stats-render-fixture.js")> {
  loaded ??= buildMemoryHostFixture(new URL("stats-render-fixture.tsx", import.meta.url))
  return loaded
}
