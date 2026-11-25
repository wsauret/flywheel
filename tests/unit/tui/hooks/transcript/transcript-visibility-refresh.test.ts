import { describe, expect, it } from "bun:test"
import { createRoot, createSignal } from "solid-js"
import type { RuntimeConfigView } from "../../../../../src/protocol/settings/runtime-config-protocol-types.js"
import { createTranscriptVisibilityRefresh } from "../../../../../src/tui/hooks/transcript/create-transcript-visibility-refresh.js"
import { createOutputTranscriptCache } from "../../../../../src/tui/transcript/transcript-store/create-output-transcript-cache.js"
import { configValues } from "../../modals/settings/_settings-modal-fixtures.js"
import { fakeRuntimeClient, INSTANT_BACKOFF, textBlock } from "../_output-transcript-cache-fixtures.js"

function config(revision: number, showThinking: boolean): RuntimeConfigView {
  return {
    revision,
    values: configValues({ showThinking }),
    status: { kind: "valid" },
    warnings: [],
    diagnostics: [],
  }
}

async function flushEffects(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

describe("transcript visibility refresh", () => {
  it("refreshes thinking only when enabled", async () => {
    await createRoot(async (dispose) => {
      try {
        const runtime = fakeRuntimeClient({
          foreground: [textBlock("foreground", "loaded")],
          background: [textBlock("background", "loaded")],
        })
        const transcriptCache = createOutputTranscriptCache({ appService: runtime.client })
        await Promise.all([transcriptCache.open("foreground"), transcriptCache.open("background")])
        const [view, publish] = createSignal(config(1, false))
        createTranscriptVisibilityRefresh({
          config: view,
          transcriptCache,
        })
        await flushEffects()
        const baseline = runtime.outputWindowCalls()

        publish(config(2, true))
        await flushEffects()
        const refreshes = runtime.outputWindowRequests().slice(baseline)
        expect(refreshes.map(({ sessionId }) => sessionId).sort()).toEqual(["background", "foreground"])
        expect(refreshes.every(({ request }) => request.range.includeThinkingContent === true)).toBe(true)

        publish(config(3, false))
        await flushEffects()
        expect(runtime.outputWindowCalls()).toBe(baseline + 2)

      } finally {
        dispose()
      }
    })
  })

  it("marks a resident whose refresh read keeps failing as recovery-failed", async () => {
    await createRoot(async (dispose) => {
      try {
        const runtime = fakeRuntimeClient({ foreground: [textBlock("foreground", "loaded")] })
        const transcriptCache = createOutputTranscriptCache({ appService: runtime.client, recoveryBackoff: INSTANT_BACKOFF })
        await transcriptCache.open("foreground")
        const [view, publish] = createSignal(config(1, false))
        createTranscriptVisibilityRefresh({ config: view, transcriptCache })
        await flushEffects()

        runtime.failOutputWindow(10)
        publish(config(2, true))
        for (let tick = 0; tick < 10 && transcriptCache.visibleRange("foreground")?.status.kind !== "recovery-failed"; tick++) await flushEffects()
        expect(transcriptCache.visibleRange("foreground")?.status.kind).toBe("recovery-failed")
      } finally {
        dispose()
      }
    })
  })
})
