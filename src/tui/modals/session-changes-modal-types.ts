import type { Renderable, ScrollBoxRenderable } from "@opentui/core"
import type { Accessor } from "solid-js"
import type { SessionChangesController, SessionChangesSnapshot } from "../../protocol/client/changes/session-changes.js"
import type { SessionChangesRow } from "../../protocol/client/changes/session-changes-copy.js"
import type { SessionChangeFile } from "../../protocol/session/session-changes-protocol-types.js"

/** The changes of one session, as the shell holds them while the modal shows them. */
export interface SessionChangesView {
  readonly controller: SessionChangesController
  readonly snapshot: Accessor<SessionChangesSnapshot>
}

/** The navigation and disclosure that the Changes modal drives: the cursor
 *  over its rows, which rows are expanded, and the element registrations that
 *  let the cursor reveal a section of variable height. */
export interface SessionChangesModalControls {
  readonly rows: Accessor<readonly SessionChangesRow[]>
  readonly cursor: Accessor<number>
  setCursor(index: number): void
  isExpanded(key: string): boolean
  toggleExpanded(key: string): void
  toggleViewed(file: SessionChangeFile): void
  requestUndo(fileId: string): void
  confirmUndo(): void
  cancelUndo(): void
  /** Each returns the function that removes the registration. */
  registerHeader(key: string, renderable: Renderable): () => void
  registerSection(key: string, renderable: Renderable): () => void
  attachScroll(scroll: ScrollBoxRenderable): void
  close(): void
}
