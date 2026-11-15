import type { FrontendOutputBlock, FrontendToolEntry } from "../../../src/protocol/app-service-types.js"
import { blockIdentity } from "../../../src/protocol/block-identity.js"
import type { StretchMember, ToolStretch, TranscriptModel } from "../../../src/protocol/client/transcript-model.js"
import { rowIdentity, toolWorkCounts, type PresentedRows, type TurnFold } from "../../../src/protocol/client/turn-folds.js"
import type { StatusView } from "../../../src/protocol/status-protocol-types.js"
import { blockEnd, foldTranscript, runEnd, toolActivity, toolProcess } from "../../../src/protocol/client/transcript-model.js"
import { agentGroupClockRuns } from "../../../src/protocol/client/agent-group-summary.js"
import { messageDisclosureEntry } from "../../../src/protocol/client/message-sender.js"

declare const presented: unique symbol
export type PresentedWebBlock = FrontendOutputBlock & { readonly [presented]: true }

function presentBlock<Block extends FrontendOutputBlock>(block: Block): Block & { readonly [presented]: true } {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- boundary: presentation admits native blocks to the web renderer.
  return block as Block & { readonly [presented]: true }
}

/** Rows whose displayed elapsed time grows, including managed and child work. */
export function runningTimeIds(
  blocks: readonly FrontendOutputBlock[],
  groups: { readonly [id: string]: { readonly children: readonly FrontendToolEntry[] } },
  process: Pick<StatusView, "activeBackgroundCommands" | "activeForegroundBashToolCallIds"> | undefined,
  liveTail: boolean,
): ReadonlySet<string> {
  const ids = new Set<string>()
  const toolRuns = (tool: FrontendToolEntry) => toolActivity(tool, toolProcess(process, tool.id)).active
  for (const block of blocks) {
    if (block.kind === "tool" && toolRuns(block)) ids.add(blockIdentity(block))
    if (block.kind === "thinking" && block.status === "streaming") ids.add(blockIdentity(block))
    if (block.kind === "agentGroup" && agentGroupClockRuns(block)) ids.add(blockIdentity(block))
    // A child's process lives in its own session's status, which its card reads.
    if (block.kind === "agentGroup") for (const child of (groups[block.id]?.children ?? block.children)) if (toolActivity(child, { held: false, managed: false }).active) ids.add(blockIdentity(child))
  }
  const tail = blocks.at(-1)
  if (liveTail && tail?.kind === "text") ids.add(blockIdentity(tail))
  return ids
}

/** The web client's presentation of the shared transcript model. The model
 *  decides what the transcript contains (`foldTranscript`); this file decides
 *  only how the web groups it: every stretch of tool work between one message
 *  and the next gathers under one counting heading, a visible thought inside it
 *  keeps its place in the group, script rows go unrendered, and queued messages
 *  stay in place at the tail. */

export interface ToolGroup {
  readonly kind: "toolGroup"
  /** The key the group renders under, so it stays mounted as calls join it. */
  readonly id: string
  /** The identity of the block that opened the stretch. */
  readonly opening: string
  /** The scripts whose calls the stretch holds, which render nowhere. */
  readonly scriptIds: readonly string[]
  /** Active while any call is still running; interrupted when the script or
   *  one of its calls was cut short; completed otherwise. */
  readonly status: ToolStretch["status"]
  /** The calls, in order. */
  readonly children: readonly FrontendToolEntry[]
  /** Native blocks in order, including session messages and visible thoughts. */
  readonly members: readonly (StretchMember & PresentedWebBlock)[]
  readonly timestamp: number
  readonly endTimestamp?: number | undefined
}

export type TranscriptViewRow = FrontendOutputBlock | ToolGroup | TurnFold<FrontendOutputBlock | ToolGroup>

/** A row ends at its next wire block, including blocks presentation hides,
 *  unless its own work ended at another time (`blockEnd`). */
export function blockEndTimes(blocks: readonly FrontendOutputBlock[]): ReadonlyMap<string, number | undefined> {
  return new Map(blocks.map((block, index) => [blockIdentity(block), blockEnd(block, blocks[index + 1]?.timestamp)]))
}

/** The identities of the blocks a row renders, in order. */
export function rowBlockIdentities(row: TranscriptViewRow): readonly string[] {
  if (row.kind === "turnFold") return row.open ? [] : row.rows.flatMap(rowBlockIdentities)
  return row.kind === "toolGroup" ? row.members.map(blockIdentity) : [blockIdentity(row)]
}

/** The rendered row that holds a block, named by the key the row renders
 *  under. A command's card renders inside its stretch's group, so a landing
 *  that names the command's block lands on the group. Nothing while no
 *  resident row holds the block. */
export function rowHolding(rows: readonly TranscriptViewRow[], blockId: string): string | undefined {
  const row = rows.find((candidate) => rowBlockIdentities(candidate).includes(blockId))
  return row === undefined ? undefined : rowIdentity(row)
}

/** The absolute index of a rendered row's first block, given the resident
 *  blocks and the absolute index of the first one. A place in the transcript
 *  is kept by this index, because a block's id changes between the live
 *  stream and a durable read while its index does not (ARCH-PROTOCOL-054). */
export function rowIndex(rows: readonly TranscriptViewRow[], blocks: readonly FrontendOutputBlock[], startIndex: number | null, rowId: string): number | undefined {
  const row = rows.find((candidate) => rowIdentity(candidate) === rowId)
  if (startIndex === null || row === undefined) return undefined
  const held = new Set(row.kind === "turnFold" ? row.rows.flatMap(rowBlockIdentities) : rowBlockIdentities(row))
  const position = blocks.findIndex((block) => held.has(blockIdentity(block)))
  return position < 0 ? undefined : startIndex + position
}

/** The rendered row that holds the block at an absolute index, or the nearest
 *  rendered row before it; nothing while the index lies before the resident
 *  window. */
export function rowAtIndex(rows: readonly TranscriptViewRow[], blocks: readonly FrontendOutputBlock[], startIndex: number | null, index: number): string | undefined {
  if (startIndex === null || index < startIndex) return undefined
  const rowOf = new Map(rows.flatMap((row) => rowBlockIdentities(row).map((identity) => [identity, rowIdentity(row)] as const)))
  for (let position = Math.min(index - startIndex, blocks.length - 1); position >= 0; position -= 1) {
    const block = blocks[position]
    const row = block === undefined ? undefined : rowOf.get(blockIdentity(block))
    if (row !== undefined) return row
  }
  return undefined
}

/** A script's carrier row has nothing to say in a transcript: the group hides
 *  it and keeps its calls, and the stretch already reads as interrupted. */
function isScript(member: StretchMember): boolean {
  return member.kind === "tool" && member.name === "code"
}

/** Every key a stretch's group can render under, the opening block's first.
 *  Each names a block of the stretch, scripts included.
 *  @yields {string} Each key in that order, built only as it is read. */
function* stretchKeys(opening: string, scriptIds: readonly string[], members: readonly FrontendOutputBlock[]): Generator<string> {
  yield `toolGroup:${opening}`
  for (const id of scriptIds) yield `toolGroup:${id}`
  for (const member of members) yield `toolGroup:${blockIdentity(member)}`
}

/** Every key a group answers to: the key it renders under, then each key its
 *  stretch could render under in another window. A person's choice saved under
 *  any of them belongs to this group, so it survives a window that keys the
 *  stretch afresh, such as one a reload opens.
 *  @yields {string} Each key in that order, built only as it is read. */
export function* toolGroupKeys(group: ToolGroup): Generator<string> {
  yield group.id
  yield* stretchKeys(group.opening, group.scriptIds, group.members)
}

/** A group is keyed on its stretch's opening block, unless one of its blocks,
 *  scripts included, named a key in `keptKeys`. Each key names a block of its
 *  own group, so keys stay unique when a stretch splits. */
function toolGroupOf(stretch: ToolStretch, keptKeys: ReadonlySet<string>): ToolGroup {
  const members = stretch.members.filter((member) => !isScript(member)).map(presentBlock)
  const children: FrontendToolEntry[] = []
  for (const member of members) {
    if (member.kind === "tool") children.push(member)
    else if (member.kind === "userMessage") children.push(messageDisclosureEntry(member, member.from))
  }
  let id = `toolGroup:${stretch.id}`
  if (keptKeys.size > 0) {
    for (const key of stretchKeys(stretch.id, stretch.scriptIds, stretch.members)) {
      if (!keptKeys.has(key)) continue
      id = key
      break
    }
  }
  return { kind: "toolGroup", id, opening: stretch.id, scriptIds: stretch.scriptIds, status: stretch.status, children, members, timestamp: stretch.timestamp, endTimestamp: runEnd(stretch.members, stretch.endTimestamp) }
}

/** The rows the web transcript mounts: the model's rows with each stretch
 *  presented as one group, then the queued messages in place at the tail.
 *  A group keeps a key from `keptKeys` while it holds the block that key
 *  names. */
export function presentWebTranscript(model: TranscriptModel, keptKeys: ReadonlySet<string> = new Set()): PresentedRows<PresentedWebBlock | ToolGroup> {
  const rows: (PresentedWebBlock | ToolGroup)[] = model.rows.map((row) => row.kind === "toolStretch" ? toolGroupOf(row, keptKeys) : presentBlock(row))
  const boundaryBefore = [...model.boundaryBefore]
  for (const pending of model.pendingBlocks) {
    rows.push(presentBlock(pending))
    boundaryBefore.push(false)
  }
  return { rows, boundaryBefore }
}

/** Folds and presents successive windows of one transcript for a web surface.
 *  A group keeps the key it rendered under while it holds the block that key
 *  names. Calls join a stretch at its end as they run and at its start as an
 *  older page lands, and neither may remount the row the reader sees. The
 *  memory holds only the keys of the last frame. Its owner is the resident
 *  session, not the coordinates of a window read. */
export function createWebTranscript() {
  let keys: ReadonlySet<string> = new Set()
  return (blocks: readonly FrontendOutputBlock[], showThinking: boolean | undefined): PresentedRows<PresentedWebBlock | ToolGroup> => {
    const view = presentWebTranscript(foldTranscript(blocks, showThinking), keys)
    const shownKeys = new Set<string>()
    for (const row of view.rows) if (row.kind === "toolGroup") shownKeys.add(row.id)
    keys = shownKeys
    return view
  }
}

function count(n: number, one: string, many: string): string {
  return n === 1 ? one : `${n} ${many}`
}

/** A shell mutation counts as a tool. Nonzero command exits count as failures;
 * blocked calls do not, since their own rows state why they wait. */
export function toolGroupSummaryParts(children: readonly FrontendToolEntry[]) {
  const { commands, tools, failed, interrupted } = toolWorkCounts(children)
  const parts: string[] = []
  if (commands > 0) parts.push(`ran ${count(commands, "a command", "commands")}`)
  if (tools > 0) parts.push(`used ${count(tools, "a tool", "tools")}`)
  const tally = parts.join(", ")
  return { heading: tally.charAt(0).toUpperCase() + tally.slice(1), commands, tools, failed, interrupted }
}

