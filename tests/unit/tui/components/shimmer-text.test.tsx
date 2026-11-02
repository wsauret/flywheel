/** @jsxImportSource @opentui/solid */

import { describe, expect, it, spyOn } from "bun:test"
import { getTimelineEngine, Timeline } from "@opentui/core"
import { testRender, useRenderer } from "@opentui/solid"
import { ShimmerText } from "@tui/components/shimmer-text.js"
import { ThemeProvider, useTheme } from "@tui/context/theme.js"
import { contrastRatio } from "@tui/context/theme/color-contrast.js"

describe("ShimmerText", () => {
  for (const mode of ["dark", "light"] as const) {
    for (const supplied of [false, true]) {
      it(`keeps ${supplied ? "worker status" : "default info"} readable throughout the ${mode} pulse`, async () => {
        let register: ReturnType<typeof spyOn<ReturnType<typeof getTimelineEngine>, "register">> | undefined
        let engine: ReturnType<typeof getTimelineEngine> | undefined
        let context: ReturnType<typeof useTheme> | undefined
        function Harness() {
          engine = getTimelineEngine(useRenderer())
          register = spyOn(engine, "register")
          context = useTheme()
          return <box backgroundColor={context.theme.background}>
            <ShimmerText text="Worker" color={supplied ? context.theme.textMuted : undefined} />
          </box>
        }
        const result = await testRender(() => <ThemeProvider mode={mode} themeName="github"><Harness /></ThemeProvider>, { width: 20, height: 2 })
        try {
          await result.renderOnce()
          const timeline = register?.mock.calls.map(([value]) => value).find((value) => value instanceof Timeline)
          if (!timeline || !context || !engine) throw new Error("Shimmer timeline and theme were not mounted")
          engine.unregister(timeline)
          timeline.restart()
          const base = supplied ? context.theme.textMuted : context.theme.info
          const colors = []
          for (const delta of [0, 50, 50, 50, 50]) {
            timeline.update(delta)
            await result.renderOnce()
            const span = result.captureSpans().lines[0]?.spans.find((value) => value.text.startsWith("W"))
            if (!span) throw new Error("Worker text was not rendered")
            colors.push(span.fg)
            expect(span.fg.a).toBe(1)
            expect(contrastRatio(span.fg, context.theme.background)).toBeGreaterThanOrEqual(4.5)
          }
          expect(colors[0]?.equals(base)).toBe(true)
          expect(colors[4]?.equals(base)).toBe(true)
          expect(colors[1]?.equals(colors[3]!)).toBe(true)
          expect(colors[1]?.equals(base)).toBe(false)
          expect(contrastRatio(colors[2]!, context.theme.background)).toBeGreaterThan(contrastRatio(colors[1]!, context.theme.background))
        } finally {
          result.renderer.destroy()
          register?.mockRestore()
        }
      })
    }
  }
})
