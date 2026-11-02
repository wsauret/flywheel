import { isAgentInFlight } from "../../infra/output-blocks.js"
import type { FrontendMessageSender, FrontendOutputBlock, FrontendToolEntry } from "../app-service-types.js"
import { blockIdentity } from "../block-identity.js"
import { toolRunCategoryFor } from "./tool-run-category.js"

/** The transcript model every viewer shows. One fold over a window of blocks
 *  decides what is a row, in what order, which blocks render on no client,
 *  where a divider falls, and which messages are still queued. The
 *  terminal and the web client differ only in how they present a row: the
 *  terminal splits a stretch of tool work into Explored, Ran, and Executed
 *  runs and pins queued messages under the timeline; the web shows one counted
 *  heading per stretch and keeps queued messages in place. Neither client
 *  decides content, so a transcript reads the same wherever it is opened. */

type FrontendThinkingBlock = Extract<FrontendOutputBlock, { kind: "thinking" }>
type FrontendUserMessageBlock = Extract<FrontendOutputBlock, { kind: "userMessage" }>

/** Visual activity includes managed work after its launching call completes.
 * Process membership comes from live status, never the saved background flag.
 * This does not change the transcript fold or its narration dividers. Only a
 * shell command is ever held, so a held call offers Detach whatever its name. */
export function toolActivity(
  entry: Pick<FrontendToolEntry, "status">,
  process: { readonly held: boolean; readonly managed: boolean },
) {
  const control = process.held ? "detach" : process.managed ? "stop" : undefined
  return { active: entry.status === "pending" || entry.status === "streaming" || control !== undefined, control } as const
}

/** The note on the row of a command that waits for processor time. */
export const PROCESSOR_WAIT_NOTE = "Waiting for CPU"

/** Whether a row shows that its command waits for processor time
 *  (PI-AGENT-052). Processor admission can hold a foreground or a background
 *  shell command. A held command is still running work, so the hold adds the
 *  note and changes nothing else: the row keeps its running marker and its
 *  control. A row that has stopped running never shows the note, even when
 *  the status has not yet dropped its id. */
export function waitsForProcessor(activity: { readonly active: boolean }, processorHeld: boolean): boolean {
  return activity.active && processorHeld
}

type CommandMessage = FrontendUserMessageBlock & { readonly from: FrontendMessageSender }

/** A call, a session message, or a visible thought inside command activity. */
export type StretchMember = FrontendToolEntry | FrontendThinkingBlock | CommandMessage

/** Consecutive tool work between two things the agent said or was told. A
 *  visible thought between calls rides inside the stretch; an assistant
 *  message, a subagent, a question, or a delivered human or parent message ends it and
 *  stamps `endTimestamp`. A script the agent ran through the code tool is
 *  never a member: its calls are, and an interrupted script trails them as a
 *  carrier so the run reads as interrupted. */
export interface ToolStretch {
  readonly kind: "toolStretch"
  /** The identity of the block that opened the stretch, a call or a script. */
  readonly id: string
  readonly members: readonly StretchMember[]
  /** The identities of the scripts whose calls the stretch holds. A script
   *  renders nowhere, yet it belongs to the stretch: a viewer that keyed a
   *  row on one finds it here after an older call opens the stretch. */
  readonly scriptIds: readonly string[]
  /** Absolute block index of each member, parallel to `members`. */
  readonly memberBlockIndices: readonly number[]
  readonly status: "active" | "interrupted" | "completed"
  readonly timestamp: number
  readonly endTimestamp?: number
}

/** A row of the transcript: any block that is not a call, or a stretch of calls. */
export type TranscriptRow = Exclude<FrontendOutputBlock, FrontendToolEntry> | ToolStretch

/** Where a window sits inside the absolute transcript. A slice hands in the
 *  block and the row just before it, so a prefix fold followed by a suffix
 *  fold equals one fold of the whole, as long as the seam sits after a block
 *  that closes a stretch. */
export interface TranscriptWindow {
  readonly startBlockIndex: number
  readonly predecessorBlock: FrontendOutputBlock | null
  readonly predecessorRow: TranscriptRow | null
}

const WHOLE_TRANSCRIPT: TranscriptWindow = { startBlockIndex: 0, predecessorBlock: null, predecessorRow: null }

export interface TranscriptModel {
  readonly rows: readonly TranscriptRow[]
  /** Absolute index of the first block each row represents, parallel to `rows`. */
  readonly sourceBlockIndices: readonly number[]
  /** Whether a divider renders before each row, parallel to `rows`. */
  readonly boundaryBefore: readonly boolean[]
  /** Blocks no client renders as a row: hidden thoughts, settled scripts,
   *  queued messages, and a shell call whose command text has not arrived. */
  readonly zeroHeightBlockIndices: readonly number[]
  /** Messages the person sent that the runtime has not delivered yet. */
  readonly pendingBlocks: readonly FrontendUserMessageBlock[]
}

/** A block that closes an open stretch. Thoughts never do: a visible one rides
 *  inside the stretch and a hidden one is not there; the seam between two
 *  slices must therefore fall after one of these. */
export function closesToolStretch(block: FrontendOutputBlock): boolean {
  if (block.kind === "tool" || block.kind === "thinking") return false
  if (block.kind === "userMessage" && (block.pending || isCommandMessage(block))) return false
  return true
}

function isCommandMessage(block: FrontendOutputBlock): block is CommandMessage {
  return block.kind === "userMessage" && block.from !== undefined && block.from.relation !== "parent"
}

/** Finalized tool work that narration can resume after: a settled stretch
 *  whose last non-message member is a call, or a settled subagent. A
 *  stretch that ends in a visible thought is not, so the narration that
 *  follows the thought starts no new step. */
function narrationResumesAfter(row: TranscriptRow): boolean {
  if (row.kind === "toolStretch") return row.status !== "active" && row.members.findLast(member => member.kind !== "userMessage")?.kind === "tool"
  if (row.kind === "agentGroup") return !isAgentInFlight(row.status)
  return false
}

function stretchStatus(members: readonly StretchMember[]): ToolStretch["status"] {
  let interrupted = false
  for (const member of members) {
    if (member.kind !== "tool") continue
    if (member.status === "pending" || member.status === "streaming") return "active"
    if (member.status === "interrupted") interrupted = true
  }
  return interrupted ? "interrupted" : "completed"
}

/** A shell call shows once its command text has arrived, unless it continues
 *  a run of shell calls, where the row it grows into already exists. */
function awaitsCommandText(block: FrontendToolEntry, previousCall: FrontendToolEntry | null): boolean {
  return block.action === "shell_exec" && block.status === "streaming" && block.presentation.detail === ""
    && toolRunCategoryFor(block) === "exec" && previousCall?.action !== "shell_exec"
}

interface OpenStretch {
  readonly id: string
  readonly members: StretchMember[]
  readonly scriptIds: string[]
  readonly indices: number[]
}

export function foldTranscript(blocks: readonly FrontendOutputBlock[], showThinking: boolean | undefined, window: TranscriptWindow = WHOLE_TRANSCRIPT): TranscriptModel {
  const rows: TranscriptRow[] = []
  const sourceBlockIndices: number[] = []
  const boundaryBefore: boolean[] = []
  const zeroHeightBlockIndices: number[] = []
  const pendingBlocks: FrontendUserMessageBlock[] = []
  let prior = window.predecessorRow

  const pushRow = (row: TranscriptRow, sourceBlockIndex: number): void => {
    rows.push(row)
    sourceBlockIndices.push(sourceBlockIndex)
    boundaryBefore.push(prior !== null && row.kind === "text" && narrationResumesAfter(prior))
    prior = row
  }

  // A run of shell calls that opened before the window continues into it, so
  // the seed is the predecessor until the window itself opens or closes one.
  let seedCall: FrontendToolEntry | null = window.predecessorBlock?.kind === "tool" ? window.predecessorBlock : null
  // Assigned inside the helpers below, so the loop reads it through one too:
  // a direct read would be narrowed to the initial null.
  let open: OpenStretch | null = null
  const current = (): OpenStretch | null => open
  const lastCall = (): FrontendToolEntry | null => {
    const stretch = current()
    if (stretch === null) return seedCall
    for (let i = stretch.members.length - 1; i >= 0; i -= 1) {
      const member = stretch.members[i]
      if (member?.kind === "tool") return member
    }
    return seedCall
  }
  const openStretch = (anchor: FrontendOutputBlock): OpenStretch => {
    seedCall = null
    open ??= { id: blockIdentity(anchor), members: [], scriptIds: [], indices: [] }
    return open
  }
  const closeStretch = (endTimestamp: number | undefined): void => {
    seedCall = null
    if (open === null) return
    const { id, members, scriptIds, indices } = open
    open = null
    const first = members[0]
    const firstIndex = indices[0]
    // A settled script that made no calls opened a stretch and left nothing in it.
    if (first === undefined || firstIndex === undefined) return
    pushRow({
      kind: "toolStretch",
      id,
      members,
      scriptIds,
      memberBlockIndices: indices,
      status: stretchStatus(members),
      timestamp: first.timestamp,
      ...(endTimestamp === undefined ? {} : { endTimestamp }),
    }, firstIndex)
  }

  // The interrupted script's carrier trails the calls its execution produced:
  // the block order is materialization order, so the script lands before its
  // calls, and the carrier waits for the next script, a thought, a closing
  // block, or the end of the window.
  let carrier: { readonly block: FrontendToolEntry; readonly index: number } | null = null
  const flushCarrier = (): void => {
    if (carrier === null) return
    const { block, index } = carrier
    carrier = null
    const stretch = openStretch(block)
    stretch.members.push(block)
    stretch.indices.push(index)
  }

  for (const [i, block] of blocks.entries()) {
    const index = window.startBlockIndex + i
    if (block.kind === "userMessage" && block.pending) {
      pendingBlocks.push(block)
      zeroHeightBlockIndices.push(index)
      continue
    }
    if (block.kind === "thinking") {
      if (!showThinking) { zeroHeightBlockIndices.push(index); continue }
      flushCarrier()
      // A thought before any call is its own row; one inside tool work rides
      // with the stretch, since only what the agent says or is told ends it.
      const stretch = current()
      if (stretch === null) { pushRow(block, index); seedCall = null; continue }
      stretch.members.push(block)
      stretch.indices.push(index)
      continue
    }
    if (isCommandMessage(block)) {
      flushCarrier()
      const stretch = openStretch(block)
      stretch.members.push(block)
      stretch.indices.push(index)
      continue
    }
    if (block.kind === "tool") {
      if (block.name === "code") {
        flushCarrier()
        openStretch(block).scriptIds.push(blockIdentity(block))
        if (block.status === "interrupted") carrier = { block, index }
        else zeroHeightBlockIndices.push(index)
        continue
      }
      if (awaitsCommandText(block, lastCall())) { zeroHeightBlockIndices.push(index); continue }
      const stretch = openStretch(block)
      stretch.members.push(block)
      stretch.indices.push(index)
      continue
    }
    flushCarrier()
    closeStretch(block.timestamp)
    pushRow(block, index)
  }
  flushCarrier()
  closeStretch(undefined)

  return {
    rows,
    sourceBlockIndices,
    boundaryBefore,
    zeroHeightBlockIndices: zeroHeightBlockIndices.sort((a, b) => a - b),
    pendingBlocks,
  }
}
