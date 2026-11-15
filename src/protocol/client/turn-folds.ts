import type { FrontendOutputBlock, FrontendToolEntry } from "../app-service-types.js"
import { blockIdentity } from "../block-identity.js"
import { isReturnedInputNotice } from "../composer-returns.js"
import type { HydratedOutputBlockBody } from "../transcript-protocol-types.js"
import { formatElapsed } from "./format.js"
import { isShellMutationEntry, presentsAsFileChange, selectFileChangeBody } from "./file-change-body.js"
import type { MutationFilesView } from "./mutation-evidence.js"
import { isReviewableSessionFile } from "./session-changes-copy.js"
import type { ReadRun } from "./tool-run-category.js"

/** The fold of a finished turn to its answer (PI-INTERACTION-053), shared by every client. A client presents the
 *  shared transcript model in its own rows; this rule reads only the parts of those rows that every client keeps. */

/** A row that a client presents over several calls under its own key, such as the web client's stretch group or the
 *  terminal's tool run. */
interface CallsRowOf<Kind extends string> {
  readonly kind: Kind
  readonly id: string
  readonly children: readonly FrontendToolEntry[]
  readonly timestamp: number
}
type CallsRow = CallsRowOf<"toolGroup"> | CallsRowOf<"toolRun">

/** The rows the fold reads: wire blocks and the rows that gather calls. */
export type FoldRow = FrontendOutputBlock | CallsRow

/** Presented rows with whether a divider renders before each, parallel to `rows`. */
export interface PresentedRows<Row> {
  readonly rows: readonly Row[]
  readonly boundaryBefore: readonly boolean[]
}

export interface TurnFold<Row = FoldRow> {
  readonly kind: "turnFold"
  readonly id: string
  /** The work the line stands for, without the rows that stay in view after it. */
  readonly rows: readonly Row[]
  readonly open: boolean
  readonly timestamp: number
  readonly duration: number
  /** The answer that follows the fold; none for a quiet turn, which ended without one (`foldsQuietTurns`). */
  readonly answerId?: string
  /** How many of the rows after the fold row belong to its turn before its answer: its work while it is open, else
   *  the rows that stay in view after it. */
  readonly held: number
}

/** A module's own words for its calls in a fold line: the phrases for the calls that it claims, and the calls that it
 *  leaves to the general counts. */
export type TurnCallPhrases = (calls: readonly FrontendToolEntry[]) => { readonly phrases: readonly string[]; readonly rest: readonly FrontendToolEntry[] }

/** Whether an entry, named by its entry id, starts a turn that no person asked for, such as a message that the runtime
 *  posts to the session. Such a turn ends the turn before it and never folds. */
export type TurnStart = (entryId: string) => boolean

/** How a module presents the transcript of its own session: finished turns fold, the calls named in `hidden` never
 *  show and never count, `phrases` words the module's calls in the fold line, `startsTurn` names the entries that
 *  start a turn of their own, and with `foldsQuietTurns` a finished turn that ends without an answer folds to its line
 *  alone. */
export interface TurnFoldPresentation {
  readonly hidden: ReadonlySet<string>
  readonly phrases?: TurnCallPhrases
  readonly startsTurn?: TurnStart
  readonly foldsQuietTurns?: boolean
}

/** The parts of a presentation that decide where turns start and which turns fold. */
type TurnRules = Pick<TurnFoldPresentation, "startsTurn" | "foldsQuietTurns">

export type TurnFileEdit = { readonly callId: string; readonly evidence: NonNullable<FrontendToolEntry["mutationEvidence"]>; readonly entry: Extract<MutationFilesView["files"][number], { kind: "applied" | "display" }> }

/** The key a row renders under. A row that gathers others borrows its stretch's identity, so it stays mounted as more
 *  calls join it. */
export function rowIdentity(row: FoldRow | TurnFold<unknown> | ReadRun): string {
  return row.kind === "toolGroup" || row.kind === "toolRun" || row.kind === "turnFold" || row.kind === "readRun" ? row.id : blockIdentity(row)
}

const personMessage = (row: FoldRow) => row.kind === "userMessage" && !row.pending && !row.injected && row.from === undefined
/** The first row of a turn that the runtime started, which no person message opens (`turnStart`). */
const runtimeTurnStart = (row: FoldRow): boolean => row.kind === "toolGroup" || row.kind === "toolRun" ? row.children.some(child => child.turnStart === true) : "turnStart" in row && row.turnStart === true
/** The row that opens a turn that folds: the person's message, or the first row of a turn that the runtime started. */
const opensTurn = (row: FoldRow) => personMessage(row) || runtimeTurnStart(row)
const entryIds = (row: FoldRow): readonly string[] => row.kind === "toolGroup" || row.kind === "toolRun" ? row.children.map(child => child.id) : row.kind === "tool" || row.kind === "userMessage" ? [row.id] : []
const isWork = (row: FoldRow) => row.kind === "toolGroup" || row.kind === "toolRun" || row.kind === "tool" || row.kind === "agentGroup" || row.kind === "thinking" || row.kind === "text" || row.kind === "question"
/** A workflow card stays in view after its turn folds, in its finished
 *  form: it says what the workflow did, which the fold line cannot. */
const isWorkflowCard = (row: FoldRow) => row.kind === "agentGroup" && row.containerKind === "workflow"
const staysVisible = (row: FoldRow) => isWorkflowCard(row) || (row.kind === "system" && isReturnedInputNotice(row.id))
const hasError = (row: FoldRow): boolean => {
  if (row.kind === "system") return row.level === "error"
  if (row.kind === "agentGroup") return row.status === "error"
  return false
}

/** Presents settled turns without changing the shared transcript model. A
 *  folded turn shows its fold line, then the cards of the workflows it
 *  launched and unread person input, then its answer. A turn that holds a row named in `openedInside`
 *  arrives open; `choice` is the person's open or closed choice of a fold, or
 *  undefined without one, and it wins over how the fold arrived. */
export function foldTurns<Row extends FoldRow>(view: PresentedRows<Row>, atRest: boolean, choice: (id: string) => boolean | undefined = () => undefined, settledIds: ReadonlySet<string> = new Set(), openedInside: ReadonlySet<string> = new Set(), turns: TurnRules = {}): PresentedRows<Row | TurnFold<Row>> {
  const startsTurn = turns.startsTurn ?? (() => false)
  const bounds = (row: Row) => opensTurn(row) || entryIds(row).some(startsTurn)
  const rows: (Row | TurnFold<Row>)[] = []
  const boundaryBefore: boolean[] = []
  const append = (start: number, end: number) => {
    rows.push(...view.rows.slice(start, end))
    boundaryBefore.push(...view.boundaryBefore.slice(start, end))
  }
  let start = 0
  while (start < view.rows.length) {
    const person = view.rows[start]
    const workStart = person !== undefined && personMessage(person) ? start + 1 : start
    let end = workStart
    // SAFETY: the loop condition keeps end inside view.rows.
    while (end < view.rows.length && (end === start || !bounds(view.rows[end]!))) end += 1
    const span = view.rows.slice(workStart, end)
    const workEnd = span.findLastIndex(isWork) + 1
    // A turn whose work follows its last text ended without an answer: on a tab that folds such a turn, all of its work
    // folds, and what follows its work, such as the notice of a cut, stays in view as an answer does.
    const answered = span[workEnd - 1]?.kind === "text"
    const answerOffset = answered ? workEnd - 1 : workEnd
    const answer = answered ? span[answerOffset] : undefined
    const last = answer ?? span.at(-1)
    const id = last === undefined ? undefined : turnFoldId(last)
    const foldable = person !== undefined && opensTurn(person) && id !== undefined && last !== undefined && (answered || turns.foldsQuietTurns === true)
      && (atRest || settledIds.has(id))
      && span.slice(0, answerOffset).some(row => isWork(row) && !isWorkflowCard(row))
      && !span.some(hasError)
      && !span.some(row => row.kind === "question" && row.answers === undefined && row.cancelled !== true)
    if (!foldable || last === undefined || id === undefined || person === undefined) append(start, end)
    else {
      append(start, workStart)
      const hidden = span.slice(0, answerOffset)
      const open = choice(id) ?? span.some(row => openedInside.has(rowIdentity(row)))
      const kept = hidden.filter(staysVisible)
      rows.push({
        kind: "turnFold", id, rows: hidden.filter(row => !staysVisible(row)), open,
        ...(answer === undefined ? {} : { answerId: rowIdentity(answer) }),
        held: open ? hidden.length : kept.length,
        timestamp: person.timestamp,
        duration: Math.max(0, last.timestamp - person.timestamp),
      })
      boundaryBefore.push(false)
      if (open) append(workStart, workStart + answerOffset)
      else for (const row of kept) {
        rows.push(row)
        boundaryBefore.push(false)
      }
      const answerIndex = boundaryBefore.length
      append(workStart + answerOffset, end)
      if (!open && answer !== undefined) boundaryBefore[answerIndex] = false
    }
    start = end
  }
  return { rows, boundaryBefore }
}

const turnFoldId = (answer: FoldRow) => `turnFold:${rowIdentity(answer)}`

/** Folds successive windows of one transcript. Person messages can arrive
 *  mid-turn and the wire carries no turn id, so only folds observed at rest
 *  survive a later running frame. A window can open inside a turn, and an
 *  older page that brings its person message must not fold away rows the
 *  reader has seen: that turn arrives as an open fold, found by the first row
 *  the window showed of it, which holds while the turn runs and its answer
 *  changes. The resident session owns this memory through window recovery
 *  and a return from another session. */
export function createTurnFolds(turns: TurnRules = {}) {
  let settled: ReadonlySet<string> = new Set()
  let openedInside: ReadonlySet<string> = new Set()
  return <Row extends FoldRow>(view: PresentedRows<Row>, atRest: boolean, choice: (id: string) => boolean | undefined): PresentedRows<Row | TurnFold<Row>> => {
    const opening = view.rows[0]
    const kept = new Set<string>()
    if (opening !== undefined && !opensTurn(opening)) kept.add(rowIdentity(opening))
    if (openedInside.size > 0) {
      for (const row of view.rows) {
        const id = rowIdentity(row)
        if (openedInside.has(id)) kept.add(id)
      }
    }
    openedInside = kept
    const folded = foldTurns(view, atRest, choice, settled, openedInside, turns)
    const folds = new Set<string>()
    for (const row of folded.rows) if (row.kind === "turnFold") folds.add(row.id)
    settled = folds
    return folded
  }
}

/** The parent calls in transcript order, without delegated children. */
export function turnCalls(fold: Pick<TurnFold, "rows">): readonly FrontendToolEntry[] {
  return fold.rows.flatMap(row => row.kind === "toolGroup" || row.kind === "toolRun" ? row.children : row.kind === "tool" ? [row] : [])
}

/** The turn's own retained mutations, grouped by path in call order. */
export function turnChangedFiles(fold: Pick<TurnFold, "rows">, bodies: { readonly [id: string]: HydratedOutputBlockBody } = {}, location = { projectRoot: "", executionCwd: "" }, metadata: ReadonlyMap<string, MutationFilesView> = new Map()) {
  const files = new Map<string, { path: string; added: number; removed: number; edits: TurnFileEdit[]; partial: boolean; omissions: string[] }>()
  const fileAt = (path: string, displayPath = path) => {
    const absolute = /^(?:[\\/]|[A-Za-z]:)/.test(path) ? path : `${location.executionCwd}/${path}`
    const segments: string[] = []
    for (const segment of absolute.split(/[\\/]+/)) {
      if (segment === "..") segments.pop()
      else if (segment !== ".") segments.push(segment)
    }
    if (!isReviewableSessionFile(segments.join("/"), `${location.projectRoot.replace(/\\/g, "/").replace(/\/$/, "")}/.flywheel`)) return undefined
    const identity = /^[A-Za-z]:/.test(absolute) ? segments.join("/").toLowerCase() : segments.join("/")
    let file = files.get(identity)
    if (file === undefined) {
      file = { path: displayPath, added: 0, removed: 0, edits: [], partial: false, omissions: [] }
      files.set(identity, file)
    }
    return file
  }
  const calls = turnCalls(fold)
  for (const call of calls) {
    const body = selectFileChangeBody(call, undefined, bodies[call.id])
    if (body.kind !== "actual") continue
    for (const entry of metadata.get(call.id)?.files ?? []) {
      if (entry.kind === "omitted") {
        const file = fileAt(entry.path, entry.displayPath)
        if (file !== undefined) { file.partial = true; file.omissions.push(entry.reason.replace(/_/g, " ")) }
        continue
      }
      if (entry.kind !== "applied" && entry.kind !== "display") continue
      const evidence = entry.file
      const file = fileAt(evidence.path, evidence.displayPath)
      if (file === undefined) continue
      file.added += evidence.addedLines
      file.removed += evidence.removedLines
      file.partial ||= evidence.omittedLines > 0 || evidence.patch.kind !== "retained"
      if (evidence.patch.kind === "omitted") file.omissions.push(evidence.patch.reason.replace(/_/g, " "))
      else file.edits.push({ callId: call.id, evidence: body.mutationEvidence, entry })
    }
  }
  return [...files.values()]
}

/** Counts displayed calls and unique project file mutations, not child work. */
export function toolWorkCounts(children: readonly FrontendToolEntry[], metadata: ReadonlyMap<string, MutationFilesView> = new Map()) {
  const commands = children.filter((child) => child.action === "shell_exec" && !isShellMutationEntry(child)).length
  const tools = children.length - commands
  const failed = children.filter((child) => child.status === "error" || (child.exitCode !== undefined && child.exitCode !== 0)).length
  const interrupted = children.filter((child) => child.status === "interrupted").length
  const fileCalls = children.filter(presentsAsFileChange)
  const complete = fileCalls.every(child => (child.mutationEvidence === undefined && !metadata.has(child.id))
    || (metadata.get(child.id)?.status === "ready" && metadata.get(child.id)?.nextOffset === null))
  const editedFiles = new Set(fileCalls.flatMap(child =>
    metadata.get(child.id)?.files.flatMap(entry => entry.kind === "applied" || entry.kind === "display" ? [entry.file.path] : entry.kind === "omitted" ? [entry.path] : []) ?? [])).size
  return { commands, tools, failed, interrupted, editedFiles, complete }
}

/** The folded work's single label, built from the same tally as tool headings. A module's `phrases` come first and
 *  take its calls out of the general counts; failures still count every call. */
export function turnFoldSummary(fold: Pick<TurnFold, "rows" | "duration">, metadata?: ReadonlyMap<string, MutationFilesView>, phrases?: TurnCallPhrases) {
  const calls = turnCalls(fold)
  const own = phrases?.(calls) ?? { phrases: [], rest: calls }
  const { commands, tools, editedFiles, complete } = toolWorkCounts(own.rest, metadata)
  const { failed } = toolWorkCounts(calls)
  const subagents = fold.rows.filter(row => row.kind === "agentGroup" && row.containerKind === "subagent").length
  const parts: string[] = [...own.phrases]
  if (commands) parts.push(`ran ${commands} command${commands === 1 ? "" : "s"}`)
  if (editedFiles) parts.push(`edited ${editedFiles} file${editedFiles === 1 ? "" : "s"}${complete ? "" : " (incomplete)"}`)
  else if (!complete) parts.push("file count incomplete")
  if (tools) parts.push(`used ${tools} tool${tools === 1 ? "" : "s"}`)
  if (subagents) parts.push(`${subagents} subagent${subagents === 1 ? "" : "s"}`)
  return { label: `Worked ${formatElapsed(fold.duration)}${parts.length ? ` · ${parts.join(", ")}` : ""}`, failed }
}
