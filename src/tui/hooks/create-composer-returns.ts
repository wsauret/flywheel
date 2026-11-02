import { createComposerReturns } from "../../protocol/client/composer-returns.js"
import type { AttachedRuntimeClient, SessionRow } from "../../protocol/app-service-types.js"
import type { ChatSubmissions } from "../../protocol/client/chat-submissions.js"
import type { ChatInputLike } from "../../infra/chat-input.js"
import type { ComposerHandle } from "../components/composer-types.js"
import type { DraftCache } from "./create-draft-cache.js"
import { mergeInputIntoDraft } from "./composer-draft-merge.js"
import { onCleanup } from "solid-js"

/** Binds claimed and locally refused child input to the terminal's existing
 * root-chat draft owner, without changing the foreground or overlay. */
export function createTerminalComposerReturns(deps: {
  readonly client: AttachedRuntimeClient
  /** The window's submission owner, read lazily because the shell builds it later. */
  readonly submissions: () => Pick<ChatSubmissions, "ownsSubmission" | "settleReturned">
  readonly composer: () => ComposerHandle
  readonly drafts: DraftCache
  readonly row: (id: string) => SessionRow | undefined
  readonly report: (message: string, variant: "info" | "warning") => void
}) {
  const append = (id: string, input: ChatInputLike): void => {
    const composer = deps.composer()
    if (composer) composer.appendInput(id, input)
    else mergeInputIntoDraft(deps.drafts, id, input)
  }
  const claims = createComposerReturns({
    client: deps.client,
    ownsSubmission: (id) => deps.submissions().ownsSubmission(id),
    settled: (ids) => deps.submissions().settleReturned(ids),
    append: (id, item) => {
      append(id, item.input)
      const title = deps.row(id)?.title ?? "the parent chat"
      deps.report(`${item.sourceName} finished. Its unread message is in ${title}'s transcript and composer.`, "info")
    },
    report: (message) => deps.report(message, "warning"),
  })
  onCleanup(claims.dispose)
  return {
    ...claims,
    returnDraft(sourceSessionId: string, input: ChatInputLike): void {
      let row = deps.row(sourceSessionId)
      while (row && row.kind !== "chat") row = row.parentSessionId ? deps.row(row.parentSessionId) : undefined
      if (row) append(row.id, input)
    },
  }
}
