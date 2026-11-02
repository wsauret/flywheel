/** @jsxImportSource @opentui/solid */

import { StyledText, bg as stBg, fg as stFg, type MouseEvent, type RGBA, type TextChunk } from "@opentui/core"
import { useRenderer } from "@opentui/solid"
import { createMemo, Index } from "solid-js"
import type { AgentGroupBlock, WorkflowAgentState, WorkflowCard } from "../../infra/output-blocks.js"
import { CHIT_SLOTS } from "../../protocol/client/workflow-chits.js"
import { workflowAgentOperations, workflowCardLines, workflowCardTime, type WorkflowCardBarPart, type WorkflowCardChoices, type WorkflowCardLine } from "../../protocol/client/workflow-card.js"
import type { WorkflowOutline } from "../../protocol/client/workflow-outline.js"
import { workflowSeatRoleText } from "../../protocol/client/workflow-agent.js"
import type { SummaryPart } from "../../protocol/client/workflow-progress.js"
import type { WorkflowAgentLive } from "../../protocol/workflow-view-protocol-types.js"
import { useHoverHighlight } from "../hooks/use-hover-highlight.js"
import { hitsDrawnContent } from "../utils/content-hit.js"
import { bindStyledTextContent } from "../utils/reactive-text.js"
import { hasSelectedCells } from "../utils/selection.js"
import { chunksWidth, displayWidth, fitChunks } from "../utils/text.js"
import { workflowChitChunks } from "./workflow-palette.js"
import { activityChunks, detailChunks, head, spread } from "./agent-line.js"

/** The widest the card's box gets, borders included. */
const CARD_MAX_WIDTH = 100
/** From this box width, the card uses its wide chit slots. */
const WIDE_BOX_WIDTH = 80
/** Below this width, which a pane of 46 columns gives, the card draws no
 *  box: its plan bar, one folded line of the plan, and the agents of the
 *  phase that needs attention. */
const NARROW_WIDTH = 44
const COUNT_WIDTH = 5
const TIME_WIDTH = 7
/** From this width, the full-size card also names each agent's persona and
 *  brief when the agents of a phase differ. Its lines always take the
 *  frame's whole width, so a summary is cut only once the frame is full. */
const FULL_ROLE_WIDTH = 120
const OPERATIONS_WIDTH = 8
/** The selection mark of the full-size card, before every line. */
const MARK_WIDTH = 2
const GAP = "  "
/** The indent of an agent line under its phase in the box, before its
 *  tree glyph. A narrow card draws its tree from its left edge. */
const TREE_INDENT = "  "

/** Whether a card `width` columns wide is narrow: it draws no box, and its
 *  header puts its controls on a line of their own. */
export function isNarrowWorkflowCard(width: number): boolean {
  return width < NARROW_WIDTH
}

interface WorkflowCardTheme {
  readonly backgroundElement: RGBA
  readonly text: RGBA
  readonly textBright: RGBA
  readonly textMuted: RGBA
  readonly primary: RGBA
  readonly phaseName: RGBA
  readonly agentName: RGBA
  readonly borderSubtle: RGBA
  readonly success: RGBA
  readonly error: RGBA
  readonly warning: RGBA
  readonly chatCodeType: RGBA
}

/** What a selection of a card line does: open an agent's view, expand or
 *  fold a phase, list every agent of a phase in place, or open the
 *  follow-up conversation. */
export type WorkflowCardAction =
  | { readonly kind: "agent"; readonly agentNodeId: string; readonly state: WorkflowAgentState }
  | { readonly kind: "phase"; readonly key: string }
  | { readonly kind: "counted"; readonly key: string }
  | { readonly kind: "followUp" }

/** One line of the card as the terminal draws it, styled for whether the
 *  pointer is over it. */
export interface WorkflowCardRow {
  readonly key: string
  readonly action?: WorkflowCardAction
  /** The phase of an agent line of the full-size card, where Left moves. */
  readonly phaseKey?: string
  readonly content: (hovered: boolean) => readonly TextChunk[]
}

export interface WorkflowCardInput {
  readonly card: WorkflowCard
  readonly status: AgentGroupBlock["status"]
  /** The workflow's `workflow_live` value, or none while the client holds
   *  none. */
  readonly live: readonly WorkflowAgentLive[]
  readonly choices?: WorkflowCardChoices | undefined
  readonly notice?: string | undefined
  readonly width: number
  readonly now: number
  readonly hovered: boolean
  readonly theme: WorkflowCardTheme
  /** The model and effort that serve an agent, by its agent node id, or
   *  none while the agent has no session. A card without it names no model. */
  readonly modelLabel?: ((agentNodeId: string) => string | undefined) | undefined
}

type PhaseLine = Extract<WorkflowCardLine, { readonly kind: "phase" }>
type AgentLine = Extract<WorkflowCardLine, { readonly kind: "agent" }>

function toneColor(tone: SummaryPart["tone"], theme: WorkflowCardTheme): RGBA {
  switch (tone) {
    case "done": return theme.success
    case "failed": return theme.error
    case "muted":
    case "plain": return theme.textMuted
  }
}

function settled(state: WorkflowAgentState): boolean {
  return state === "done" || state === "failed" || state === "skipped"
}

function pad(text: string, width: number, end: "start" | "end"): string {
  const room = Math.max(0, width - displayWidth(text))
  return end === "start" ? `${" ".repeat(room)}${text}` : `${text}${" ".repeat(room)}`
}

/** The quiet column of a phase line: the newest call of its running agent,
 *  the agents of a phase of named agents that has not started, each in the
 *  colour of an agent's name, or what the phase did. */
function phaseQuietChunks(line: PhaseLine, theme: WorkflowCardTheme): TextChunk[] {
  if (line.activity !== undefined) return activityChunks(line.activity, theme)
  if (line.agentNames !== undefined) return line.agentNames.flatMap((name, index) => [...(index === 0 ? [] : [stFg(theme.textMuted)(" · ")]), stFg(theme.agentName)(name)])
  return line.detail === undefined ? [] : [stFg(toneColor(line.detail.tone, theme))(line.detail.text)]
}

/** The title of a phase line, with the mark of a person's choice. */
function phaseTitle(line: PhaseLine): string {
  return line.choice === undefined ? line.title : `${line.title} ${line.choice === "expanded" ? "▾" : "▸"}`
}

interface Layout {
  readonly inner: number
  readonly slots: { readonly plan: number; readonly phase: number }
  readonly identityWidth: number
  /** The model column after the identity column, gap included, or 0 when
   *  the card names no model. */
  readonly modelWidth: number
  readonly indent: string
}

/** The model of the agent that a card line shows: the agent of an agent
 *  line, or the agent of a phase of one agent. A phase of several agents
 *  names none, so each agent line keeps its own model in place as its
 *  agents start. */
function lineModel(agentNodeId: string | undefined, input: Pick<WorkflowCardInput, "modelLabel">): string {
  return agentNodeId === undefined ? "" : input.modelLabel?.(agentNodeId) ?? ""
}

/** A line's model in the layout's model column, which a card that names no
 *  model does not draw. */
function modelCell(model: string, layout: Pick<Layout, "modelWidth">, theme: WorkflowCardTheme): TextChunk[] {
  return layout.modelWidth === 0 ? [] : [stFg(theme.textMuted)(pad(model, layout.modelWidth, "end"))]
}

function columnWidth(texts: readonly string[]): number {
  const widest = Math.max(0, ...texts.map(displayWidth))
  return widest === 0 ? 0 : widest + GAP.length
}

/** What a selection of a phase line does on either card: a phase with
 *  agent lines expands or folds, and a phase of one agent, which has no
 *  agent line, opens its agent once it started. */
function phaseAction(line: PhaseLine): WorkflowCardAction | undefined {
  return line.toggles ? { kind: "phase", key: line.key }
    : line.opens && line.agentNodeId !== undefined ? { kind: "agent", agentNodeId: line.agentNodeId, state: line.state } : undefined
}

function phaseRow(line: PhaseLine, layout: Layout, input: WorkflowCardInput): WorkflowCardRow {
  const { theme } = input
  const time = workflowCardTime(line, input.now)
  const right = time === "" ? [] : [stFg(theme.textMuted)(time)]
  const body = phaseQuietChunks(line, theme)
  const quiet = [...(line.count === undefined ? [] : [stFg(theme.textMuted)(`${line.count}${body.length === 0 ? "" : " · "}`)]), ...body]
  const action = phaseAction(line)
  return {
    key: `phase:${line.key}`,
    ...(action === undefined ? {} : { action }),
    content: (hovered) => {
      // The identity column bounds a name only while the line holds more:
      // a name alone is cut only once the line is full.
      const model = layout.modelWidth === 0 ? "" : lineModel(line.agentNodeId, input)
      const alone = quiet.length === 0 && line.chits === undefined && model === ""
      const identity = fitChunks(head(line.state, "phaseName", phaseTitle(line), 0, hovered && action !== undefined, theme), alone ? layout.inner : layout.identityWidth)
      const slots = Math.min(layout.slots.phase, layout.identityWidth - chunksWidth(identity) - 1)
      const chits = line.chits === undefined || slots <= 0 ? [] : workflowChitChunks(line.chits, slots, theme)
      const title = [...identity, ...(chits.length === 0 ? [] : [stFg(theme.text)(" "), ...chits])]
      return spread([...title, stFg(theme.text)(" ".repeat(Math.max(0, layout.identityWidth - chunksWidth(title))) + GAP), ...modelCell(model, layout, theme), ...quiet], right, layout.inner, theme)
    },
  }
}

function agentRow(line: AgentLine, layout: Layout, input: WorkflowCardInput, showDetail = true): WorkflowCardRow {
  const { theme } = input
  const time = workflowCardTime(line, input.now)
  const right = time === "" ? [] : [stFg(theme.textMuted)(time)]
  return {
    key: `agent:${line.agentNodeId}`,
    ...(line.opens ? { action: { kind: "agent", agentNodeId: line.agentNodeId, state: line.state } as const } : {}),
    content: (hovered) => {
      const detail = showDetail ? detailChunks(line.detail, theme) : []
      const model = layout.modelWidth === 0 ? "" : lineModel(line.agentNodeId, input)
      const identity = fitChunks([
        stFg(theme.borderSubtle)(`${layout.indent}${line.last ? "└" : "├"} `),
        ...head(line.state, "agentName", line.label, 0, hovered && line.opens, theme),
      ], detail.length === 0 && model === "" ? layout.inner : layout.identityWidth)
      return spread([...identity, stFg(theme.text)(" ".repeat(Math.max(0, layout.identityWidth - chunksWidth(identity))) + GAP), ...modelCell(model, layout, theme), ...detail], right, layout.inner, theme)
    },
  }
}

function countedRow(line: Extract<WorkflowCardLine, { readonly kind: "counted" }>, layout: Layout, theme: WorkflowCardTheme): WorkflowCardRow {
  return {
    key: `counted:${line.phaseKey}`,
    action: { kind: "counted", key: line.phaseKey },
    content: (hovered) => fitChunks([stFg(theme.borderSubtle)(`${layout.indent}└ `), stFg(hovered ? theme.textBright : theme.textMuted)(line.text)], layout.inner),
  }
}

/** The plan bar in `width` columns: its chits in `slots`, then its label,
 *  short on a narrow card. A label that does not fit drops whole parts,
 *  never a cut word: first the units that run or an interrupt holds, which
 *  the chits already colour, then its parts from the end. The count stays. */
function barChunks(line: Extract<WorkflowCardLine, { readonly kind: "bar" }>, slots: number, short: boolean, width: number, theme: WorkflowCardTheme): TextChunk[] {
  const chits = workflowChitChunks(line.counts, slots, theme)
  const room = width - chunksWidth(chits) - GAP.length
  const words = (part: WorkflowCardBarPart) => short ? part.short : part.text
  const labelWidth = (parts: readonly WorkflowCardBarPart[]) => parts.reduce((sum, part, index) => sum + displayWidth(words(part)) + (index === 0 ? 0 : 3), 0)
  let parts = line.label
  while (parts.length > 1 && labelWidth(parts) > room) {
    const active = parts.findLastIndex((part, index) => index > 0 && part.tone === "plain")
    const dropped = active > 0 ? active : parts.length - 1
    parts = parts.filter((_, index) => index !== dropped)
  }
  return [...chits, stFg(theme.text)(GAP), ...workflowProgressChunks(parts, theme, short)]
}

/** The words of a workflow's progress, such as `7/21 done · 11 running`,
 *  in the colours of the plan bar, or in their short form. */
export function workflowProgressChunks(parts: readonly WorkflowCardBarPart[], theme: WorkflowCardTheme, short = false): TextChunk[] {
  return parts.flatMap((part, index) => [...(index === 0 ? [] : [stFg(theme.textMuted)(" · ")]), stFg(part.tone === "plain" ? theme.text : toneColor(part.tone, theme))(short ? part.short : part.text)])
}

/** The rows of a card in `width` columns: its box, or below
 *  {@link NARROW_WIDTH} the narrow form. Everything here is pure, so a test
 *  reads the exact styled cells the terminal draws. */
function workflowCardRows(input: WorkflowCardInput): readonly WorkflowCardRow[] {
  const lines = workflowCardLines(input.card, { status: input.status, live: input.live, notice: input.notice, ...(input.choices === undefined ? {} : { choices: input.choices }) })
  if (isNarrowWorkflowCard(input.width)) return narrowRows(lines, input)
  const { theme } = input
  const width = Math.max(12, Math.min(CARD_MAX_WIDTH, input.width))
  const wide = width >= WIDE_BOX_WIDTH
  const slots = wide ? CHIT_SLOTS.terminalWide : CHIT_SLOTS.terminalNarrow
  const phases = lines.filter((line): line is PhaseLine => line.kind === "phase")
  const agents = lines.filter((line): line is AgentLine => line.kind === "agent")
  // Item keys can be full paths. Keep at least half the usable row for
  // the quiet column instead of letting one key displace every sentence.
  const half = Math.floor((width - 4 - TIME_WIDTH - 1) / 2)
  const identityColumn = Math.min(half, Math.max(
    0,
    ...phases.map((line) => 2 + displayWidth(phaseTitle(line)) + (line.chits === undefined ? 0 : 1 + chunksWidth(workflowChitChunks(line.chits, slots.phase, theme)))),
    ...agents.map(({ label }) => TREE_INDENT.length + 4 + displayWidth(label)),
  ) + GAP.length)
  // The model column takes the same half, and gives way whole before an
  // identity is cut, so a model never pushes a name or a time off the line.
  const modelColumn = columnWidth([...phases, ...agents].map(({ agentNodeId }) => lineModel(agentNodeId, input)))
  const layout: Layout = {
    inner: width - 4,
    slots,
    identityWidth: identityColumn - GAP.length,
    modelWidth: identityColumn + modelColumn <= half ? modelColumn : 0,
    indent: TREE_INDENT,
  }
  const border = input.hovered ? theme.primary : theme.borderSubtle
  const framed = (row: WorkflowCardRow): WorkflowCardRow => ({
    ...row,
    content: (hovered) => {
      const chunks = row.content(hovered)
      return [stFg(border)("│ "), ...chunks, stFg(theme.text)(" ".repeat(Math.max(0, layout.inner - chunksWidth(chunks)))), stFg(border)(" │")]
    },
  })
  const rows: WorkflowCardRow[] = [{ key: "top", content: () => [stFg(border)(`╭${"─".repeat(width - 2)}╮`)] }]
  const bar = lines.find((line) => line.kind === "bar")
  if (bar !== undefined) rows.push(framed({ key: "bar", content: () => fitChunks(barChunks(bar, slots.plan, !wide, layout.inner, theme), layout.inner) }))
  for (const line of lines) {
    switch (line.kind) {
      case "notice": rows.push(framed({ key: "notice", content: () => fitChunks([stFg(theme.warning)(line.text)], layout.inner) })); break
      case "fold": rows.push(framed({ key: `fold:${line.text}`, content: () => fitChunks([stFg(toneColor(line.tone, theme))(line.text)], layout.inner) })); break
      case "phase": rows.push(framed(phaseRow(line, layout, input))); break
      case "agent": rows.push(framed(agentRow(line, layout, input))); break
      case "counted": rows.push(framed(countedRow(line, layout, theme))); break
      case "bar": break
      case "followUp": break
    }
  }
  rows.push({ key: "bottom", content: () => [stFg(border)(`╰${"─".repeat(width - 2)}╯`)] })
  return rows
}

/** A narrow card's rows: the plan bar with its short label, one line that
 *  folds the plan around the phase that needs attention, that phase's
 *  chits or newest call, and its agents with their times. */
function narrowRows(lines: readonly WorkflowCardLine[], input: WorkflowCardInput): readonly WorkflowCardRow[] {
  const { theme, width } = input
  const slots = CHIT_SLOTS.terminalCompact
  const phases = lines.filter((line): line is PhaseLine => line.kind === "phase")
  const attention = phases.findIndex(({ state }) => state === "running" || state === "parked" || state === "failed")
  const unsettled = phases.findIndex(({ state }) => !settled(state))
  const focus = attention >= 0 ? attention : unsettled >= 0 ? unsettled : phases.length - 1
  const phase = phases[focus]
  const before = input.card.before + Math.max(0, focus)
  const after = input.card.after + Math.max(0, phases.length - focus - 1)
  const separator = stFg(theme.textMuted)(" › ")
  const parts: TextChunk[][] = []
  if (before > 0) parts.push([stFg(theme.success)(`✓ ${before} done`)])
  if (phase !== undefined) {
    const time = phase.chits === undefined ? workflowCardTime(phase, input.now) : ""
    parts.push([...head(phase.state, "phaseName", phase.title, 0, false, theme), ...(time === "" ? [] : [stFg(theme.textMuted)(` ${time}`)])])
  }
  if (after > 0) parts.push([stFg(theme.textMuted)(`${after} more`)])
  const bar = lines.find((line): line is Extract<WorkflowCardLine, { readonly kind: "bar" }> => line.kind === "bar")
  const rows: WorkflowCardRow[] = [
    ...(bar === undefined ? [] : [{ key: "bar", content: () => fitChunks(barChunks(bar, slots.plan, true, width, theme), width) }]),
    { key: "fold", content: () => fitChunks(parts.flatMap((part, index) => index === 0 ? part : [separator, ...part]), width) },
  ]
  if (phase === undefined) return rows
  if (phase.chits !== undefined && !settled(phase.state)) {
    const time = workflowCardTime(phase, input.now)
    const units = phase.chits
    const figures = [phase.count, units.running > 0 ? `${units.running} running` : undefined, units.parked > 0 ? `${units.parked} interrupted` : undefined, time === "" ? undefined : time].filter((part): part is string => part !== undefined)
    rows.push({ key: "focus", content: () => fitChunks([...workflowChitChunks(units, slots.phase, theme), stFg(theme.textMuted)(` ${figures.join(" · ")}`)], width) })
  } else if (phase.activity !== undefined) {
    const activity = phase.activity
    rows.push({ key: "focus", content: () => fitChunks([stFg(theme.text)(GAP), ...activityChunks(activity, theme)], width) })
  } else if (phase.state === "running" && phase.detail !== undefined) {
    const detail = phase.detail
    rows.push({ key: "focus", content: () => fitChunks([stFg(theme.text)(GAP), stFg(theme.textMuted)(detail.text)], width) })
  }
  const own = lines.filter((line): line is AgentLine | Extract<WorkflowCardLine, { readonly kind: "counted" }> => (line.kind === "agent" || line.kind === "counted") && line.phaseKey === phase.key)
  const longest = Math.max(0, ...own.map((line) => line.kind === "agent" ? 4 + displayWidth(line.label) : 0))
  const identityWidth = Math.min(longest + GAP.length, Math.floor((width - TIME_WIDTH - 1) / 2))
  // A narrow card has no room for a model: it keeps each agent's name, its
  // sentence while it runs, and its time.
  const layout: Layout = { inner: width, slots, identityWidth, modelWidth: 0, indent: "" }
  for (const line of own) rows.push(line.kind === "counted" ? countedRow(line, layout, theme) : agentRow(line, layout, input, line.detail?.kind === "activity" || (line.state === "running" && line.detail?.kind === "state")))
  return rows
}

/** What the full-size card reads beyond the inline card's input: the
 *  outline that it folded, whose seats and operations its lines name, the
 *  selected line, and whether the run opened a follow-up conversation. */
export interface WorkflowFullCardInput extends Omit<WorkflowCardInput, "hovered"> {
  readonly outline: WorkflowOutline
  /** Read as each line draws, so a new selection redraws the lines and
   *  folds nothing again. */
  readonly selected: () => string | undefined
  readonly followUp: boolean
}

/** The rows of the full-size card, and its plan bar, which stays at the
 *  foot of the viewer outside the scroller. */
export interface WorkflowFullCardRows {
  readonly rows: readonly WorkflowCardRow[]
  readonly bar: WorkflowCardRow | undefined
}

/** The rows of the full-size card in `width` columns: one line for each
 *  phase, with its model for a phase of one agent, and every agent of an
 *  expanded phase in item order, each with its own model, its brief and
 *  persona on a wide card, and its operations. The selected line carries
 *  the mark and the raised background. The plan bar is separate, because
 *  the viewer pins it under the lines it scrolls. */
export function workflowFullCardRows(input: WorkflowFullCardInput): WorkflowFullCardRows {
  const lines = workflowCardLines(input.card, { status: input.status, live: input.live, outline: input.outline, followUp: input.followUp, ...(input.choices === undefined ? {} : { choices: input.choices }) })
  const { theme } = input
  const inner = Math.max(24, input.width)
  const slots = CHIT_SLOTS.terminalFull
  const phases = lines.filter((line): line is PhaseLine => line.kind === "phase")
  const agents = lines.filter((line): line is AgentLine => line.kind === "agent")
  const model = ({ agentNodeId }: PhaseLine | AgentLine) => lineModel(agentNodeId, input)
  const roleShown = inner >= FULL_ROLE_WIDTH
  const titleWidth = columnWidth(phases.map(phaseTitle))
  const modelWidth = columnWidth(phases.map(model))
  const chitWidth = phases.some(({ chits }) => chits !== undefined) ? slots.phase + GAP.length : 0
  const labelWidth = columnWidth(agents.map(({ label }) => label))
  const roleWidth = roleShown ? columnWidth(agents.map(({ seat }) => workflowSeatRoleText(seat))) : 0
  const agentModelWidth = columnWidth(agents.map(model))
  const operations = (count: number | undefined) => count === undefined ? "" : workflowAgentOperations({ operations: count })
  const marked = (key: string, chunks: readonly TextChunk[]): TextChunk[] => {
    const selected = input.selected() === key
    const all = [stFg(theme.text)(selected ? "▸ " : " ".repeat(MARK_WIDTH)), ...chunks]
    return selected ? all.map((chunk) => stBg(theme.backgroundElement)(chunk)) : all
  }
  const rows: WorkflowCardRow[] = []
  let bar: WorkflowCardRow | undefined
  for (const line of lines) {
    switch (line.kind) {
      case "phase": {
        const time = workflowCardTime(line, input.now)
        const right = [stFg(theme.textMuted)(`${pad(operations(line.operations), OPERATIONS_WIDTH, "start")}${pad(line.count ?? "", COUNT_WIDTH + 1, "start")}${pad(time === "" ? "" : ` ${time}`, TIME_WIDTH, "start")}`)]
        const quiet = phaseQuietChunks(line, theme)
        const chits = line.chits === undefined ? [] : workflowChitChunks(line.chits, slots.phase, theme)
        const key = `phase:${line.key}`
        const action = phaseAction(line)
        rows.push({
          key,
          ...(action === undefined ? {} : { action }),
          content: (hovered) => marked(key, spread([
            ...head(line.state, "phaseName", phaseTitle(line), titleWidth, hovered && action !== undefined, theme),
            stFg(theme.textMuted)(pad(model(line), modelWidth, "end")),
            ...chits, stFg(theme.text)(" ".repeat(Math.max(0, chitWidth - chunksWidth(chits)))),
            ...quiet,
          ], right, inner - MARK_WIDTH, theme)),
        })
        break
      }
      case "agent": {
        const time = workflowCardTime(line, input.now)
        const right = [stFg(theme.textMuted)(`${pad(operations(line.operations), OPERATIONS_WIDTH, "start")}${pad(time, COUNT_WIDTH + 1 + TIME_WIDTH, "start")}`)]
        const key = `agent:${line.agentNodeId}`
        const action = line.opens ? { kind: "agent" as const, agentNodeId: line.agentNodeId, state: line.state } : undefined
        rows.push({
          key,
          phaseKey: line.phaseKey,
          ...(action === undefined ? {} : { action }),
          content: (hovered) => marked(key, spread([
            stFg(theme.borderSubtle)(`${TREE_INDENT}${line.last ? "└" : "├"} `),
            ...head(line.state, "agentName", line.label, labelWidth, hovered && action !== undefined, theme),
            stFg(theme.textMuted)(pad(roleShown ? workflowSeatRoleText(line.seat) : "", roleWidth, "end")),
            stFg(theme.textMuted)(pad(model(line), agentModelWidth, "end")),
            ...detailChunks(line.detail, theme),
          ], right, inner - MARK_WIDTH, theme)),
        })
        break
      }
      case "counted": {
        const row = countedRow(line, { inner: inner - MARK_WIDTH, slots, identityWidth: labelWidth, modelWidth: 0, indent: TREE_INDENT }, theme)
        rows.push({ ...row, phaseKey: line.phaseKey, content: (hovered) => marked(row.key, row.content(hovered)) })
        break
      }
      case "followUp":
        rows.push({ key: "followUp", action: { kind: "followUp" }, content: (hovered) => marked("followUp", [stFg(hovered ? theme.textBright : theme.textMuted)("↳ follow-up")]) })
        break
      case "bar":
        bar = { key: "bar", content: () => fitChunks([stFg(theme.text)(" ".repeat(MARK_WIDTH)), ...barChunks(line, slots.plan, false, inner - MARK_WIDTH, theme)], inner) }
        break
      case "notice":
      case "fold": break
    }
  }
  return { rows, bar }
}

/** The rows of a workflow card. Selecting an agent that started opens it
 *  through `onAction`, as does selecting a phase of one agent; selecting
 *  any other phase expands or folds it, and selecting
 *  its counted line lists every agent in place. Any other click falls
 *  through to the card, which opens the workflow. */
export function WorkflowCardBox(props: Omit<WorkflowCardInput, "now"> & {
  readonly now: () => number
  readonly onAction?: ((action: WorkflowCardAction) => void) | undefined
}) {
  const renderer = useRenderer()
  const rows = createMemo(() => workflowCardRows({ ...props, now: props.now() }))
  return (
    <box flexDirection="column" flexShrink={0}>
      {/* Rows keep their place as the clock ticks, so each tick rewrites
          only the text that changed. */}
      <Index each={rows()}>
        {(row) => {
          const hover = useHoverHighlight(() => row().action !== undefined && props.onAction !== undefined, hitsDrawnContent)
          const content = createMemo(() => new StyledText([...row().content(hover.hovered())]))
          const press = (event: MouseEvent) => {
            const action = row().action
            if (action === undefined || props.onAction === undefined || !hitsDrawnContent(event) || hasSelectedCells(renderer.getSelection())) return
            event.stopPropagation()
            props.onAction(action)
          }
          return (
            <box flexShrink={0} {...hover.handlers} onMouseUp={press}>
              <text ref={bindStyledTextContent(content)} wrapMode="none" overflow="hidden" />
            </box>
          )
        }}
      </Index>
    </box>
  )
}
