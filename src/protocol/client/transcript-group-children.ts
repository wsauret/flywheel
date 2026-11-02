import type { FrontendToolEntry } from "../app-service-types.js"
import type { OutputGroupChildrenCursor } from "../transcript-protocol-types.js"
import type { RuntimeConnection } from "./connection.js"

/** Reads all children pages while the group remains resident, so a group never shows a first page
 * beside a count that disagrees with it. Returns nothing if its owner leaves.
 * Query failures propagate to the store, which owns the group's loading and failure states. */
export async function readTranscriptGroupChildren(
  connection: Pick<RuntimeConnection, "query">,
  sessionId: string,
  groupBlockId: string,
  maxBytes: number,
  isResident: () => boolean,
): Promise<{ children: FrontendToolEntry[]; total: number } | undefined> {
  const children: FrontendToolEntry[] = []
  let cursor: OutputGroupChildrenCursor | undefined
  let total = 0
  do {
    const batch = await connection.query({
      type: "outputGroupChildren",
      sessionId,
      request: {
        groupBlockIds: [groupBlockId],
        maxBytes,
        ...(cursor === undefined ? {} : { cursor }),
      },
    })
    if (!isResident()) return undefined
    const group = batch.groups.find((entry) => entry.groupBlockId === groupBlockId) ?? batch.groups[0]
    if (!group) break
    children.push(...group.children)
    total = group.totalChildren
    cursor = batch.nextCursor
  } while (cursor !== undefined && children.length < total)
  return { children, total }
}
