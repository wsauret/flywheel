/**
 * One project executor's part in a command handover (ARCH-RUNTIME-033, ARCH-RUNTIME-072).
 *
 * The executor lends its hosts one authority: its store, its launch scope,
 * the account, the handoff its replacement report has heard, and whether its
 * stop for that handoff has begun. Every host, a chat, an agent of a workflow,
 * a follow-up, and a child, closes its background owner through it, so a host
 * that closes for the replacement hands its running commands over instead of
 * ending them, and every host adopts at construction what a previous build
 * handed to its conversation.
 *
 * A chat's host can adopt without running a turn, so the executor attaches
 * it: before the successor resumes anything, for the rows of its handoff,
 * and once each later generation is ready, for every row that remains. Every
 * other row goes to the executor's keeper at the same points, because a
 * an agent of a workflow, a follow-up, and a child exist only while they run: the
 * resume that re-enters one constructs the host that takes its commands
 * from the keeper.
 */

import { serveLaneFor } from "../../infra/cli-subprocess.js"
import { errorMessage } from "../../infra/error-message.js"
import type { AsyncEventStateReadSurface, AsyncEventWriter } from "../../infra/event-store-types.js"
import { Log } from "../../infra/log.js"
import type { CommandHandoverAuthority } from "../agent-runtime/command-handover.js"
import type { ChatRunner } from "../chat/runner-types.js"
import { allCommandHandoversAsync, type StoredCommandHandover } from "../session/command-handover.js"
import type { SessionManager } from "../session/manager.js"
import type { CommandKeeper } from "./command-keeper.js"

const log = Log.create({ service: "executor-command-handover" })

/** The executor's authority over the commands its hosts hand over and
 *  adopt, and the two facts the authority reads. */
export interface ExecutorCommandHandover {
  readonly authority: CommandHandoverAuthority
  /** From now on the heard handoff is what `report` heard: the executor's
   *  replacement report, the one source of what the account's replacement
   *  frames and cut told this executor. The report is composed after the
   *  hosts that read the authority, and until it exists no handoff can have
   *  begun, so a stop during a failed startup reads none. */
  hearThrough(report: { handoffId(): string | undefined }): void
  /** The runtime supervisor's stop for the heard handoff has begun: every
   *  host that closes from now on closes for the replacement. */
  stopBegan(): void
  /** Gives the keeper every command of `rows`. */
  keep(rows: readonly StoredCommandHandover[]): Promise<void>
}

export function composeExecutorCommandHandover(input: {
  readonly reader: AsyncEventStateReadSurface
  readonly projectionReader: AsyncEventStateReadSurface
  readonly writer: AsyncEventWriter
  readonly launcher: CommandHandoverAuthority["launcher"]
  readonly userDataRoot: string
  readonly keeper: CommandKeeper
}): ExecutorCommandHandover {
  let report: { handoffId(): string | undefined } | undefined
  let stopping = false
  const authority: CommandHandoverAuthority = {
    reader: input.reader,
    projectionReader: input.projectionReader,
    writer: input.writer,
    launcher: input.launcher,
    userDataRoot: input.userDataRoot,
    lane: serveLaneFor(process.execPath),
    handoffId: () => report?.handoffId(),
    stopping: () => stopping,
    takeKept: (stored, receiveOutput) => input.keeper.take(stored, receiveOutput),
  }
  return {
    authority,
    hearThrough(next) { report = next },
    stopBegan() { stopping = true },
    keep: (rows) => input.keeper.keep(authority, rows),
  }
}

/** What attaching a chat's host reads and drives: the session supervisor's
 *  activation, which attaches the chat's runner without starting a turn. */
export interface ChatHostAttach {
  readonly manager: Pick<SessionManager, "read">
  readonly supervisor: {
    activateSession(sessionId: string): Promise<boolean>
    ensureChatRunner(sessionId: string): Promise<Pick<ChatRunner, "adoptHandedOver">>
  }
}

/** Attaches, once each and without starting a turn, the host of every chat
 *  that owns one of `rows`, and waits until each has adopted what was handed
 *  to its conversation. A chat that cannot be attached is reported. Answers
 *  the rows no attached chat adopts: those of every other owner and those of
 *  a chat that was not attached, which the keeper holds until a host takes
 *  them. */
export async function attachChatOwners(input: ChatHostAttach, rows: readonly StoredCommandHandover[]): Promise<readonly StoredCommandHandover[]> {
  const chats = new Map<string, StoredCommandHandover[]>()
  const unattached: StoredCommandHandover[] = []
  for (const stored of rows) {
    const session = await input.manager.read(stored.row.sessionId)
    if (session?.kind !== "chat" || session.conversationId !== stored.row.conversationId) unattached.push(stored)
    else chats.set(stored.row.sessionId, [...chats.get(stored.row.sessionId) ?? [], stored])
  }
  await Promise.all([...chats].map(async ([sessionId, chatRows]) => {
    try {
      if (await input.supervisor.activateSession(sessionId)) {
        await (await input.supervisor.ensureChatRunner(sessionId)).adoptHandedOver()
        return
      }
    } catch (err) {
      log.warn("a chat's host could not be attached to adopt its handed-over commands; the keeper holds them", { sessionId, error: errorMessage(err) })
    }
    unattached.push(...chatRows)
  }))
  return unattached
}

/** A later generation's adoption sweep, run once the executor has reported
 *  ready and never on its path to ready. Of every row that remains, a chat's
 *  row is adopted by the chat's attached host and every other row by the
 *  keeper, which also settles the row of a command whose supervisor has
 *  ended. The sweep and a host constructed meanwhile may meet on one row,
 *  and the one that retires it is the one that publishes. Never rejects:
 *  what it cannot finish is left for a later host. */
export async function sweepCommandHandovers(input: ChatHostAttach & Pick<ExecutorCommandHandover, "authority" | "keep">): Promise<void> {
  const startedAt = performance.now()
  try {
    const rows = await allCommandHandoversAsync(input.authority.projectionReader)
    if (rows.length === 0) return
    const unattached = await attachChatOwners(input, rows)
    await input.keep(unattached)
    log.info("swept the handed-over commands that remained", { rows: rows.length, kept: unattached.length, ms: Math.round(performance.now() - startedAt) })
  } catch (err) {
    log.warn("the handed-over command sweep failed; the rows are left for a later host", { error: errorMessage(err) })
  }
}
