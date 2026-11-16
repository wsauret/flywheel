import type { FrontendOutputBlock, FrontendToolEntry } from "../app-service-types.js"
import { blockIdentity } from "../block-identity.js"
import { isReturnedInputNotice } from "../composer-returns.js"
import type { HydratedOutputBlockBody } from "../transcript-protocol-types.js"
import { formatElapsed } from "./format.js"
import { isShellMutationEntry, presentsAsFileChange, selectFileChangeBody } from "./file-change-body.js"
import type { MutationFilesView } from "./mutation-evidence.js"
import { isReviewableSessionFile } from "./session-changes-copy.js"
import type { ReadRun } from "./tool-run-category.js"

/** The fold of a finished turn to its answer on the web client (PI-INTERACTION-053), and the headings over stretches of
 *  calls on the lead's tab in the terminal (PI-LEAD-017). A client presents the shared transcript model in its own rows;
 *  these rules read only the parts of those rows that every client keeps. */

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
  readonly answerId: string
}

/** One stretch of calls under its heading (PI-LEAD-017): the calls and thoughts between two other rows. */
export interface CallStretch<Row = FoldRow> {
  readonly kind: "callStretch"
  readonly id: string
  /** The stretch's rows, which show beneath the heading while it is open. */
  readonly rows: readonly Row[]
  readonly open: boolean
  /** Whether the stretch still runs: it ends the transcript while the agent works, so its calls can still grow. */
  readonly live: boolean
  /** When the first call of the stretch started. */
  readonly timestamp: number
  readonly duration: number
}

/** A module's own words for its calls in a fold line or a heading: the phrases for the calls that it claims, and the calls that it
 *  leaves to the general counts. */
export type TurnCallPhrases = (calls: readonly FrontendToolEntry[]) => { readonly phrases: readonly string[]; readonly rest: readonly FrontendToolEntry[] }

/** Whether an entry, named by its entry id, starts a turn that no person asked for, such as a message that the runtime
 *  posts to the session. Such a message ends the stretch of calls before it. */
export type TurnStart = (entryId: string) => boolean

/** How a module presents the transcript of its own session in the terminal: each stretch of calls gathers under one
 *  heading (`gatherCallStretches`), the calls named in `hidden` never show and never count, `phrases` words the
 *  module's calls in the heading, and `startsTurn` names the entries that start a turn of their own. */
export interface CallStretchPresentation {
  readonly hidden: ReadonlySet<string>
  readonly phrases?: TurnCallPhrases
  readonly startsTurn?: TurnStart
}

export type TurnFileEdit = { readonly callId: string; readonly evidence: NonNullable<FrontendToolEntry["mutationEvidence"]>; readonly entry: Extract<MutationFilesView["files"][number], { kind: "applied" | "display" }> }

/** The key a row renders under. A row that gathers others borrows its stretch's identity, so it stays mounted as more
 *  calls join it. */
export function rowIdentity(row: FoldRow | TurnFold<unknown> | CallStretch<unknown> | ReadRun): string {
  return row.kind === "toolGroup" || row.kind === "toolRun" || row.kind === "turnFold" || row.kind === "callStretch" || row.kind === "readRun" ? row.id : blockIdentity(row)
}

const personMessage = (row: FoldRow) => row.kind === "userMessage" && !row.pending && !row.injected && row.from === undefined
/** The first row of a turn that the runtime started, which no person message opens (`turnStart`). */
const runtimeTurnStart = (row: FoldRow): boolean => row.kind === "toolGroup" || row.kind === "toolRun" ? row.children.some(child => child.turnStart === true) : "turnStart" in row && row.turnStart === true
/** The row that opens a turn that folds: the person's message, or the first row of a turn that the runtime started. */
const opensTurn = (row: FoldRow) => personMessage(row) || runtimeTurnStart(row)
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
export function foldTurns<Row extends FoldRow>(view: PresentedRows<Row>, atRest: boolean, choice: (id: string) => boolean | undefined = () => undefined, settledIds: ReadonlySet<string> = new Set(), openedInside: ReadonlySet<string> = new Set()): PresentedRows<Row | TurnFold<Row>> {
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
    while (end < view.rows.length && (end === start || !opensTurn(view.rows[end]!))) end += 1
    const span = view.rows.slice(workStart, end)
    // The answer is the turn's last work, and it is text: a turn whose work follows its last text has no answer.
    const answerOffset = span.findLastIndex(isWork)
    const answer = span[answerOffset]?.kind === "text" ? span[answerOffset] : undefined
    const id = answer === undefined ? undefined : turnFoldId(answer)
    const foldable = person !== undefined && opensTurn(person) && answer !== undefined && id !== undefined
      && (atRest || settledIds.has(id))
      && span.slice(0, answerOffset).some(row => isWork(row) && !isWorkflowCard(row))
      && !span.some(hasError)
      && !span.some(row => row.kind === "question" && row.answers === undefined && row.cancelled !== true)
    if (!foldable || answer === undefined || id === undefined || person === undefined) append(start, end)
    else {
      append(start, workStart)
      const hidden = span.slice(0, answerOffset)
      const open = choice(id) ?? span.some(row => openedInside.has(rowIdentity(row)))
      rows.push({
        kind: "turnFold", id, rows: hidden.filter(row => !staysVisible(row)), open, answerId: rowIdentity(answer),
        timestamp: person.timestamp,
        duration: Math.max(0, answer.timestamp - person.timestamp),
      })
      boundaryBefore.push(false)
      if (open) append(workStart, workStart + answerOffset)
      else for (const row of hidden.filter(staysVisible)) {
        rows.push(row)
        boundaryBefore.push(false)
      }
      const answerIndex = boundaryBefore.length
      append(workStart + answerOffset, end)
      if (!open) boundaryBefore[answerIndex] = false
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
export function createTurnFolds() {
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
    const folded = foldTurns(view, atRest, choice, settled, openedInside)
    const folds = new Set<string>()
    for (const row of folded.rows) if (row.kind === "turnFold") folds.add(row.id)
    settled = folds
    return folded
  }
}

const isCall = (row: FoldRow) => row.kind === "tool" || row.kind === "toolRun" || row.kind === "toolGroup"
const inStretch = (row: FoldRow) => isCall(row) || row.kind === "thinking"

/** Gathers each stretch of calls under one heading at its place (PI-LEAD-017). A stretch starts at a call and holds
 *  the calls and thoughts that follow it; every other row, such as the agent's words, a message, or a question, ends it
 *  and stays in view, and so do thoughts before its first call, so a thought in view never moves under a heading.
 *  `running` says that the rows end at the transcript's tail while the agent works: the stretch that ends them is then
 *  live and arrives open, and every other stretch arrives closed. `choice` is the person's open or closed choice of a
 *  heading, or undefined without one, and it wins. A heading keys on its stretch's first call, so the choice holds
 *  while the stretch grows. The stretch lasts from its first call to the last start or end of its rows, or to the
 *  agent's next words when they follow it. */
export function gatherCallStretches<Row extends FoldRow>(view: PresentedRows<Row>, running: boolean, choice: (id: string) => boolean | undefined = () => undefined): PresentedRows<Row | CallStretch<Row>> {
  const rows: (Row | CallStretch<Row>)[] = []
  const boundaryBefore: boolean[] = []
  let start = 0
  while (start < view.rows.length) {
    // SAFETY: the loop condition keeps start inside view.rows.
    const first = view.rows[start]!
    let end = start
    // SAFETY: the loop condition keeps end inside view.rows.
    if (isCall(first)) while (end < view.rows.length && inStretch(view.rows[end]!)) end += 1
    if (end === start) {
      rows.push(first)
      boundaryBefore.push(view.boundaryBefore[start] ?? false)
      start += 1
      continue
    }
    const members = view.rows.slice(start, end)
    const id = `callStretch:${rowIdentity(first)}`
    const following = view.rows[end]
    const calls = turnCalls({ rows: members })
    const ends = [...members.map(row => row.timestamp), ...calls.map(call => call.timestamp), ...calls.flatMap(call => call.endedAt ?? []), ...following?.kind === "text" ? [following.timestamp] : []]
    const live = running && following === undefined
    rows.push({ kind: "callStretch", id, rows: members, open: choice(id) ?? live, live, timestamp: first.timestamp, duration: Math.max(0, ...ends) - first.timestamp })
    boundaryBefore.push(view.boundaryBefore[start] ?? false)
    start = end
  }
  return { rows, boundaryBefore }
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
 *  take its calls out of the general counts; failures still count every call. Work that still runs (`live`) reads
 *  "Working", with no duration, because its duration cannot grow while a call is pending. */
export function turnFoldSummary(fold: Pick<TurnFold, "rows" | "duration"> & { readonly live?: boolean }, metadata?: ReadonlyMap<string, MutationFilesView>, phrases?: TurnCallPhrases) {
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
  return { label: `${fold.live === true ? "Working" : `Worked ${formatElapsed(fold.duration)}`}${parts.length ? ` · ${parts.join(", ")}` : ""}`, failed }
}
