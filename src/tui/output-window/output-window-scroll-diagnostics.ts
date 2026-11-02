/**
 * Scroll-pipeline diagnostics: every scroll-position change, resnapshot, and
 * anchor decision becomes an INFO line carrying the full window/anchor state,
 * which is the evidence trail when chasing anchor drift or scroll jumps.
 * That volume is far too chatty for normal operation, so the module is active
 * only under FLYWHEEL_RENDER_DEBUG (the render-probe gate) and hands back
 * no-ops otherwise.
 */
import type { ScrollBoxRenderable } from "@opentui/core"
import { Log } from "../../infra/log.js"
import { renderProbeEnabled } from "../../infra/render-probe.js"
import type { TranscriptSnapshot } from "../transcript-store/output-transcript-cache-types.js"
import { maxScrollTop, type ScrollAnchor } from "./output-window-scroll.js"

const log = Log.create({ service: "output-window-scroll" })

interface LogFields { [key: string]: unknown }
function anchorLogFields(anchor: ScrollAnchor | undefined, prefix = "anchor"): LogFields {
  if (!anchor) return {}
  const block = { [`${prefix}Kind`]: anchor.kind, [`${prefix}Block`]: anchor.blockIndex }
  return anchor.kind === "block"
    ? { ...block, [`${prefix}Offset`]: anchor.rowOffsetWithinBlock }
    : { ...block, [`${prefix}Distance`]: anchor.distanceRows }
}

export interface OutputWindowScrollTelemetryContext {
  snapshot(): TranscriptSnapshot | undefined
  anchor(): ScrollAnchor | undefined
  /** Positional tailing state (followMode && was at bottom && no newer history). */
  bottomFollowActive(): boolean
}

export interface OutputWindowScrollTelemetry {
  changed(source: string, el: ScrollBoxRenderable, beforeTop: number | undefined, extra?: LogFields): void
  observe(source: string, el: ScrollBoxRenderable, extra?: LogFields): void
  event(message: string, el: ScrollBoxRenderable, extra?: LogFields): void
}

const NOOP_TELEMETRY: OutputWindowScrollTelemetry = { changed() {}, observe() {}, event() {} }

export function createOutputWindowScrollTelemetry(context: OutputWindowScrollTelemetryContext): OutputWindowScrollTelemetry {
  if (!renderProbeEnabled()) return NOOP_TELEMETRY
  let lastObservedTop: number | undefined
  let sequence = 0

  const fields = (el: ScrollBoxRenderable, extra?: LogFields): LogFields => {
    const snap = context.snapshot()
    const window = snap?.window
    const anchor = context.anchor()
    return {
      sequence,
      scrollTop: el.scrollTop,
      scrollHeight: el.scrollHeight,
      viewportRows: el.viewport.height,
      maxScrollTop: maxScrollTop(el),
      windowStart: window?.startBlockIndex,
      windowEnd: window?.endBlockIndex,
      hasBefore: window?.hasBefore,
      hasAfter: window?.hasAfter,
      totalBlocks: snap?.totalBlocks,
      bottomFollow: context.bottomFollowActive(),
      ...anchorLogFields(anchor),
      ...extra,
    }
  }

  const recordChange = (source: string, el: ScrollBoxRenderable, beforeTop: number | undefined, extra?: LogFields): void => {
    const afterTop = el.scrollTop
    if (beforeTop === undefined || afterTop === beforeTop) {
      lastObservedTop = afterTop
      return
    }
    sequence += 1
    log.info("scroll position changed", fields(el, {
      source,
      beforeTop,
      afterTop,
      deltaTop: afterTop - beforeTop,
      ...extra,
    }))
    lastObservedTop = afterTop
  }

  return {
    changed: recordChange,
    observe(source: string, el: ScrollBoxRenderable, extra?: LogFields): void {
      recordChange(source, el, lastObservedTop, extra)
    },
    event(message: string, el: ScrollBoxRenderable, extra?: LogFields): void {
      log.info(message, fields(el, extra))
      lastObservedTop = el.scrollTop
    },
  }
}
