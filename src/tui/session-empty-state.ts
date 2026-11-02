import type { SessionRow } from "../protocol/app-service-types.js"
import type { OutputView } from "../protocol/output-protocol-types.js"

/** A replaceable new-chat tab has no user-visible transcript content. */
export function isEmptyNewChat(
  row: Pick<SessionRow, "kind" | "title"> | null | undefined,
  output: Pick<OutputView, "blocks"> | undefined,
): boolean {
  return row?.kind === "chat" && row.title === "New Chat" && (output?.blocks.length ?? 0) === 0
}
