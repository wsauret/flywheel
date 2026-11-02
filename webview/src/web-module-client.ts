import type { Accessor, JSX } from "solid-js"
import type { RuntimeConnection } from "../../src/protocol/client/connection.js"
import type { FrontendOutputBlock } from "../../src/protocol/app-service-types.js"
import type { ClientViewState } from "./client/view-state.js"
import type { ClientActions } from "./client/actions.js"
import type { RuntimeSession } from "./client/session.js"
import type { BlockProps } from "./app/blocks.js"
import type { ClientCommand } from "../../src/protocol/client/host-contract.js"
import type { BackgroundWorkTarget } from "../../src/protocol/background-index-protocol-types.js"

/** Module presentation composes around the resident ordinary conversation. */
export interface WebModuleClientHost {
  readonly state: Accessor<ClientViewState>
  readonly connection: RuntimeConnection
  readonly actions: ClientActions
  readonly session: RuntimeSession
  readonly selectSession: (id: string) => void
  readonly report: (severity: "info" | "warning", message: string) => void
}

export interface ConversationInput {
  readonly placeholder: string
  readonly wordsOnly: boolean
  readonly hidden: boolean
}

export interface WebModuleClient {
  readonly provide: (children: () => JSX.Element) => JSX.Element
  readonly header: () => JSX.Element
  readonly surface: () => JSX.Element
  readonly coversConversation: Accessor<boolean>
  readonly input: Accessor<ConversationInput | undefined>
  readonly openUri: (uri: string) => boolean
  readonly openTarget?: (target: BackgroundWorkTarget) => boolean
  readonly move: (direction: 1 | -1) => boolean
  readonly back: () => boolean
  /** Shows `sessionId`'s own conversation where a module place covers it,
   *  such as a full-size workflow card over the chat that launched the run,
   *  before the page selects that session to bring its question into view. */
  readonly reveal?: (sessionId: string) => void
  readonly command?: (command: ClientCommand) => boolean
  readonly initialMessageLabel?: (block: Extract<FrontendOutputBlock, { kind: "userMessage" }>) => string | undefined
  readonly block?: {
    readonly matches: (block: FrontendOutputBlock) => boolean
    readonly render: (props: BlockProps) => JSX.Element
  }
}
