import type { AsyncEventStateReadSurface, AsyncEventWriter, InFlightRecord } from "../../infra/event-store-types.js"
import { Log } from "../../infra/log.js"
import { heldBackgroundNotificationSwap } from "./conversation/queued-background-notifications.js"

const log = Log.create({ service: "command-handover" })

export const COMMAND_HANDOVER_IN_FLIGHT_KIND = "session.command_handover"

/** One running command that a planned replacement handed to the next build
 *  (ARCH-RUNTIME-033, ARCH-RUNTIME-072). The predecessor's stop writes it before it tells the
 *  command's supervisor to hold the command alone, and the successor retires
 *  it by compare-and-swap when a host of its conversation adopts the command,
 *  so of two consumers exactly one adopts or settles it. It is in-flight
 *  state, never history, keyed by the command's process id under the session
 *  that ran it.
 *  - `conversationId` names the conversation whose host adopts the command
 *    and reads its completion.
 *  - `channel`, `token`, and `pid` reach the command's supervisor; the
 *    predecessor computed the channel once and sent it in the handover word.
 *  - `recordPath` is where the supervisor records the command's outcome.
 *  - `privateCopyHome` names the home of the private project copy a mutating
 *    command runs in, which holds the copy's record, from which the build that
 *    holds the command when it ends lands the copy. Absent for every other
 *    command.
 *  - `startedAtMs` and `deadlineAtMs` are the command's own start and hard
 *    deadline as epoch milliseconds, so the successor enforces what remains.
 *  - `kept` marks a row whose command the successor executor's keeper holds,
 *    because no host holds its conversation. The keeper sets it by
 *    compare-and-swap when it adopts the command and leaves the row standing,
 *    so every status of the session, the one read from history included,
 *    shows the command with its Stop. A host of the conversation that takes
 *    the command over, or the keeper at the command's end, retires the row. */
export interface CommandHandoverRow {
  readonly version: 1
  readonly handoffId: string
  readonly sessionId: string
  readonly conversationId: string
  readonly processId: string
  readonly toolUseId?: string
  readonly parentToolUseId?: string
  readonly modelRequestId?: string
  readonly description: string
  readonly privateCopyHome?: string
  readonly logPath: string
  readonly recordPath: string
  readonly channel: string
  readonly token: string
  readonly pid: number
  readonly startedAtMs: number
  readonly deadlineAtMs?: number
  readonly kept?: true
}

/** A readable row and the exact text it is stored as, which its retirement
 *  compares against. */
export interface StoredCommandHandover {
  readonly row: CommandHandoverRow
  readonly raw: string
}

const REQUIRED_TEXT = ["handoffId", "sessionId", "conversationId", "processId", "description", "logPath", "recordPath", "channel", "token"] as const
const OPTIONAL_TEXT = ["toolUseId", "parentToolUseId", "modelRequestId", "privateCopyHome"] as const
const KNOWN_KEYS: ReadonlySet<string> = new Set(["version", ...REQUIRED_TEXT, ...OPTIONAL_TEXT, "pid", "startedAtMs", "deadlineAtMs", "kept"])

/** Records that the command the row names is being handed to the next build,
 *  and answers the row as stored. Written before the handover word, so a
 *  crash between the two leaves a row whose supervisor the successor finds
 *  ended rather than a command nobody knows about. */
export async function writeCommandHandover(input: {
  readonly reader: Pick<AsyncEventStateReadSurface, "readInFlight">
  readonly writer: AsyncEventWriter
  readonly row: Omit<CommandHandoverRow, "version">
}): Promise<StoredCommandHandover> {
  const { reader, writer } = input
  if (!writer.putInFlight) throw new Error("Command handover requires durable in-flight storage")
  const row: CommandHandoverRow = { version: 1, ...input.row }
  await writer.putInFlight(row.sessionId, COMMAND_HANDOVER_IN_FLIGHT_KIND, row.processId, row)
  const stored = (await reader.readInFlight(row.sessionId, COMMAND_HANDOVER_IN_FLIGHT_KIND)).find((candidate) => candidate.key === row.processId)
  if (stored === undefined) throw new Error(`Command handover row ${row.processId} was not stored`)
  return { row, raw: stored.raw }
}

/** The rows this release can read that hand commands to the host of
 *  `conversationId` in `sessionId`. Rows it cannot read are reported once per
 *  read, with their count, and left in place for a build that can. */
export async function commandHandoversOfAsync(reader: AsyncEventStateReadSurface, sessionId: string, conversationId: string): Promise<readonly StoredCommandHandover[]> {
  const { stored, unreadable } = await readHandovers(reader, [sessionId])
  if (unreadable.length > 0) warnUnreadable({ sessionId }, unreadable)
  return stored.filter((candidate) => candidate.row.conversationId === conversationId)
}

/** Every row this release can read, of every session in the store. Rows it
 *  cannot read are reported once per read, with their count and the number of
 *  sessions that hold them, and left in place for a build that can. */
export async function allCommandHandoversAsync(reader: AsyncEventStateReadSurface): Promise<readonly StoredCommandHandover[]> {
  const { stored, unreadable } = await readHandovers(reader, await reader.sessionsWithInFlight(COMMAND_HANDOVER_IN_FLIGHT_KIND))
  if (unreadable.length > 0) warnUnreadable({ sessions: new Set(unreadable.map((entry) => entry.sessionId)).size }, unreadable)
  return stored
}

/** The rows this release can read that hand commands over under
 *  `handoffId`, of every session in the store: what the successor that
 *  consumes the handoff adopts. */
export async function commandHandoversForAsync(reader: AsyncEventStateReadSurface, handoffId: string): Promise<readonly StoredCommandHandover[]> {
  return (await allCommandHandoversAsync(reader)).filter((stored) => stored.row.handoffId === handoffId)
}

/** The commands handed to `sessionId` that the executor's keeper holds, as
 *  every status of the session shows them, with Stop: no host of the session
 *  holds them. A row nothing holds, such as one whose supervisor this release
 *  cannot adopt from, shows nothing, so no Stop is offered that nothing can
 *  answer. A row with no tool call names no card, so it shows none either. A
 *  row this release cannot read is the adoption's to report, so this read
 *  passes it over quietly. */
export async function keptCommandsOf(reader: Pick<AsyncEventStateReadSurface, "readInFlight">, sessionId: string): Promise<readonly KeptCommand[]> {
  return (await readHandovers(reader, [sessionId])).stored.flatMap(({ row }) => row.kept !== true || row.toolUseId === undefined
    ? []
    : [{ id: row.processId, description: row.description, toolUseId: row.toolUseId, startedAtMs: row.startedAtMs }])
}

interface KeptCommand {
  readonly id: string
  readonly description: string
  readonly toolUseId: string
  readonly startedAtMs: number
}

interface UnreadableRow {
  readonly sessionId: string
  readonly version: string
}

async function readHandovers(reader: Pick<AsyncEventStateReadSurface, "readInFlight">, sessionIds: readonly string[]) {
  const stored: StoredCommandHandover[] = []
  const unreadable: UnreadableRow[] = []
  for (const sessionId of sessionIds) {
    for (const record of await reader.readInFlight(sessionId, COMMAND_HANDOVER_IN_FLIGHT_KIND)) {
      const row = decodeCommandHandover(record, sessionId)
      if (row === undefined) unreadable.push({ sessionId, version: String(record.payload.version) })
      else stored.push({ row, raw: record.raw })
    }
  }
  return { stored, unreadable }
}

function warnUnreadable(scope: { readonly sessionId: string } | { readonly sessions: number }, unreadable: readonly UnreadableRow[]): void {
  log.warn("command handover rows have a shape this release cannot read; they are left in place", {
    ...scope,
    count: unreadable.length,
    versions: [...new Set(unreadable.map((entry) => entry.version))].join(","),
  })
}

/** How a handed-over command ended, as its conversation reads it, and the
 *  key its completion is held under. */
export interface CommandCompletion {
  readonly key: string
  readonly text: string
}

/** Retires one row and reports whether this caller retired it. The
 *  retirement is a compare-and-swap on the row as it was read, so of two
 *  consumers of one row exactly one wins.
 *
 *  `completion`, for a command that has ended, is held for the row's
 *  conversation in the same step, so the one consumer that retires the row
 *  is the one publisher of the command's end, and a consumer that loses holds
 *  nothing. A completion already held under the key is that publication, so
 *  the row then retires alone. */
export async function retireCommandHandover(writer: AsyncEventWriter, stored: StoredCommandHandover, completion?: CommandCompletion): Promise<boolean> {
  if (!writer.swapInFlight || !writer.swapInFlightBatch) throw new Error("Command handover requires guarded in-flight retirement")
  const { row } = stored
  const retire = (): Promise<boolean> => writer.swapInFlight?.(row.sessionId, COMMAND_HANDOVER_IN_FLIGHT_KIND, row.processId, stored.raw, null) ?? Promise.resolve(false)
  if (completion === undefined) return await retire()
  const retiredWithHold = await writer.swapInFlightBatch(row.sessionId, [
    { op: "swap", kind: COMMAND_HANDOVER_IN_FLIGHT_KIND, key: row.processId, expectedRaw: stored.raw, payload: null },
    heldBackgroundNotificationSwap(row.conversationId, completion.text, completion.key),
  ])
  // A lost batch is either a row another consumer retired, which the retry
  // finds gone, or a completion held under the key before, which then stands.
  return retiredWithHold || await retire()
}

/** Marks the row of a command the executor's keeper adopted as kept, by
 *  compare-and-swap on the row as it was read, and answers the row as stored
 *  now: nothing when another consumer retired it first. */
export async function markCommandKept(reader: Pick<AsyncEventStateReadSurface, "readInFlight">, writer: AsyncEventWriter, stored: StoredCommandHandover): Promise<StoredCommandHandover | undefined> {
  if (!writer.swapInFlight) throw new Error("Command handover requires guarded in-flight writes")
  const row: CommandHandoverRow = { ...stored.row, kept: true }
  if (!await writer.swapInFlight(row.sessionId, COMMAND_HANDOVER_IN_FLIGHT_KIND, row.processId, stored.raw, row)) return undefined
  const marked = (await reader.readInFlight(row.sessionId, COMMAND_HANDOVER_IN_FLIGHT_KIND)).find((candidate) => candidate.key === row.processId)
  return marked === undefined ? undefined : { row, raw: marked.raw }
}

/** Reads one stored row strictly as version 1: exactly its keys, each of its
 *  type, keyed by its process id under its own session. Anything else is a
 *  row this release cannot read. */
export function decodeCommandHandover(record: InFlightRecord, sessionId: string): CommandHandoverRow | undefined {
  const value = record.payload
  if (value.version !== 1 || !Object.keys(value).every((key) => KNOWN_KEYS.has(key))) return undefined
  const text = (key: string): string | undefined => {
    const field = value[key]
    return typeof field === "string" && field.length > 0 ? field : undefined
  }
  const required = REQUIRED_TEXT.map(text)
  const [handoffId, rowSessionId, conversationId, processId, description, logPath, recordPath, channel, token] = required
  const { pid, startedAtMs, deadlineAtMs, kept } = value
  if (
    handoffId === undefined || conversationId === undefined || processId === undefined || description === undefined
    || logPath === undefined || recordPath === undefined || channel === undefined || token === undefined
    || rowSessionId !== sessionId || processId !== record.key
    || !isCount(pid) || pid === 0 || !isCount(startedAtMs) || (deadlineAtMs !== undefined && !isCount(deadlineAtMs)) || (kept !== undefined && kept !== true)
    || OPTIONAL_TEXT.some((key) => value[key] !== undefined && text(key) === undefined)
  ) return undefined
  const toolUseId = text("toolUseId")
  const parentToolUseId = text("parentToolUseId")
  const modelRequestId = text("modelRequestId")
  const privateCopyHome = text("privateCopyHome")
  return {
    version: 1,
    handoffId,
    sessionId,
    conversationId,
    processId,
    ...(toolUseId === undefined ? {} : { toolUseId }),
    ...(parentToolUseId === undefined ? {} : { parentToolUseId }),
    ...(modelRequestId === undefined ? {} : { modelRequestId }),
    description,
    ...(privateCopyHome === undefined ? {} : { privateCopyHome }),
    logPath,
    recordPath,
    channel,
    token,
    pid,
    startedAtMs,
    ...(deadlineAtMs === undefined ? {} : { deadlineAtMs }),
    ...(kept === true ? { kept } : {}),
  }
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
}
