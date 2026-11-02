import { describe, expect, it } from "bun:test"
import { createRoot, createSignal } from "solid-js"
import type { RuntimeConfigView } from "../../../../src/protocol/runtime-config-protocol-types.js"
import { createTranscriptVisibilityRefresh } from "../../../../src/tui/hooks/create-transcript-visibility-refresh.js"
import { createOutputTranscriptCache } from "../../../../src/tui/transcript-store/create-output-transcript-cache.js"
import { configValues } from "../modals/_settings-modal-fixtures.js"
import { fakeRuntimeClient, textBlock } from "./_output-transcript-cache-fixtures.js"

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
          onFailure: () => { throw new Error("refresh failed") },
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

  it("reports refresh failures for each resident transcript", async () => {
    await createRoot(async (dispose) => {
      try {
        const [view, publish] = createSignal(config(1, false))
        const failures: { sessionId: string; cause: unknown }[] = []
        createTranscriptVisibilityRefresh({
          config: view,
          transcriptCache: {
            residentSessionIds: () => ["foreground", "background"],
            refresh: async () => { throw new Error("refresh failed") },
          },
          onFailure: (sessionId, cause) => { failures.push({ sessionId, cause }) },
        })
        await flushEffects()

        publish(config(2, true))
        await flushEffects()
        expect(failures.map(({ sessionId }) => sessionId)).toEqual(["foreground", "background"])
        expect(failures.every(({ cause }) => cause instanceof Error)).toBe(true)
      } finally {
        dispose()
      }
    })
  })
})
