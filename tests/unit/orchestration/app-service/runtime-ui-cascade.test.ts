import { describe, expect, it } from "bun:test"
import { createRoot } from "solid-js"
import type { AnyBlock } from "../../../../src/infra/output-blocks.js"
import { probeDrain } from "../../../../src/infra/render-probe.js"
import type {
  FrontendEvent,
  SessionCatalogRow,
  AttachedRuntimeClient,
} from "../../../../src/protocol/app-service-types.js"
import { runtimeQuery } from "../../../helpers/runtime-dispatch.js"
import { outputCursor, type OutputDelta, type OutputView } from "../../../../src/protocol/output-protocol-types.js"
import { createRuntimeUiPatchSequencer } from "../../../../src/orchestration/app-service/runtime-ui-patch-sequencer.js"
import { createOutputTranscriptCache } from "../../../../src/tui/transcript-store/create-output-transcript-cache.js"
import { createSessionCatalog } from "../../../../src/tui/hooks/create-session-catalog.js"
import { blockIdentity } from "../../../../src/protocol/block-identity.js"
import { fakeLanes } from "../../../helpers/fake-lanes.js"
import { catalogRow, snapshotResult } from "../../../helpers/session-catalog.js"

function textBlock(id: string, content: string): AnyBlock {
  return { kind: "text", id, content, timestamp: 1 }
}

function view(blocks: AnyBlock[]): OutputView {
  return { blocks, streamingToolText: {} }
}

function delta(v: OutputView): OutputDelta {
  return {
    visibleMessageCount: v.blocks.filter((block) => block.kind === "text" || (block.kind === "userMessage" && !block.pending)).length,
    blocks: v.blocks.map((block, index) => ({ kind: "upsert", index, blockId: blockIdentity(block), block })),
    truncateTo: 0,
    streamingToolTextOps: Object.entries(v.streamingToolText).map(([toolUseId, entry]) => ({ kind: "set" as const, toolUseId, entry })),
  }
}

/** One app-service feeding BOTH TUI caches, wired exactly like the real
 *  `createFlywheelAppService`: a single sequencer mints every position, every
 *  listener sees every patch, and `snapshot` and `outputWindow` mint snapshot
 *  positions through the same authority. The lane is open from the start. This reproduces the live
 *  TUI topology the cascade was observed in. */
function combinedAppService() {
  const sequencer = createRuntimeUiPatchSequencer()
  const catalogRows = new Map<string, SessionCatalogRow>()
  const details = new Map<string, AnyBlock[]>()
  const listeners = new Set<(event: FrontendEvent) => void>()

  const query = runtimeQuery({
    snapshot: async () => snapshotResult([...catalogRows.values()], sequencer.snapshotPosition({ kind: "workspace", domains: ["session"] })),
    outputWindow: async (request) => {
      const blocks = details.get(request.sessionId)
      return {
        snapshotPosition: sequencer.snapshotPosition({ kind: "cursor", cursor: outputCursor(request.sessionId) }),
        totalBlocks: blocks?.length ?? 0,
        visibleMessageCount: blocks?.filter((block) => block.kind === "text" || (block.kind === "userMessage" && !block.pending)).length ?? 0,
        range: {
          kind: "ok" as const,
          consistencyToken: "test:v1",
          anchor: { kind: "tail" as const },
          window: { startBlockIndex: blocks && blocks.length > 0 ? 0 : null, endBlockIndex: blocks && blocks.length > 0 ? blocks.length - 1 : null, hasBefore: false, hasAfter: false, contentBytes: 0 },
          blocks: blocks ?? [],
          streamingToolText: {}, streamingOutputChars: 0,
        },
      }
    },
  })

  const service = {
    query,
    subscribe: (l: (event: FrontendEvent) => void) => {
      listeners.add(l)
      return () => { listeners.delete(l) }
    },
    ...fakeLanes().client,
  } satisfies Pick<AttachedRuntimeClient, "query" | "subscribe" | "onLane" | "watchOutput">

  function broadcast(patch: FrontendEvent): void {
    for (const l of listeners) l(patch)
  }

  return {
    service,
    seedSession: (row: SessionCatalogRow) => { catalogRows.set(row.id, row) },
    seedDetail: (id: string, blocks: AnyBlock[]) => { details.set(id, blocks) },
    sessionUpdated: (row: SessionCatalogRow) => {
      catalogRows.set(row.id, row)
      broadcast({ type: "patch", patch: sequencer.publish({ cursor: { scope: "session", domain: "session", sessionId: row.id }, payload: { kind: "session.updated", row } }) })
    },
    outputDelta: (id: string, v: OutputView) => {
      details.set(id, [...v.blocks])
      broadcast({ type: "patch", patch: sequencer.publish({ cursor: outputCursor(id), payload: { kind: "output.delta", delta: delta(v) } }) })
    },
  }
}

describe("runtime UI cross-domain cascade", () => {
  it("interleaved session and output patches off one app-service all classify applied (no resnapshot cascade)", async () => {
    const prev = process.env.FLYWHEEL_RENDER_DEBUG
    process.env.FLYWHEEL_RENDER_DEBUG = "1"
    probeDrain()
    try {
      await createRoot(async (dispose) => {
        let clock = 1000
        const fake = combinedAppService()
        fake.seedSession(catalogRow("s1", "First"))
        fake.seedDetail("s1", [textBlock("a", "seed")])

        // The live shell-state topology: session cache subscribes first, then the
        // transcript store's live intake, both off the same app-service.
        const catalogClient = createSessionCatalog({ appService: fake.service, projectRoot: "/workspace" })
        const outputCache = createOutputTranscriptCache({ appService: fake.service, now: () => clock })

        // Item 20: live deltas only apply to a session this client actually
        // opened -- ensure() reproduces the foreground-mount open the real
        // shell-state topology always performs before a turn can stream. Drain
        // its own recovery probe once settled so the bootstrap fetch doesn't
        // pollute the steady-state "no resnapshot cascade" signature below.
        outputCache.ensure("s1")
        outputCache.retain("s1")
        await new Promise<void>((resolve) => setTimeout(resolve, 0))
        probeDrain()
        // A single normal chat response: streaming output deltas interleaved with
          // the session catalog row updates a turn produces.
        for (let i = 1; i <= 8; i++) {
          clock += 20
          fake.outputDelta("s1", view([textBlock("a", `chunk-${i}`)]))
          clock += 20
          fake.sessionUpdated(catalogRow("s1", `First (${i})`))
        }

        // State converged: each receiver holds the latest authoritative value.
        expect(outputCache.view("s1")?.blocks[0]).toMatchObject({ content: "chunk-8" })
        expect(catalogClient.row("s1")?.title).toBe("First (8)")

        // The cascade signature: gaps/recoveries after the initial seed. The
        // single-flight recovery is rare recovery, not steady state, so an
        // interleaved turn must produce none.
        const { counters } = probeDrain()
        expect(counters["output.gap"] ?? 0).toBe(0)
        expect(counters["output.recovery"] ?? 0).toBe(0)

        dispose()
      })
    } finally {
      if (prev === undefined) delete process.env.FLYWHEEL_RENDER_DEBUG
      else process.env.FLYWHEEL_RENDER_DEBUG = prev
    }
  })
})
