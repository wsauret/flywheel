import { join } from "node:path"

import type { CommandHandover } from "../../../../src/infra/command-handover"
import { asAsyncEventReadSurface, type AsyncEventWriter, type EventStoreReadSurface } from "../../../../src/infra/event-store-types"
import type { OwnedProcess, OwnedProcessExit } from "../../../../src/infra/owned-subprocess"
import type { HandedOverCommand } from "../../../../src/infra/owned-command-control"
import type { LauncherScope } from "../../../../src/infra/process-supervisor"
import type { CommandHandoverAuthority } from "../../../../src/orchestration/agent-runtime/command-handover"
import type { CommandHandoverRow } from "../../../../src/orchestration/session/command-handover"

export type AdoptionAnswer = Awaited<ReturnType<LauncherScope["adoptOwned"]>>

export const HANDOFF = "handoff-1"
export const USER_DATA_ROOT = "/home/a/.flywheel"

/** A command container a host drives: it exits when terminated, and it
 *  answers a handover as the test says its supervisor does. */
export function fakeContainer(events: string[], handover?: "handed_over" | "exited" | "unacknowledged") {
  const exit = Promise.withResolvers<OwnedProcessExit>()
  const end = (code: number | null): void => { exit.resolve({ code, signal: code === null ? "SIGTERM" : null, statusOf: "payload", ownership: "surrendered" }) }
  const owned: OwnedProcess = {
    pid: 4242,
    token: "owned:command",
    stdin: undefined,
    stdout: undefined,
    stderr: undefined,
    exited: exit.promise,
    terminate: async () => { events.push("terminate"); end(null); return await exit.promise },
    ...(handover === undefined ? {} : {
      handOver: async (request: CommandHandover) => {
        events.push(`handOver ${request.channel}`)
        if (handover === "exited") {
          end(3)
          return { kind: "exited" as const, exit: await exit.promise }
        }
        return { kind: handover }
      },
    }),
  }
  return { owned, end }
}

/** One executor's authority over a real store, whose launcher answers an
 *  adoption as `adopt` says and launches through `spawnOwned`, which has
 *  heard `HANDOFF` unless `heard` is false, whose stop for it has begun only
 *  when `stopping` says so, and whose keeper gives a host what `takeKept`
 *  says. A launcher that answers an adoption of a supervisor that is gone and
 *  left no record and launches nothing, and a keeper that holds nothing, are
 *  the defaults. */
export function handoverAuthority(input: {
  readonly reader: EventStoreReadSurface
  readonly writer: AsyncEventWriter
  readonly heard?: boolean
  readonly stopping?: boolean | (() => boolean)
  readonly adopt?: (command: HandedOverCommand) => AdoptionAnswer | Promise<AdoptionAnswer>
  readonly spawnOwned?: LauncherScope["spawnOwned"]
  readonly takeKept?: CommandHandoverAuthority["takeKept"]
}): CommandHandoverAuthority {
  const reader = asAsyncEventReadSurface(input.reader)
  return {
    reader,
    projectionReader: reader,
    writer: input.writer,
    launcher: {
      adoptOwned: async (command) => await input.adopt?.(command) ?? { kind: "ended", record: { kind: "absent" } },
      spawnOwned: input.spawnOwned ?? (async () => { throw new Error("this executor launches nothing") }),
    },
    userDataRoot: USER_DATA_ROOT,
    lane: "dev",
    handoffId: () => (input.heard === false ? undefined : HANDOFF),
    stopping: () => typeof input.stopping === "function" ? input.stopping() : input.stopping === true,
    takeKept: input.takeKept ?? (async () => undefined),
  }
}

/** A version 1 row for a command the previous build ran in `conversationId`
 *  of `sessionId`, with its log and record in `dir`. */
export function handedOverRow(dir: string, owner: { readonly sessionId: string; readonly conversationId: string }, overrides: Partial<CommandHandoverRow> = {}): CommandHandoverRow {
  return {
    version: 1,
    handoffId: HANDOFF,
    ...owner,
    processId: "bash-bg-previous",
    toolUseId: "toolu_previous",
    description: "bun run dev",
    logPath: join(dir, "flywheel-agent-bg-previous.log"),
    recordPath: join(dir, "flywheel-agent-bg-previous.outcome.json"),
    channel: "/home/a/.flywheel/serve-dev/h-0123456789abcdef.sock",
    token: "owned:previous",
    pid: 4343,
    startedAtMs: Date.now() - 60_000,
    ...overrides,
  }
}
