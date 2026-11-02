import { formatElapsed } from "../../../src/protocol/client/format.js"
import { rowIdentity, toolWorkCounts, type TranscriptView, type TranscriptViewRow } from "./tool-runs.js"
import { selectFileChangeBody } from "../../../src/protocol/client/file-change-body.js"
import type { HydratedOutputBlockBody } from "../../../src/protocol/transcript-protocol-types.js"
import { isReviewableSessionFile } from "../../../src/protocol/client/session-changes-copy.js"
import type { MutationFilesView } from "../../../src/protocol/client/mutation-evidence.js"
import type { FrontendToolEntry } from "../../../src/protocol/app-service-types.js"
import { isReturnedInputNotice } from "../../../src/protocol/composer-returns.js"

export type TurnFileEdit = { readonly callId: string; readonly evidence: NonNullable<FrontendToolEntry["mutationEvidence"]>; readonly entry: Extract<MutationFilesView["files"][number], { kind: "applied" | "display" }> }

export interface TurnFold {
  readonly kind: "turnFold"
  readonly id: string
  readonly rows: readonly TranscriptViewRow[]
  readonly open: boolean
  readonly timestamp: number
  readonly duration: number
  readonly answerId: string
}

const personMessage = (row: TranscriptViewRow) => row.kind === "userMessage" && !row.pending && !row.injected && row.from === undefined
const isWork = (row: TranscriptViewRow) => row.kind === "toolGroup" || row.kind === "tool" || row.kind === "agentGroup" || row.kind === "thinking" || row.kind === "text" || row.kind === "question"
/** A workflow card stays in view after its turn folds, in its finished
 *  form: it says what the workflow did, which the fold line cannot. */
const isWorkflowCard = (row: TranscriptViewRow) => row.kind === "agentGroup" && row.containerKind === "workflow"
const staysVisible = (row: TranscriptViewRow) => isWorkflowCard(row) || (row.kind === "system" && isReturnedInputNotice(row.id))
const hasError = (row: TranscriptViewRow): boolean => {
  if (row.kind === "system") return row.level === "error"
  if (row.kind === "agentGroup") return row.status === "error"
  return false
}

/** Presents settled turns without changing the shared transcript model. A
 *  folded turn shows its fold line, then the cards of the workflows it
 *  launched and unread person input, then its answer. A turn that holds a row named in `openedInside`
 *  arrives open; `choice` is the person's open or closed choice of a fold, or
 *  undefined without one, and it wins over how the fold arrived. */
export function foldWebTurns<Row extends TranscriptViewRow>(view: TranscriptView<Row>, atRest: boolean, choice: (id: string) => boolean | undefined = () => undefined, settledIds: ReadonlySet<string> = new Set(), openedInside: ReadonlySet<string> = new Set()): TranscriptView<Row | TurnFold> {
  const rows: (Row | TurnFold)[] = []
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
    while (end < view.rows.length && !personMessage(view.rows[end]!)) end += 1
    const span = view.rows.slice(workStart, end)
    const answerOffset = span.findLastIndex(row => row.kind === "text")
    const answer = span[answerOffset]
    const id = answer === undefined ? undefined : turnFoldId(answer)
    const foldable = person !== undefined && personMessage(person) && id !== undefined && (atRest || settledIds.has(id)) && answer !== undefined
      && span.slice(0, answerOffset).some(row => isWork(row) && !isWorkflowCard(row))
      && !span.slice(answerOffset + 1).some(isWork) && !span.some(hasError)
      && !span.some(row => row.kind === "question" && row.answers === undefined && row.cancelled !== true)
    if (!foldable || answer === undefined || id === undefined || person === undefined) append(start, end)
    else {
      append(start, workStart)
      const hidden = span.slice(0, answerOffset)
      const open = choice(id) ?? span.some(row => openedInside.has(rowIdentity(row)))
      rows.push({
        kind: "turnFold", id, rows: hidden.filter(row => !staysVisible(row)), open, answerId: rowIdentity(answer),
        timestamp: person.timestamp,
        duration: answer.timestamp - person.timestamp,
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

const turnFoldId = (answer: TranscriptViewRow) => `turnFold:${rowIdentity(answer)}`

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
  return <Row extends TranscriptViewRow>(view: TranscriptView<Row>, atRest: boolean, choice: (id: string) => boolean | undefined): TranscriptView<Row | TurnFold> => {
    const opening = view.rows[0]
    const kept = new Set<string>()
    if (opening !== undefined && !personMessage(opening)) kept.add(rowIdentity(opening))
    if (openedInside.size > 0) {
      for (const row of view.rows) {
        const id = rowIdentity(row)
        if (openedInside.has(id)) kept.add(id)
      }
    }
    openedInside = kept
    const folded = foldWebTurns(view, atRest, choice, settled, openedInside)
    const folds = new Set<string>()
    for (const row of folded.rows) if (row.kind === "turnFold") folds.add(row.id)
    settled = folds
    return folded
  }
}

/** The parent calls in transcript order, without delegated children. */
export function turnCalls(fold: Pick<TurnFold, "rows">) {
  return fold.rows.flatMap(row => row.kind === "toolGroup" ? row.children : row.kind === "tool" ? [row] : [])
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

/** The folded work's single label, built from the same tally as tool headings. */
export function turnFoldSummary(fold: Pick<TurnFold, "rows" | "duration">, metadata?: ReadonlyMap<string, MutationFilesView>) {
  const calls = turnCalls(fold)
  const { commands, tools, editedFiles, failed, complete } = toolWorkCounts(calls, metadata)
  const subagents = fold.rows.filter(row => row.kind === "agentGroup" && row.containerKind === "subagent").length
  const parts: string[] = []
  if (commands) parts.push(`ran ${commands} command${commands === 1 ? "" : "s"}`)
  if (editedFiles) parts.push(`edited ${editedFiles} file${editedFiles === 1 ? "" : "s"}${complete ? "" : " (incomplete)"}`)
  else if (!complete) parts.push("file count incomplete")
  if (tools) parts.push(`used ${tools} tool${tools === 1 ? "" : "s"}`)
  if (subagents) parts.push(`${subagents} subagent${subagents === 1 ? "" : "s"}`)
  return { label: `Worked ${formatElapsed(fold.duration)}${parts.length ? ` · ${parts.join(", ")}` : ""}`, failed }
}
