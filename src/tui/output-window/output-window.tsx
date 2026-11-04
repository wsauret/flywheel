/** @jsxImportSource @opentui/solid */
import type { ChildCardStatus } from "../../protocol/client/session-controls.js"
import type { ToolStreamingText } from "@infra/output-blocks"
import { chatInputImages } from "@infra/chat-input.js"
import type { BoxRenderable, ScrollBoxRenderable } from "@opentui/core"
import { useRenderer } from "@opentui/solid"
import { OpaqueBox } from "@tui/components/opaque-box"
import { ShimmerText } from "@tui/components/shimmer-text"
import { Spinner } from "@tui/components/spinner"
import { ScrollPreserveProvider } from "@tui/context/scroll-preserve.js"
import { RowWidthProvider } from "@tui/context/row-width.js"
import { TranscriptViewportHeightProvider } from "@tui/context/transcript-viewport.js"
import { ImageClipBottomProvider } from "@tui/context/attachment-images.js"
import { BlockDisclosureProvider } from "@tui/context/block-disclosure.js"
import { LandingTargetProvider } from "@tui/context/landing-highlight.js"
import { MutationEvidenceProvider } from "../context/mutation-evidence.js"
import { parseSessionLink } from "../../protocol/client/session-links.js"
import { useTheme } from "@tui/context/theme"
import { type Accessor, createEffect, createMemo, createSignal, Index, onCleanup, Show, untrack } from "solid-js"
import { probe } from "../../infra/render-probe.js"
import { noticeText } from "../../infra/session-notice.js"
import type { DiffColorMode } from "../../orchestration/config/schema.js"
import { createOutputScrollController, type TranscriptSelectionAutoScroll } from "../hooks/create-output-scroll-controller.js"
import type { WheelProfile } from "./output-window-wheel.js"
import type { OutputTranscriptView, TranscriptSnapshot } from "../transcript-store/output-transcript-cache-types.js"
import { atTranscriptHead, snapshotSeeded } from "../transcript-store/output-transcript-cache-types.js"
import { BlockRenderer } from "../output-blocks/block-renderer.js"
import type { RowProcessControls } from "../output-blocks/stop-affordance.js"
import { createOutputWindowRenderDiagnostics } from "./output-window-diagnostics.js"
import { createTranscriptWindowProjector, targetTimelineBlockIndex, type TranscriptWindowProjection } from "./output-window-projection.js"
import { TranscriptViewport } from "./output-window-viewport.js"
import { createMountedRowRegistry, createSlotSignal, type EdgeDirection, type TranscriptLayoutSlot } from "./output-window-scroll.js"
import { SessionIntroBlock, type SessionIntroProps } from "../welcome-notice.js"
import { undeliveredNotice, type LocalChatSubmission } from "../../protocol/client/chat-submissions.js"
import { UserMessageBlock } from "../output-blocks/user-message-block.js"
import { Button } from "../components/button.js"
import { returnToLatestLabel, unseenMessageCount } from "../../protocol/client/return-to-latest.js"
import type { RoleAssignmentView } from "../../protocol/role-protocol-types.js"
import { blockIdentity } from "../../protocol/block-identity.js"

export type OutputWindowCommandType = "page-up" | "page-down" | "half-page-up" | "half-page-down" | "top" | "bottom"
export type OutputWindowCommand =
  | { readonly id: number; readonly type: OutputWindowCommandType }
  | { readonly id: number; readonly type: "block"; readonly entryId: string }

/** How long the card a block command lands on keeps its highlight. */
const LANDING_HIGHLIGHT_MS = 3000

interface StreamingToolTextById { readonly [toolUseId: string]: ToolStreamingText }
interface OutputWindowProps {
  transcript: OutputTranscriptView
  /** Per-session layout memory (measured heights + scroll position). Survives
   *  the keyed remount so a tab switch back re-renders at exact positions. */
  layoutSlot: TranscriptLayoutSlot
  sessionIntro: SessionIntroProps
  /** The session's agent is working. An empty transcript then shows that a
   *  worker is starting instead of nothing. */
  running: boolean
  showThinking?: boolean
  streamingToolText?: StreamingToolTextById
  diffColors?: Accessor<DiffColorMode>
  command?: OutputWindowCommand
  onNearEdge?: (direction: EdgeDirection) => void
  captureScrollbox?: (el: ScrollBoxRenderable) => void
  registerSelectionAutoScroll?: (controller: TranscriptSelectionAutoScroll) => () => void
  processControls?: RowProcessControls
  roleView?: (sessionId: string) => RoleAssignmentView | undefined
  /** What a child session waits on, such as "Waiting on parent", for its card. */
  childStatus?: (sessionId: string) => ChildCardStatus
  /** Follows the role and status readings of the children the cards show. */
  ensureChildViews?: (sessionIds: readonly string[]) => void
  localSubmissions?: readonly LocalChatSubmission[]
  /** How the terminal reports the wheel; the host terminal's when absent. */
  wheel?: WheelProfile
}
export function OutputWindow(props: OutputWindowProps) {
  const themeCtx = useTheme()
  const renderer = useRenderer()
  const transcript = untrack(() => props.transcript)
  // Static per mount like the transcript: the keyed <Show> remounts on session
  // change, so the slot never changes within a mount.
  const layoutSlot = untrack(() => props.layoutSlot)
  const snapshot = createMemo<TranscriptSnapshot | undefined>(() => transcript.visibleRange())
  const atTopOfHistory = () => atTranscriptHead(snapshot())
  const showIntro = () => atTopOfHistory() && props.sessionIntro.sessionKind() === "chat"
  // Cache the settled prefix's classify/group/flag output; each streaming flush
  // re-projects only the volatile suffix.
  const projectWindow = createTranscriptWindowProjector()
  const projection = createMemo<TranscriptWindowProjection>(() => {
    probe("ow.timeline")
    try {
      return projectWindow(snapshot(), props.showThinking)
    } catch (error) {
      return untrack(() => transcript.reportProjectionFailure(error))
    }
  })
  createEffect(() => {
    const sessionIds = projection().timelineBlocks.flatMap((block) => {
      if (block.kind !== "agentGroup") return []
      const sessionId = parseSessionLink(block.linkUri)?.sessionId
      return sessionId === undefined ? [] : [sessionId]
    })
    props.ensureChildViews?.([...new Set(sessionIds)])
  })
  // An empty pane says why it shows nothing when the transcript could not be
  // read or the runtime has none to give.
  const emptyNotice = createMemo(() => {
    const status = snapshot()?.status
    if (status?.kind === "recovery-failed") return "Output recovery failed. The transcript may be stale."
    return status?.kind === "unavailable" ? noticeText(status.notice) : undefined
  })
  // The intro renders inside the scrollbox above the transcript rows; its
  // measured height is the leading extent the scroll controller's anchor math
  // subtracts (and re-adds) so offsets stay block-accurate at the head. Seeded
  // from the slot's persisted leading rows: the controller's restored state
  // remembers the prior mount's intro height, so a fresh 0 here would make the
  // first frame compute a spurious leading delta and paint one frame shifted
  // up before the intro re-measures (the tab-switch bounce).
  const [introRows, setIntroRows] = createSignal(layoutSlot.scroll?.lastLeadingRows ?? 0)
  // Queued user messages overlay the scrollbox bottom (so the scrollbar spans
  // the full transcript area); a trailing spacer of the overlay's measured
  // height keeps the real tail scrollable above it, faking the message "into"
  // the scroll range while it stays anchored until un-queued. Seeded from the
  // slot for the same reason as introRows: a 0-row spacer on remount shrinks
  // the scroll extent for one frame and the restored offset paints clamped.
  const [pendingRows, setPendingRows] = createSlotSignal(layoutSlot, "pendingRows")
  const hasPending = () => projection().pendingBlocks.length > 0 || (props.localSubmissions?.length ?? 0) > 0
  // The row-width channel: blocks that wrap their own content (tool lists)
  // seed their wrap width from the shared row width instead of discovering it
  // per mount through a post-mount resize (a blank line that re-wraps a frame
  // later - a transient the height pipeline would record as real). Slot-
  // persisted so a remounted session wraps final shapes on its first layout;
  // the viewport's top spacer reports the live value.
  const [rowWidth, setRowWidth] = createSlotSignal(layoutSlot, "rowWidth")
  // The overlay unmounts when the pending queue drains; zero the persisted
  // height so a later remount does not seed a spacer for blocks long gone.
  createEffect(() => {
    if (hasPending()) return
    setPendingRows(0)
  })
  // Mounted rows register here: the scroll controller holds its reading
  // anchor on their source text and requests fresh measurements after a
  // width change or demotion (see MountedRowRegistry in output-window-scroll.ts).
  const mountedRows = createMountedRowRegistry()
  const unindexedRows = () => (showIntro() ? introRows() : 0) + pendingRows()
  const scroll = createOutputScrollController({
    snapshot,
    projection,
    showThinking: () => props.showThinking ?? false,
    slot: layoutSlot,
    onNearEdge: (direction) => props.onNearEdge?.(direction),
    hydrateAnchor: () => transcript.hydrateAnchor(),
    updateSelection: (current, x, y) => renderer.updateSelection(current, x, y),
    takeEstimateUpdates: () => transcript.takeEstimateUpdates(),
    evictBefore: (blockIndex) => transcript.evictBefore(blockIndex),
    leadingRows: () => (showIntro() ? introRows() : 0),
    unindexedRows,
    mountedRows,
    visibleMessageCount: transcript.visibleMessageCount,
    jumpToLatest: transcript.jumpToLatest,
    wheel: untrack(() => props.wheel),
  })
  const unseen = createMemo(() => {
    const baseline = scroll.returnToLatestBaseline()
    return baseline === undefined ? 0 : unseenMessageCount(baseline, transcript.visibleMessageCount()).unseen
  })
  createEffect(() => {
    const snap = snapshot()
    const viewport = scroll.viewport()
    const following = scroll.returnToLatestBaseline() === undefined
    if (!snap) return
    const index = scroll.heightIndex()
    const first = index.rowOffsetToBlockIndex(Math.max(0, viewport.scrollTop - introRows()))
    const last = index.rowOffsetToBlockIndex(Math.max(0, viewport.scrollTop + viewport.viewportRows - introRows()))
    const after = projection().timelineBlockIndices.find((blockIndex) => blockIndex > last) ?? (snap.window.endBlockIndex ?? last) + 1
    const start = snap.window.startBlockIndex ?? 0
    transcript.protectReader({ following, blockIds: snap.blocks.slice(Math.max(0, first - start), Math.max(0, after - start)).map(blockIdentity) })
  })
  const latestLabel = () => `${returnToLatestLabel(unseen())} ↓`
  const latestWidth = () => latestLabel().length + 2
  const transcriptRows = () => scroll.viewport().viewportRows
  const dockRows = createMemo(() => Math.max(1, Math.floor(transcriptRows() / 2)))
  let mainScrollbox: ScrollBoxRenderable | undefined
  const imageClipBottom = () => hasPending() && mainScrollbox
    ? mainScrollbox.viewport.screenY + mainScrollbox.viewport.height - pendingRows()
    : undefined
  const unregisterSelectionAutoScroll = untrack(() => props.registerSelectionAutoScroll?.(scroll.selectionAutoScroll))
  onCleanup(() => unregisterSelectionAutoScroll?.())
  createOutputWindowRenderDiagnostics({ freshness: transcript.freshness, snapshot, projection })
  // A landing marks its card for a while so the eye finds it after the jump;
  // the next landing replaces the target and restarts the time.
  const [landingTarget, setLandingTarget] = createSignal<string>()
  let landingTimer: ReturnType<typeof setTimeout> | undefined
  function highlightLanding(entryId: string): void {
    clearTimeout(landingTimer)
    setLandingTarget(entryId)
    landingTimer = setTimeout(() => setLandingTarget(undefined), LANDING_HIGHLIGHT_MS)
  }
  onCleanup(() => clearTimeout(landingTimer))
  let lastCommandId = untrack(() => props.command?.id ?? 0)
  function runCommand(command: OutputWindowCommand): void {
    switch (command.type) {
      case "top": return scroll.toTop()
      case "bottom": return scroll.toBottom()
      case "block":
        void transcript.loadAround(command.entryId).then(() => {
          const blockIndex = untrack(() => targetTimelineBlockIndex(projection(), command.entryId))
          if (blockIndex === undefined) return
          scroll.toBlock(blockIndex)
          highlightLanding(command.entryId)
        }).catch(() => {})
        return
      default: return scroll.page(command.type)
    }
  }
  createEffect(() => {
    const command = props.command
    if (!command || command.id === lastCommandId) return
    lastCommandId = command.id
    untrack(() => runCommand(command))
  })
  const hasContent = () => (snapshot()?.blocks.length ?? 0) > 0
  // Loading gates (see output-transcript-cache-types.ts): the intro card and
  // the "Starting worker..." label must not flash during a reopened session's
  // load round-trip. A running session whose transcript is still loading is
  // not starting a worker.
  const seeded = () => snapshotSeeded(snapshot())
  return (
    <BlockDisclosureProvider value={{ disclosure: transcript.disclosure, setDisclosure: transcript.setDisclosure }}>
    <RowWidthProvider value={{ width: rowWidth, report: setRowWidth }}>
    <ScrollPreserveProvider value={scroll.preserveScroll}>
    <TranscriptViewportHeightProvider value={transcriptRows}>
    <LandingTargetProvider value={landingTarget}>
      <box flexDirection="column" flexGrow={1}>
        <box paddingLeft={1} paddingRight={0} flexDirection="column" flexGrow={1} position="relative">
          <scrollbox
            ref={(el: ScrollBoxRenderable) => {
              mainScrollbox = el
              scroll.attach(el)
              props.captureScrollbox?.(el)
            }}
            flexGrow={1}
            width="100%"
            stickyScroll={false}
            viewportOptions={{ paddingRight: 1 }}
            verticalScrollbarOptions={{
              paddingLeft: 1,
              trackOptions: { foregroundColor: themeCtx.theme.border, backgroundColor: themeCtx.theme.backgroundElement },
            }}
            // Culling OFF: a culled child's subtree skips its update pass, so a
            // row freshly mounted into the overscan measures 1-3 rows SHORT of
            // its visible layout and re-corrects the frame it scrolls into view
            // - an endless extent-correction oscillation (scrollbar thumb hops)
            // on every pass over the transcript. Rows outside the viewport are
            // still scissored out of the paint; the mounted set is already
            // virtualized to viewport+overscan, so the update-pass cost is
            // bounded.
            viewportCulling={false}
            focused={false}
          >
            <ImageClipBottomProvider value={imageClipBottom}>
            <Show when={showIntro()}>
              <box
                width="100%"
                flexDirection="column"
                onSizeChange={function (this: BoxRenderable) {
                  // NaN between layouts (see RowMount): a NaN here reaches the
                  // scroll controller as leadingRows and poisons the frame
                  // loop's offset math. Skip; the next size event reports real.
                  if (Number.isFinite(this.height)) setIntroRows(this.height)
                }}
              >
                <SessionIntroBlock {...props.sessionIntro} />
              </box>
            </Show>

            {!hasContent() && props.running && seeded() ? (
              <box flexDirection="row" gap={1} paddingLeft={1} paddingTop={1}>
                <Spinner color={themeCtx.theme.primary} />
                <ShimmerText text="Starting worker..." color={themeCtx.theme.textMuted} />
              </box>
            ) : null}

            {!hasContent() && emptyNotice() ? (
              <box paddingLeft={1} paddingTop={1}>
                <text fg={themeCtx.theme.warning} wrapMode="word">
                  {emptyNotice()}
                </text>
              </box>
            ) : null}

            <TranscriptViewport
              snapshot={snapshot}
              projection={projection}
              heightIndexRecord={scroll.heightIndexRecord}
              viewport={scroll.viewport}
              transcript={transcript}
              streamingToolText={props.streamingToolText}
              showThinking={props.showThinking}
              diffColors={props.diffColors}
              registerRow={mountedRows.register}
              unindexedRows={unindexedRows}
              sessionId={layoutSlot.sessionId}
              processControls={props.processControls}
              roleView={props.roleView}
              childStatus={props.childStatus}
            />
            <box height={pendingRows()} flexShrink={0} />
            </ImageClipBottomProvider>
          </scrollbox>

          <Show when={hasPending()}>
            <OpaqueBox
              position="absolute"
              bottom={0}
              left={1}
              width={rowWidth()}
              flexShrink={0}
              overflow="hidden"
              flexDirection="column"
              maxHeight={dockRows()}
              onSizeChange={function (this: BoxRenderable) {
                // NaN between layouts (see intro above): skip, next event is real.
                if (!Number.isFinite(this.height)) return
                setPendingRows(this.height)
              }}
            >
              <MutationEvidenceProvider reader={transcript.mutationEvidence}>
              <scrollbox height="auto" minHeight={0}
                maxHeight={dockRows()}
                contentOptions={{ minHeight: 0 }}
                verticalScrollbarOptions={{ visible: false }}
                scrollY scrollX={false} stickyScroll stickyStart="bottom">
              <Index each={projection().pendingBlocks}>
                {(block) => (
                  <BlockRenderer
                    block={block()}
                    onHydrateBody={(blockId) => transcript.hydrateBlockBody(blockId)}
                    streamingToolText={props.streamingToolText}
                    showThinking={props.showThinking}
                    diffColors={props.diffColors}
                    processControls={props.processControls}
                    roleView={props.roleView}
                    childStatus={props.childStatus}
                  />
                )}
              </Index>
              <Index each={props.localSubmissions}>
                {(entry) => <UserMessageBlock
                  block={{ kind: "userMessage", id: entry().id, content: entry().input.invocation?.args ?? entry().input.text, timestamp: entry().timestamp, pending: true, injected: false, images: chatInputImages(entry().input) }}
                  deliveryUnconfirmed={undeliveredNotice(entry().delivery) !== undefined}
                />}
              </Index>
              </scrollbox>
              </MutationEvidenceProvider>
            </OpaqueBox>
          </Show>
          {/* Wheel input is applied during native layout, after text composition.
              Keep the label mounted so its first visible frame has composed text. */}
          <box
            visible={scroll.returnToLatestBaseline() !== undefined}
            position="absolute"
            bottom={pendingRows()}
            left={Math.max(1, Math.floor((rowWidth() - latestWidth()) / 2) + 1)}
            width={latestWidth()}
            height={1}
            onMouseScroll={scroll.wheel}
          >
            <Button label={latestLabel()} onPress={scroll.returnToLatest} />
          </box>
        </box>
      </box>
    </LandingTargetProvider>
    </TranscriptViewportHeightProvider>
    </ScrollPreserveProvider>
    </RowWidthProvider>
    </BlockDisclosureProvider>
  )
}
