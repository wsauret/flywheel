/**
 * The executor's host for the handed-over commands of every conversation that
 * no host of its own holds (ARCH-RUNTIME-072).
 *
 * A planned replacement hands every running command to the next build, and
 * the host that holds the command's conversation there adopts it. Only a
 * chat's host can be built without a run: an agent of a workflow, a follow-up, and a
 * child exist only while they run, and one a person paused runs again only
 * when the person resumes it. The keeper adopts every command no host takes
 * at the successor's continuation or at a later generation's sweep, so from
 * its adoption on the command has a guardian, its hard deadline, and Stop.
 *
 * The keeper holds each such conversation in one background execution owner,
 * the owner a host holds its background work in, so a kept command is
 * adopted, retried, stopped, and handed over as a host's command is. Only
 * what the adoption does to the row differs: the keeper marks the row kept
 * and leaves it standing. The row is the one durable fact that the command
 * runs for its session and that no host of the session holds it, and every
 * status of the session, the one read from history included, shows it with
 * the command's Stop. A host that later holds the conversation takes the
 * command from the keeper before its first request and retires the row, so
 * its turn parks on the command as on its own. A command that ends while
 * kept records its settled tail and retires its row with its completion held
 * for its conversation, whose next run reads it once: the keeper writes no
 * conversation, because a host may hold it at any time. A person who deletes
 * the session ends what the keeper holds for it. At the executor's stop, a
 * planned replacement's stop hands every kept command to the next build, and
 * any other stop ends each one, whose end retires its row as any end does.
 */

import { NO_CHANGED_TOOLS } from "../../infra/output/output-block-delta.js"
import type { OutputProjectionEvent } from "../../infra/output/output-projection-events.js"
import { StreamingToolTextStore } from "../../infra/output/streaming-tool-text.js"
import { redactSecrets } from "../../infra/redact-secrets.js"
import { errorMessage } from "../../infra/error-message.js"
import type { AsyncEventStateReadSurface, AsyncEventWriter } from "../../infra/event-store-types.js"
import { Log } from "../../infra/log.js"
import type { OwnedProcess } from "../../infra/owned-subprocess.js"
import { mapRuntimeEventToSessionRuntimeFacts } from "../../infra/runtime-fact-mapper.js"
import type { RuntimeEvent } from "../../infra/runtime-event-types.js"
import { extractToolContentFact } from "../../infra/tool-content-extraction.js"
import { createBackgroundExecutionOwner, type BackgroundExecutionOwner } from "../agent-runtime/background-execution-owner.js"
import { createBackgroundWorkRegistry } from "../agent-runtime/background-work.js"
import { settleCommandHandover, type CommandHandoverAuthority } from "../agent-runtime/command-handover.js"
import { emitBackgroundCommandRecorded, emitToolExecutionOutputRecorded } from "../agent-runtime/emit.js"
import type { ManagedCommand } from "../agent-runtime/tools/managed-command.js"
import { commandHandoversOfAsync, type StoredCommandHandover } from "../session/command-handover.js"
import type { SessionManager } from "../session/manager.js"
import { createSessionFactWriter } from "../session/session-fact-writer.js"

const log = Log.create({ service: "command-keeper" })

export interface CommandKeeper {
  /** Holds the conversation of each of `rows` that it does not hold yet, and
   *  resolves once each has been adopted from once; a row an adoption leaves
   *  is tried again until the keeper closes. Never rejects. */
  keep(authority: CommandHandoverAuthority, rows: readonly StoredCommandHandover[]): Promise<void>
  /** Gives up the container of the command of `stored` to a host that takes
   *  it over, once an adoption of it under way finishes: see
   *  `CommandHandoverAuthority.takeKept`. Nothing once the keeper closes. */
  take(stored: StoredCommandHandover, receiveOutput: (text: string) => void): Promise<OwnedProcess | undefined>
  /** The sessions a kept command runs in, which keep the project open. */
  sessions(): readonly string[]
  /** Stop from a kept command's card; false when no kept command answers. */
  terminate(sessionId: string, toolUseId: string): boolean
  /** Told the session whose kept commands changed. */
  onChange(listener: (sessionId: string) => void): () => void
  /** The live output tails of the commands the keeper holds for `sessionId`,
   *  keyed by tool call. A session no host holds has no runtime entry to carry
   *  them, so its output snapshots read them here. */
  liveOutput(sessionId: string): StreamingToolTextSnapshot
  /** Drains the tools whose tails changed, at publication time, after any
   *  asynchronous history read. */
  drainLiveOutput(sessionId: string): ReadonlySet<string>
  /** Told each change of a session's live output tails, as they arrive. */
  onLiveOutput(listener: (sessionId: string, change: KeptOutputChange) => void): () => void
  close(): Promise<void>
}

/** A kept command's tail grew, or its settled tail became durable and the
 *  live tail gave way to it. */
export type KeptOutputChange =
  | { readonly kind: "grew" }
  | { readonly kind: "settled"; readonly toolUseId: string; readonly event: Extract<OutputProjectionEvent, { type: "tool-execution-output-recorded" }> }

type StreamingToolTextSnapshot = ReturnType<StreamingToolTextStore["snapshot"]>

interface KeptConversation {
  readonly sessionId: string
  readonly conversationId: string
  readonly authority: CommandHandoverAuthority
  readonly owner: BackgroundExecutionOwner
  readonly outputWrites: Map<string, Promise<void>>
}

export function createCommandKeeper(input: {
  readonly reader: AsyncEventStateReadSurface
  readonly writer: AsyncEventWriter
  readonly manager: Pick<SessionManager, "subscribe">
}): CommandKeeper {
  const conversations = new Map<string, KeptConversation>()
  // The retirements and output records of commands that ended, which the
  // keeper's close waits for.
  const writes = new Set<Promise<void>>()
  const listeners = new Set<(sessionId: string) => void>()
  const outputListeners = new Set<(sessionId: string, change: KeptOutputChange) => void>()
  // A running command's tail is in-flight state: shown live, never recorded.
  const liveTails = new Map<string, StreamingToolTextStore>()
  let authority: CommandHandoverAuthority | undefined
  let stopWatchingDeletes: (() => void) | undefined
  let closed = false
  const changed = (sessionId: string): void => { for (const listener of listeners) listener(sessionId) }
  const outputChanged = (sessionId: string, change: KeptOutputChange): void => { for (const listener of outputListeners) listener(sessionId, change) }

  const growLiveTail = (sessionId: string, toolUseId: string, output: string): void => {
    let tails = liveTails.get(sessionId)
    if (!tails) {
      tails = new StreamingToolTextStore(() => {})
      liveTails.set(sessionId, tails)
    }
    tails.replace(toolUseId, redactSecrets(output))
    outputChanged(sessionId, { kind: "grew" })
  }

  /** Drops a command's live tail without telling anyone: its holder shows the
   *  tail from then on, or its settled tail is about to replace it. */
  const dropLiveTail = (sessionId: string, toolUseId: string | undefined): void => {
    const tails = liveTails.get(sessionId)
    if (!tails || toolUseId === undefined) return
    tails.clearSilently(toolUseId)
  }
  const keyOf = (owner: { readonly sessionId: string; readonly conversationId: string }): string => `${owner.sessionId}\0${owner.conversationId}`
  const commandsOf = (owner: BackgroundExecutionOwner): ManagedCommand[] =>
    owner.tasks.processRecords().flatMap((record) => owner.tasks.processCommand(record.id) ?? [])
  const track = (write: Promise<void>, failure: string, sessionId: string): void => {
    const tracked: Promise<void> = write
      .catch((err: unknown) => { log.warn(failure, { sessionId, error: errorMessage(err) }) })
      .finally(() => { writes.delete(tracked) })
    writes.add(tracked)
  }

  /** Records a kept command's settled tail, which is what its card shows once
   *  it is durable. Its live tail gives way only then, so the card never shows
   *  less than it did. */
  const outputRecorder = (sessionId: string): ((event: Extract<RuntimeEvent, { type: "tool.execution_output.recorded" }>, toolUseId: string) => Promise<void>) => {
    const facts = createSessionFactWriter({ sessionId, writer: input.writer })
    return (event, toolUseId) => {
      const settled: Extract<OutputProjectionEvent, { type: "tool-execution-output-recorded" }> = {
        type: "tool-execution-output-recorded",
        toolUseId: event.data.tool_use_id,
        output: event.data.output,
        ...(event.data.mutationEvidence ? { mutationEvidence: event.data.mutationEvidence } : {}),
        ...(event.data.parent_tool_use_id ? { parentToolUseId: event.data.parent_tool_use_id } : {}),
      }
      return Promise.all(mapRuntimeEventToSessionRuntimeFacts(event).map((fact) => {
        const extracted = extractToolContentFact(fact)
        return facts.record(extracted.fact, extracted.contentRows)
      })).then(() => {
        dropLiveTail(sessionId, toolUseId)
        outputChanged(sessionId, { kind: "settled", toolUseId, event: settled })
      })
    }
  }

  /** Records a kept command's outcome when it ends, for the background
   *  index of its session. */
  const commandRecorder = (sessionId: string): ((event: Extract<RuntimeEvent, { type: "tool.background_command.recorded" }>) => void) => {
    const facts = createSessionFactWriter({ sessionId, writer: input.writer })
    return (event) => {
      for (const fact of mapRuntimeEventToSessionRuntimeFacts(event)) {
        track(facts.record(fact).then(() => {}), "a kept command's outcome could not be recorded", sessionId)
      }
    }
  }

  /** Retires the row of a kept command that ended with its completion, which
   *  the retirement holds for its conversation, and then removes the record
   *  its supervisor kept, which the completion now carries. */
  const retire = (kept: KeptConversation, text: string, key: string | undefined): void => {
    const command = commandsOf(kept.owner).find((candidate) => candidate.meta.notificationKey === key)
    if (key === undefined || command === undefined) return
    track((async () => {
      const output = command.meta.toolUseId === undefined ? undefined : kept.outputWrites.get(command.meta.toolUseId)
      const stored = (await commandHandoversOfAsync(kept.authority.projectionReader, kept.sessionId, kept.conversationId)).find(({ row }) => row.processId === command.meta.id)
      if (stored === undefined) return
      try {
        await settleCommandHandover(input.writer, stored, { key, text }, output)
      } finally {
        if (command.meta.toolUseId !== undefined) kept.outputWrites.delete(command.meta.toolUseId)
      }
      changed(kept.sessionId)
    })(), "a kept command ended, and its row could not be retired; a later generation settles it", kept.sessionId)
  }

  const hold = (current: CommandHandoverAuthority, sessionId: string, conversationId: string): KeptConversation => {
    const recordOutput = outputRecorder(sessionId)
    const recordCommand = commandRecorder(sessionId)
    const kept: KeptConversation = {
      sessionId,
      conversationId,
      authority: current,
      outputWrites: new Map(),
      owner: createBackgroundExecutionOwner(createBackgroundWorkRegistry({
        kind: "chat",
        enqueueNotification: (text, key) => { retire(kept, text, key) },
        onChange: () => { changed(sessionId) },
        onExecutionOutput: (toolUseId, output) => { growLiveTail(sessionId, toolUseId, output) },
        onExecutionOutputRecorded: (toolUseId, output, identity, edits) => {
          const recorded = emitToolExecutionOutputRecorded((event) => recordOutput(event, toolUseId), toolUseId, output, identity, edits)
          kept.outputWrites.set(toolUseId, recorded)
          return recorded
        },
        onCommandRecorded: (record) => { emitBackgroundCommandRecorded(recordCommand, record) },
      }), { authority: current, sessionId, conversationId, holder: "keeper" }),
    }
    return kept
  }

  /** Ends every command `kept` holds and waits for each end, whose
   *  completion retires its row. */
  const endHeld = async (kept: KeptConversation): Promise<void> => {
    const running = commandsOf(kept.owner).filter((command) => kept.owner.tasks.processRecord(command.meta.id)?.status === "running")
    for (const command of running) command.stop()
    await Promise.all(running.map((command) => command.done))
  }

  // Nothing can resume a deleted session, so what the keeper holds for it ends.
  const endSession = async (sessionId: string): Promise<void> => {
    const ending = [...conversations].filter(([, kept]) => kept.sessionId === sessionId)
    for (const [key] of ending) conversations.delete(key)
    liveTails.delete(sessionId)
    const commands = ending.reduce((sum, [, kept]) => sum + commandsOf(kept.owner).length, 0)
    if (commands > 0) log.info("ending the kept commands of a deleted session", { sessionId, commands })
    await Promise.all(ending.map(([, kept]) => kept.owner.close()))
  }

  return {
    async keep(current, rows) {
      if (closed) return
      authority ??= current
      stopWatchingDeletes ??= input.manager.subscribe((change) => { if (change.kind === "deleted") void endSession(change.sessionId) })
      const fresh: KeptConversation[] = []
      for (const { row } of rows) {
        if (conversations.has(keyOf(row))) continue
        const kept = hold(current, row.sessionId, row.conversationId)
        conversations.set(keyOf(row), kept)
        fresh.push(kept)
      }
      // A pass can settle a row that a keeper that crashed left kept, which
      // its session's status shows until it hears of the change.
      await Promise.all(fresh.map(async ({ owner, sessionId }) => {
        await owner.adoptHandedOver()
        changed(sessionId)
      }))
    },
    async take(stored, receiveOutput) {
      if (closed) return undefined
      const taken = await conversations.get(keyOf(stored.row))?.owner.release(stored.row.processId)
      if (taken && stored.row.toolUseId !== undefined) {
        const tails = liveTails.get(stored.row.sessionId)
        const tail = tails?.snapshot()[stored.row.toolUseId]
        if (tail?.content !== undefined) receiveOutput(tail.content)
        tails?.release(stored.row.toolUseId)
      }
      return taken
    },
    sessions: () => [...new Set([...conversations.values()].filter(({ owner }) => owner.shell.hasActiveCommands()).map(({ sessionId }) => sessionId))],
    terminate(sessionId, toolUseId) {
      return [...conversations.values()].some((kept) => kept.sessionId === sessionId && kept.owner.tasks.terminate(toolUseId))
    },
    onChange(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    onLiveOutput(listener) {
      outputListeners.add(listener)
      return () => { outputListeners.delete(listener) }
    },
    liveOutput: (sessionId) => liveTails.get(sessionId)?.snapshot() ?? {},
    drainLiveOutput(sessionId) {
      const tails = liveTails.get(sessionId)
      const drained = tails?.drainChanged() ?? NO_CHANGED_TOOLS
      if (tails && Object.keys(tails.snapshot()).length === 0) liveTails.delete(sessionId)
      return drained
    },
    async close() {
      if (closed) return
      closed = true
      stopWatchingDeletes?.()
      const held = [...conversations.values()]
      // A replacement's stop hands each kept command to the next build as its
      // owner closes. Any other stop ends it first, so its end retires its
      // row with its completion, as any end does.
      if (authority?.stopping() !== true) await Promise.all(held.map(endHeld))
      await Promise.all(held.map(({ owner }) => owner.close()))
      await Promise.allSettled(writes)
      conversations.clear()
      liveTails.clear()
    },
  }
}
