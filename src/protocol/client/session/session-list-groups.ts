import type { ChatTurnTimes, StoppedChat } from "../../session/unread-protocol-types.js"
import type { NeedsYou } from "./needs-you.js"

/** The groups of every session list, in the order a list shows them
 *  (PI-INTERACTION-184). */
export type SessionListGroup = "Needs you" | "Working" | "Recent"

/** The latest turn times that a client holds, or undefined before its first
 *  read answers, when that read failed, or when the runtime does not serve it. */
export type ListedTurns = ChatTurnTimes | undefined

/** What the selector reads of one listed chat: the times that stand in for
 *  a latest turn that the runtime does not know, as ISO timestamps. */
interface ListedChat {
  readonly id: string
  readonly createdAt?: string
  readonly lastUpdated: string
}

/** One listed chat in its place. `lastActiveAt`, in epoch milliseconds, is
 *  what the row's time column shows: the stop of a chat that stopped unread,
 *  else its latest turn. `stopped` is the stop of a chat filed under Needs
 *  you because it stopped unread. */
export interface GroupedChat<Row> {
  readonly row: Row
  readonly group: SessionListGroup
  readonly lastActiveAt: number
  readonly stopped: StoppedChat | undefined
}

/** Files every listed chat under Needs you, Working, or Recent, and orders
 *  each group (ARCH-PROTOCOL-073). Needs you keeps the order of `needsYou`.
 *  Working holds the other chats whose agent works by `working`, the rule
 *  the row's spinner uses, and Recent the rest; both list chats by their
 *  latest turn, newest first (PI-INTERACTION-189). A chat with no time in
 *  `turns` takes the time it was created, else the time of its last change.
 *  Opening, closing, or reading a chat changes none of these inputs except
 *  `lastUpdated`, which orders only a chat that has neither of the others.
 *  Before the times arrive the rows take their own times, and they re-sort
 *  once when the times arrive. */
export function groupSessionList<Row extends ListedChat>(input: {
  readonly rows: readonly Row[]
  readonly needsYou: NeedsYou
  readonly working: (row: Row) => boolean
  readonly turns: ListedTurns
}): GroupedChat<Row>[] {
  const { turns } = input
  const latestTurnAt = (row: Row): number => turns?.[row.id] ?? Date.parse(row.createdAt ?? row.lastUpdated)
  const byId = new Map(input.rows.map((row) => [row.id, row]))
  const needing = input.needsYou.rows.flatMap((need): GroupedChat<Row>[] => {
    const row = byId.get(need.sessionId)
    if (row === undefined) return []
    const stopped = need.kind === "stopped" ? need.stopped : undefined
    return [{ row, group: "Needs you", lastActiveAt: stopped?.stoppedAt ?? latestTurnAt(row), stopped }]
  })
  const filed = new Set(needing.map((entry) => entry.row.id))
  const rest = input.rows
    .filter((row) => !filed.has(row.id))
    .map((row): GroupedChat<Row> => ({ row, group: input.working(row) ? "Working" : "Recent", lastActiveAt: latestTurnAt(row), stopped: undefined }))
    .toSorted((left, right) => right.lastActiveAt - left.lastActiveAt || left.row.id.localeCompare(right.row.id))
  return [...needing, ...rest.filter((entry) => entry.group === "Working"), ...rest.filter((entry) => entry.group === "Recent")]
}
