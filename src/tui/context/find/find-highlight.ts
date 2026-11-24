import type { RGBA, TextBufferRenderable, TextChunk } from "@opentui/core"
import { type Accessor, createContext, createSignal, onCleanup, untrack, useContext } from "solid-js"
import type { FindMatcher, FindRange } from "../../../protocol/transcript-find.js"
import { displayWidth } from "../../terminal/text.js"
import { blendToward, contrastRatio, correctContrast, TEXT_MINIMUM_CONTRAST } from "../theme/color-contrast.js"
import type { TuiTheme } from "../theme/tui-theme.js"

/** The occurrence a find bar moved to: its block and its ordinal among the
 *  occurrences that the block renders. */
export interface FindTarget {
  readonly blockId: string
  readonly occurrence: number
}

/** A mounted text that holds the target occurrence, and the visual line of
 *  that text where the occurrence starts. */
export interface FindSpot {
  readonly el: TextBufferRenderable
  readonly line: number
}

interface FindColors {
  readonly current: { readonly fg: RGBA; readonly bg: RGBA }
  readonly other: { readonly fg: RGBA; readonly bg: RGBA }
}

/** The most of the warning colour that tints the background of a match that
 *  is not the current one. */
const OTHER_MATCH_TINT = 0.3

/** The match colours of a theme. The current match takes the warning colour.
 *  Every other match takes a tint of it on the background, as strong as the
 *  theme's text stays readable on it, so it always stands out less than the
 *  current match. */
export function findColors(theme: Pick<TuiTheme, "background" | "warning" | "text">): FindColors {
  const tint = (amount: number) => blendToward(theme.background, theme.warning, amount)
  const other = correctContrast(tint(OTHER_MATCH_TINT), (color) => contrastRatio(theme.text, color) >= TEXT_MINIMUM_CONTRAST, (position) => tint(OTHER_MATCH_TINT * (1 - position)), 0, 1)
  return { current: { fg: theme.background, bg: theme.warning }, other: { fg: theme.text, bg: other } }
}

interface MountedText {
  readonly el: TextBufferRenderable
  readonly blockId: Accessor<string>
  text: string
}

/** Paints the find matches on the transcript's mounted text and locates the
 *  target occurrence among them. Only text that a transcript renders takes
 *  part: each text records the plain text it shows, so the matcher reads what
 *  the person sees after Markdown and syntax rendering, and a text inside a
 *  block scope can hold the target. The runtime counts occurrences in the
 *  stored text, so the rendered text can show fewer of them, such as when
 *  Markdown hides a link address; such a target has no spot, and the
 *  transcript marks its block instead. */
export interface FindHighlight {
  /** The chunks with each match painted, the match that `strong` names in
   *  the current colours. Reactive: it reads the matcher, the colours, and
   *  `strong`. */
  paint(el: TextBufferRenderable, chunks: readonly TextChunk[], strong: Accessor<number>): readonly TextChunk[]
  /** The same painting as a chunk transform for a renderable that styles its
   *  own text, or undefined while no find is open. Reactive like `paint`,
   *  except that the transform reads `strong` when it runs. */
  painter(el: TextBufferRenderable, strong: Accessor<number>): ((chunks: readonly TextChunk[]) => readonly TextChunk[]) | undefined
  /** The ordinal among the matches of `el` of the current match, or -1 when
   *  `el` does not hold it. Reactive: a caller reads it through a memo, so a
   *  move of the current match repaints only the texts that held or hold it. */
  strongIndex(el: TextBufferRenderable): number
  /** Tracks a mounted text of a block until its owner is disposed. */
  track(el: TextBufferRenderable, blockId: Accessor<string>): void
  /** Makes `target` current and finds its mounted text. Reads layout, so it
   *  runs after the block laid out; undefined while no mounted text of the
   *  block shows the target occurrence. Until one does, a change to the
   *  block's text, such as a body that arrives after the landing, locates the
   *  target again and hands the spot to `reveal` once it shows. */
  locate(target: FindTarget): FindSpot | undefined
  clear(): void
}

interface FindHighlightDeps {
  readonly matcher: Accessor<FindMatcher | undefined>
  readonly colors: Accessor<FindColors>
  readonly reveal: (spot: FindSpot) => void
}

export function createFindHighlight(deps: FindHighlightDeps): FindHighlight {
  const texts = new Map<TextBufferRenderable, MountedText>()
  const [current, setCurrent] = createSignal<{ readonly el: TextBufferRenderable; readonly index: number } | undefined>()
  // The target whose exact occurrence no mounted text showed yet.
  let unresolved: FindTarget | undefined
  let relocating = false

  function relocate(): void {
    relocating = false
    const target = unresolved
    if (target === undefined) return
    const spot = locate(target)
    if (spot) deps.reveal(spot)
  }

  function locate(target: FindTarget): FindSpot | undefined {
    unresolved = target
    const matcher = deps.matcher()
    if (matcher === undefined) { setCurrent(undefined); return undefined }
    const members = [...texts.values()].filter((mounted) => untrack(mounted.blockId) === target.blockId && !mounted.el.isDestroyed && Number.isFinite(mounted.el.y))
    members.sort((a, b) => a.el.y - b.el.y || a.el.x - b.el.x)
    let seen = 0
    for (const mounted of members) {
      const ranges = matcher(mounted.text)
      const index = target.occurrence - seen
      const range = ranges[index]
      if (range !== undefined) {
        unresolved = undefined
        setCurrent({ el: mounted.el, index })
        return { el: mounted.el, line: visualLine(mounted.el, mounted.text, range.start) }
      }
      seen += ranges.length
    }
    setCurrent(undefined)
    return undefined
  }

  function record(el: TextBufferRenderable, plain: string): void {
    const mounted = texts.get(el)
    if (!mounted || mounted.text === plain) return
    mounted.text = plain
    if (unresolved?.blockId !== untrack(mounted.blockId) || relocating) return
    relocating = true
    queueMicrotask(relocate)
  }

  function painter(el: TextBufferRenderable, strong: Accessor<number>): ((chunks: readonly TextChunk[]) => readonly TextChunk[]) | undefined {
    const matcher = deps.matcher()
    if (!matcher) return undefined
    const colors = deps.colors()
    return (chunks) => {
      const plain = plainText(chunks)
      record(el, plain)
      const ranges = matcher(plain)
      return ranges.length === 0 ? chunks : paintRanges(chunks, ranges, strong(), colors)
    }
  }

  return {
    painter,
    // While no find is open nothing is recorded: opening one repaints, and
    // records, every mounted text.
    paint(el, chunks, strong) {
      const paint = painter(el, strong)
      return paint ? paint(chunks) : chunks
    },
    strongIndex(el) {
      const strong = current()
      return strong?.el === el ? strong.index : -1
    },
    track(el, blockId) {
      texts.set(el, { el, blockId, text: "" })
      onCleanup(() => {
        texts.delete(el)
        if (untrack(current)?.el === el) setCurrent(undefined)
      })
    },
    locate,
    clear: () => { unresolved = undefined; setCurrent(undefined) },
  }
}

function plainText(chunks: readonly TextChunk[]): string {
  return chunks.map((chunk) => chunk.text).join("")
}

/** The visual line of `el` that shows the character at `offset` of its text. */
function visualLine(el: TextBufferRenderable, text: string, offset: number): number {
  const lineStart = text.lastIndexOf("\n", offset - 1) + 1
  const sourceLine = text.slice(0, lineStart).split("\n").length - 1
  const column = displayWidth(text.slice(lineStart, offset))
  const { lineSources, lineStartCols } = el.lineInfo
  const first = lineSources.indexOf(sourceLine)
  if (first === -1) return 0
  // The start offsets count cells over the whole text, plus one per line
  // break, so a wrapped part's column is relative to its line's first part.
  const lineOffset = lineStartCols[first] ?? 0
  let line = first
  for (let index = first + 1; lineSources[index] === sourceLine && (lineStartCols[index] ?? 0) - lineOffset <= column; index += 1) line = index
  return line
}

/** Splits chunks at the match edges and gives each match its background:
 *  the strong colors for the current one, the weaker one for the others. */
function paintRanges(chunks: readonly TextChunk[], ranges: readonly FindRange[], strong: number, colors: FindColors): TextChunk[] {
  const painted: TextChunk[] = []
  let chunkStart = 0
  let next = 0
  for (const chunk of chunks) {
    const chunkEnd = chunkStart + chunk.text.length
    let at = chunkStart
    while (at < chunkEnd) {
      while (next < ranges.length && (ranges[next]?.end ?? 0) <= at) next += 1
      const range = ranges[next]
      if (range === undefined || range.start >= chunkEnd) {
        painted.push({ ...chunk, text: chunk.text.slice(at - chunkStart) })
        break
      }
      if (range.start > at) {
        painted.push({ ...chunk, text: chunk.text.slice(at - chunkStart, range.start - chunkStart) })
        at = range.start
      }
      const end = Math.min(range.end, chunkEnd)
      painted.push({ ...chunk, ...(next === strong ? colors.current : colors.other), text: chunk.text.slice(at - chunkStart, end - chunkStart) })
      at = end
    }
    chunkStart = chunkEnd
  }
  return painted
}

const FindHighlightContext = createContext<FindHighlight | undefined>()
const FindBlockContext = createContext<Accessor<string> | undefined>()

export const FindHighlightProvider = FindHighlightContext.Provider
/** Names the block whose text renders inside, so the text can hold a find target. */
export const FindBlockScope = FindBlockContext.Provider

/** The transcript's find painter bound to the enclosing block, or undefined
 *  outside a transcript. Call it in a component's render scope. */
export function useFindPaint(): (Pick<FindHighlight, "paint" | "painter" | "strongIndex"> & { readonly bind: (el: TextBufferRenderable) => void }) | undefined {
  const highlight = useContext(FindHighlightContext)
  const blockId = useContext(FindBlockContext)
  if (!highlight) return undefined
  return {
    bind: (el) => { if (blockId !== undefined) highlight.track(el, blockId) },
    paint: highlight.paint,
    painter: highlight.painter,
    strongIndex: highlight.strongIndex,
  }
}
