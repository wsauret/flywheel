/**
 * Hands a host's running commands to the next build, and adopts the ones a
 * previous build handed to it (ARCH-RUNTIME-033).
 *
 * The unit that crosses a planned replacement is the running command: its
 * output is a log file and its exit status belongs to its own supervisor, so
 * neither moves. A host that closes for the replacement, in its executor's
 * stop or at the replacement's pause of it, writes one handover row per
 * running command, tells the command's supervisor to hold the command alone,
 * and drops its registry entry. The host that the next build constructs for
 * the same conversation adopts each row's command into its registry, where
 * Stop, output reads, the tail, and the deadline work as for a command it
 * launched. An `mutates` command's private copy lands on the build that holds
 * the command when it ends, as it would have on the build that launched it.
 *
 * A command whose conversation no host of the next build holds, such as one
 * of an agent of a workflow that a person paused, is adopted by that executor's keeper
 * through the same path, with Stop and its deadline. The keeper marks the row
 * kept and leaves it standing, which is what every status of the session
 * shows, until a host that holds the conversation takes the command over and
 * retires the row, or the command ends and the keeper retires the row with
 * its completion.
 *
 * The row decides who publishes the completion of a command that ended while
 * the row stood: the one consumer that retires the row holds the completion in
 * the same step, and a consumer that loses the row holds no completion. That is
 * the predecessor for a command its supervisor did not take, and the successor
 * for every other. Every publication commits under the command's notification
 * key, so a repeat of one commits once.
 */

import { handoverChannelAddress, removeHandoverRemains, type OutcomeRecordRead } from "../../infra/command-handover.js"
import type { ServeLane } from "../../infra/cli-subprocess.js"
import { errorMessage } from "../../infra/error-message.js"
import type { AsyncEventStateReadSurface, AsyncEventWriter } from "../../infra/event-store-types.js"
import { Log } from "../../infra/log.js"
import type { OwnedProcess } from "../../infra/owned-subprocess.js"
import type { LauncherScope } from "../../infra/process-supervisor.js"
import { commandHandoversOfAsync, markCommandKept, retireCommandHandover, writeCommandHandover, type CommandCompletion, type CommandHandoverRow, type StoredCommandHandover } from "../session/command-handover.js"
import { createSessionFactWriter } from "../session/session-fact-writer.js"
import type { BackgroundWorkResult } from "./background-work.js"
import { formatStandaloneNotification } from "./background-work-notifications.js"
import { handedOverPrivateCopy } from "./tools/bash-project-mutation.js"
import { startManagedCommand, type ManagedCommand, type ManagedCommandEnd } from "./tools/managed-command.js"

const log = Log.create({ service: "command-handover" })

/** What one project's executor lends its hosts for a command handover. */
export interface CommandHandoverAuthority {
  readonly reader: AsyncEventStateReadSurface
  readonly projectionReader: AsyncEventStateReadSurface
  readonly writer: AsyncEventWriter
  /** Adopts each handed-over command's container, and runs the Git merges
   *  that land an adopted `mutates` command's private copy. */
  readonly launcher: Pick<LauncherScope, "adoptOwned" | "spawnOwned">
  /** The account whose service directory holds each handed-over command's
   *  channel, and whose build its supervisor holds live. */
  readonly userDataRoot: string
  readonly lane: ServeLane
  /** The planned replacement this executor has heard, if any: the handoff
   *  every row it writes names. Hearing it decides nothing by itself. */
  handoffId(): string | undefined
  /** Whether this executor's stop for the heard handoff has begun. Every host
   *  that closes from then on closes for the replacement and hands its
   *  commands over; a host that closes before it ends them, unless the
   *  replacement's pause marked it. */
  stopping(): boolean
  /** The container of the command of `stored`, which the executor's keeper
   *  gives up to the caller when it holds that command, once an adoption of
   *  it the keeper has under way finishes. The row still stands for the
   *  caller to retire. Nothing when the keeper does not hold the command. */
  takeKept(stored: StoredCommandHandover, receiveOutput: (text: string) => void): Promise<OwnedProcess | undefined>
}

/** One host's share of the authority: the session and conversation whose
 *  commands it hands over and adopts, and who holds what it adopts.
 *  `conversation`: a host of the conversation, whose turn parks on what it
 *  adopts. It takes a command the executor's keeper holds before it asks the
 *  command's supervisor, and it retires each row it adopts.
 *  `keeper`: the executor's keeper, for a conversation no host holds. It
 *  marks each row it adopts kept and leaves the row standing for a host of
 *  the conversation to take over, and it writes no conversation, because a
 *  host may hold the conversation at any time. */
export type CommandHandoverHost = ConversationCommandHost | KeeperCommandHost

/** The session and conversation one host hands commands over for. */
export interface CommandHandoverScope {
  readonly authority: CommandHandoverAuthority
  readonly sessionId: string
  readonly conversationId: string
}

interface ConversationCommandHost extends CommandHandoverScope {
  readonly holder: "conversation"
  /** Delivers the completion of a command this host found ended at its
   *  adoption, already held under its key: a chat publishes it as it
   *  publishes any completion, and a host whose first request has not run
   *  yet commits it into its conversation, so that request reads it once. */
  readonly deliver: (completion: CommandCompletion) => Promise<void>
}

interface KeeperCommandHost extends CommandHandoverScope {
  readonly holder: "keeper"
}

/** Hands each of `commands` to the next build, for a host that closes for a
 *  planned replacement. Per command, in this order: the row, the handover
 *  word, and on its acknowledgement the drop of the registry entry. A command
 *  that ended first, or whose supervisor did not take it, ends here, and its
 *  completion is held for its conversation as its row retires. */
export async function handOverCommands(host: CommandHandoverScope, commands: readonly ManagedCommand[]): Promise<void> {
  const handoffId = host.authority.handoffId()
  if (handoffId === undefined) return
  await Promise.all(commands.map((command) => handOverCommand(host, handoffId, command)))
}

async function handOverCommand(host: CommandHandoverScope, handoffId: string, command: ManagedCommand): Promise<void> {
  const owned = command.owned
  if (owned === undefined) return
  const startedAt = performance.now()
  const { authority, sessionId } = host
  // One record per command, with the evidence of the decision and never the
  // command's text or output.
  const record = (outcome: string, reason?: string): void => {
    const fields = { processId: command.meta.id, sessionId, pid: owned.pid, handoffId, outcome, ms: Math.round(performance.now() - startedAt), ...(reason === undefined ? {} : { reason }) }
    if (reason === undefined) log.info("handed a command to the next build", fields)
    else log.warn("a command could not be handed to the next build; it ends with this runtime", fields)
  }
  try {
    const privateCopyHome = command.copyHomeForHandover()
    const handover = {
      channel: handoverChannelAddress({ userDataRoot: authority.userDataRoot, lane: authority.lane, token: owned.token }),
      // Beside the command's log, which is where every later reader finds it.
      recordPath: `${command.logPath.replace(/\.log$/, "")}.outcome.json`,
      userDataRoot: authority.userDataRoot,
      ...(command.deadlineAtMs === undefined ? {} : { deadlineAtMs: command.deadlineAtMs }),
    }
    const stored = await writeCommandHandover({
      reader: authority.projectionReader,
      writer: authority.writer,
      row: {
        handoffId,
        sessionId,
        conversationId: host.conversationId,
        processId: command.meta.id,
        ...(command.meta.toolUseId === undefined ? {} : { toolUseId: command.meta.toolUseId }),
        ...(command.meta.parentToolUseId === undefined ? {} : { parentToolUseId: command.meta.parentToolUseId }),
        ...(command.meta.modelRequestId === undefined ? {} : { modelRequestId: command.meta.modelRequestId }),
        description: command.meta.description,
        ...(privateCopyHome === undefined ? {} : { privateCopyHome }),
        logPath: command.logPath,
        recordPath: handover.recordPath,
        channel: handover.channel,
        token: owned.token,
        pid: owned.pid,
        startedAtMs: command.startedAtMs,
        ...(command.deadlineAtMs === undefined ? {} : { deadlineAtMs: command.deadlineAtMs }),
      },
    })
    const answer = await command.handOver(handover)
    if (answer.kind === "handed_over") {
      record(answer.kind)
      return
    }
    // The command stays this host's, so it ends here as any command does at
    // a close. Its completion is held for its conversation as the row
    // retires, so the conversation's next run reads it once.
    if (answer.kind === "unacknowledged") command.stop()
    await retireCommandHandover(authority.writer, stored, completionOf(command, await command.done))
    record(answer.kind, answer.kind === "exited" ? "it ended before its supervisor took it" : "its supervisor did not acknowledge the handover")
  } catch (err) {
    record("failed", errorMessage(err))
  }
}

/** The completion of `command`, under the key its live publication uses. */
function completionOf(command: ManagedCommand, result: BackgroundWorkResult): CommandCompletion {
  return { key: command.meta.notificationKey, text: formatStandaloneNotification({ meta: command.meta, result }) }
}

/** The registry a host adopts into. `start` builds its presence of one
 *  command, not yet tracked, from the container its supervisor gave up or the
 *  one the executor's keeper gave up, and claims it for processor admission.
 *  `holds` names a command it holds already, whose row an earlier
 *  pass of the keeper left standing. `record` records the settled tail, the
 *  project edits, and the outcome of a command this host settled from its
 *  supervisor's record, as a command it tracked records them at its end. */
interface AdoptingRegistry {
  stream(toolUseId: string, text: string): void
  start(row: CommandHandoverRow, owned: OwnedProcess): ManagedCommand
  holds(processId: string): boolean
  record(command: ManagedCommand, result: BackgroundWorkResult, settledAtMs: number): void | Promise<void>
}

/** Adopts every command handed to this host's conversation that it does not
 *  hold yet, and answers how many rows it left. A command whose supervisor
 *  answers joins the registry as a command this host launched; a command
 *  whose supervisor is gone settles at once with what its record says. A
 *  row is left when its supervisor speaks no version of the adopt word this
 *  release sends, runs but cannot be adopted now, or kept a record this
 *  release cannot read: a later attempt, or a later build, adopts or settles
 *  it. `quiet` reports a repeated attempt only at debug, so a row that stays
 *  left is reported once. */
export async function adoptHandedOverCommands(host: CommandHandoverHost, registry: AdoptingRegistry, quiet = false): Promise<number> {
  const left = new Map<string, number>()
  const rows = (await commandHandoversOfAsync(host.authority.projectionReader, host.sessionId, host.conversationId)).filter(({ row }) => !registry.holds(row.processId))
  await Promise.all(rows.map(async (stored) => {
    let reason: string | undefined
    try {
      reason = await adoptCommand(host, stored, registry)
    } catch (err) {
      reason = errorMessage(err)
    }
    if (reason !== undefined) left.set(reason, (left.get(reason) ?? 0) + 1)
  }))
  for (const [reason, count] of left) {
    const fields = { sessionId: host.sessionId, reason, count }
    if (quiet) log.debug("handed-over commands are still left for a later attempt", fields)
    else log.warn("handed-over commands could not be adopted now; their rows are left for a later attempt", fields)
  }
  return [...left.values()].reduce((sum, count) => sum + count, 0)
}

/** Adopts or settles one row, and answers why it left the row, if it did.
 *  One record per row it reaches, with the evidence of what became of the
 *  row; a row it leaves is reported by the pass, once. */
async function adoptCommand(host: CommandHandoverHost, stored: StoredCommandHandover, registry: AdoptingRegistry): Promise<string | undefined> {
  const startedAt = performance.now()
  const { row } = stored
  const fromKeeper = host.holder === "conversation" ? await host.authority.takeKept(stored, (text) => {
    if (row.toolUseId !== undefined) registry.stream(row.toolUseId, text)
  }) : undefined
  const adoption: RowAdoption = fromKeeper ? { kind: "adopted", owned: fromKeeper } : await adoptRow(host, stored, registry)
  if (adoption.kind === "left") return adoption.reason
  let rowState: "retired" | "kept" | "lost" = adoption.kind === "lost" ? "lost" : "retired"
  if (adoption.kind === "adopted") {
    const command = registry.start(row, adoption.owned)
    if (host.holder === "keeper") {
      // Marked before it is tracked, so the status its tracking publishes
      // shows the command with its Stop. It is tracked whatever the mark
      // met, so the command always has its owner.
      try {
        rowState = await markCommandKept(host.authority.projectionReader, host.authority.writer, stored) ? "kept" : "lost"
      } finally {
        await command.track()
      }
    } else {
      await command.track()
      rowState = await retireCommandHandover(host.authority.writer, stored) ? "retired" : "lost"
      // The supervisor records the command's end once more when it exits,
      // for no reader: this host publishes that end itself.
      void command.done.then(() => removeHandoverRemains({ recordPath: row.recordPath }))
    }
  }
  log.info("adopted a handed-over command", {
    processId: row.processId, sessionId: row.sessionId, pid: row.pid, handoffId: row.handoffId, holder: host.holder,
    outcome: adoption.kind, ...(fromKeeper ? { from: "keeper" } : {}), row: rowState, ms: Math.round(performance.now() - startedAt),
  })
  return undefined
}

/** What reaching one row's command from its supervisor found. `adopted`:
 *  the caller holds the container from now on, and the row still stands.
 *  `settled`: the supervisor was gone, and this caller retired the row with
 *  the command's completion. `lost`: another consumer retired it first.
 *  `left`: the row stays, for the reason given. */
type RowAdoption =
  | { readonly kind: "adopted"; readonly owned: OwnedProcess }
  | { readonly kind: "settled" | "lost" }
  | { readonly kind: "left"; readonly reason: string }

/** Takes the command of one row from its supervisor, or settles the row from
 *  the record of a supervisor that is gone. */
async function adoptRow(host: CommandHandoverHost, stored: StoredCommandHandover, registry: AdoptingRegistry): Promise<RowAdoption> {
  const { row } = stored
  const answer = await host.authority.launcher.adoptOwned({
    token: row.token, pid: row.pid, channel: row.channel, recordPath: row.recordPath,
    // What gives the command back to its supervisor, for an adoption this
    // owner cannot complete.
    userDataRoot: host.authority.userDataRoot,
    ...(row.deadlineAtMs === undefined ? {} : { deadlineAtMs: row.deadlineAtMs }),
  })
  if (answer.kind === "adopted") return { kind: "adopted", owned: answer.owned }
  if (answer.kind === "refused") return { kind: "left", reason: "its supervisor speaks no version of the adopt word this release sends" }
  if (answer.record.kind === "unreadable") return { kind: "left", reason: "its supervisor kept a record this release cannot read" }
  return { kind: await settleRow(host, stored, answer.record, registry) ? "settled" : "lost" }
}

/** Settles the row of a command whose supervisor is gone, from the record it
 *  kept: a mutating command's copy lands first, as at any end, and the
 *  settled tail is durable before the completion is held as the row retires.
 *  Only the consumer that retires the row publishes the completion. A host
 *  of the conversation delivers it through `deliver`; the keeper leaves it
 *  held for the conversation's next run. Answers whether this consumer
 *  retired the row. */
async function settleRow(host: CommandHandoverHost, stored: StoredCommandHandover, record: Exclude<OutcomeRecordRead, { kind: "unreadable" }>, registry: AdoptingRegistry): Promise<boolean> {
  const { row } = stored
  const command = startManagedCommand({
    ...handedOverCommandInput(host, row),
    source: { observed: Promise.resolve(recordedEnd(record)) },
    // The command has ended: nothing streams, and no stderr pipe remains.
    executionOutputThrottleMs: 0,
    postExitDrainGraceMs: 0,
  })
  const result = await command.done
  const { durationMs } = await command.settlement
  const completion = completionOf(command, result)
  if (!await settleCommandHandover(host.authority.writer, stored, completion, registry.record(command, result, command.startedAtMs + durationMs))) return false
  if (host.holder === "conversation") await host.deliver(completion)
  return true
}

/** Waits for final-output durability before retiring recovery state and
 * deleting supervisor evidence. A rejected write leaves both intact.
 * Returns false when another consumer retired the row first. */
export async function settleCommandHandover(writer: AsyncEventWriter, stored: StoredCommandHandover, completion: CommandCompletion, output: void | Promise<void>): Promise<boolean> {
  await output
  if (!await retireCommandHandover(writer, stored, completion)) return false
  await removeHandoverRemains(stored.row)
  return true
}

/** What a row says of its command, in the shape a managed command's presence
 *  takes, so an adoption and a settlement read one row alike. A command that
 *  runs in a private project copy lands that copy when it ends here, from the
 *  copy's record, as mutations of its tool call in its session. */
export function handedOverCommandInput(host: CommandHandoverScope, row: CommandHandoverRow) {
  const { authority } = host
  const identity = {
    ...(row.parentToolUseId ? { parentToolUseId: row.parentToolUseId } : {}),
    ...(row.modelRequestId ? { modelRequestId: row.modelRequestId } : {}),
  }
  return {
    processId: row.processId,
    description: row.description,
    logPath: row.logPath,
    startedAtMs: row.startedAtMs,
    ...(row.deadlineAtMs === undefined ? {} : { deadlineAtMs: row.deadlineAtMs }),
    ...(row.privateCopyHome === undefined ? {} : {
      privateCopy: handedOverPrivateCopy({
        home: row.privateCopyHome,
        context: {
          sessionId: row.sessionId,
          ...(row.toolUseId ? { toolUseId: row.toolUseId } : {}),
          ...identity,
          sessionEventWriter: createSessionFactWriter({ sessionId: row.sessionId, writer: authority.writer }),
        },
        spawnOwned: authority.launcher.spawnOwned,
      }),
    }),
    identity: { ...(row.toolUseId ? { toolUseId: row.toolUseId } : {}), ...identity },
  }
}

/** How a command that ended while no owner held it ended, read from the
 *  record its supervisor keeps. */
function recordedEnd(read: Exclude<OutcomeRecordRead, { kind: "unreadable" }>): ManagedCommandEnd {
  if (read.kind === "absent") return { kind: "previous_runtime" }
  const outcome = read.record.outcome
  if (outcome === undefined) return { kind: "unrecorded" }
  return { kind: "exited", code: outcome.code, signal: outcome.signal, recorded: { deadlineExpired: outcome.deadlineExpired, endedAtMs: outcome.endedAtMs } }
}
