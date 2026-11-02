/** @jsxImportSource @opentui/solid */

import type { ChildCardStatus } from "../../protocol/client/session-controls.js"
import type { ToolStreamingText } from "@infra/output-blocks"
import type { BoxRenderable } from "@opentui/core"
import { type Accessor, Match, Show, Switch } from "solid-js"
import { allowSelectionStart } from "@tui/utils/selection.js"
import type { DiffColorMode } from "../../orchestration/config/schema.js"
import { QuestionHistoryBlock } from "./question-history-block.js"
import { DegradedBlock } from "./degraded-block.js"
import { DividerBlock, SystemBlock } from "./system-block.js"
import { TextBlock } from "./text-block.js"
import { ThinkingBlock } from "./thinking-block.js"
import { ToolEntry } from "./tool-entry.js"
import { AgentGroupBlock } from "./agent-group-block.js"
import { ToolRunBlock } from "./tool-run-block.js"
import { UserMessageBlock } from "./user-message-block.js"
import type { PresentedTerminalRow } from "./visible-output-blocks.js"
import type { RowProcessControls } from "./stop-affordance.js"
import type { RoleAssignmentView } from "../../protocol/role-protocol-types.js"

interface StreamingToolTextById { readonly [toolUseId: string]: ToolStreamingText }
export interface BlockRendererProps {
  block: PresentedTerminalRow
  streamingToolText?: StreamingToolTextById
  showThinking?: boolean
  diffColors?: Accessor<DiffColorMode>
  historical?: boolean
  /** Fetch omitted bodies through the transcript owner, using durable block identity.
   * Image-bearing messages request their body on mount; diff-bearing blocks request it on disclosure. */
  onHydrateBody?: (blockId: string) => void
  /** True once the block can no longer receive streaming appends (anything but
   *  the tail block of a live view). Settled markdown takes the cached lex. */
  settled?: boolean
  processControls?: RowProcessControls
  roleView?: (sessionId: string) => RoleAssignmentView | undefined
  /** What a child session waits on, such as "Waiting on parent", for its card. */
  childStatus?: (sessionId: string) => ChildCardStatus
}

export function BlockRenderer(props: BlockRendererProps) {
  return (
    <Show when={props.block.kind !== "thinking" || props.showThinking}>
      <box flexDirection="column">
        <box height={1} width="100%" ref={(el: BoxRenderable) => { allowSelectionStart(el) }} />
        {/* Discriminated-union dispatch (Open/Closed in docs/elegance.md): new block kinds extend AnyBlock and add a Match here. */}
        <Switch>
          <Match when={props.block.kind === "text" ? props.block : undefined}>
            {(block) => <TextBlock block={block()} settled={props.settled} />}
          </Match>
          <Match when={props.block.kind === "tool" ? props.block : undefined}>
            {(block) => <ToolEntry block={block()} streamingToolText={props.streamingToolText} diffColors={props.diffColors} onHydrateBody={props.onHydrateBody} rowControls={props.processControls} />}
          </Match>
          {/* Two group row kinds, two components: agent groups are durable
            * subagent runs with lifecycle and collapse; tool runs are the
            * TUI-local display fold of consecutive standalone tool calls. */}
          {/* A workflow outlives the turn that launched it, so its card in
            * settled history keeps its controls: the held row admits them. */}
          <Match when={props.block.kind === "agentGroup" ? props.block : undefined}>
            {(block) => (
              <AgentGroupBlock
                block={block()}
                processControls={props.historical === true && block().containerKind !== "workflow" ? undefined : props.processControls}
                roleView={props.roleView}
                childStatus={props.childStatus}
              />
            )}
          </Match>
          <Match when={props.block.kind === "toolRun" ? props.block : undefined}>
            {(block) => <ToolRunBlock block={block()} streamingToolText={props.streamingToolText} onHydrateBody={props.onHydrateBody} processControls={props.processControls} />}
          </Match>
          <Match when={props.block.kind === "system" ? props.block : undefined}>
            {(block) => <SystemBlock block={block()} diffColors={props.diffColors} onHydrateBody={props.onHydrateBody} />}
          </Match>
          <Match when={props.block.kind === "degraded" ? props.block : undefined}>
            {(block) => <DegradedBlock block={block()} />}
          </Match>
          <Match when={props.block.kind === "divider" ? props.block : undefined}>
            {(block) => <DividerBlock block={block()} />}
          </Match>
          <Match when={props.showThinking && props.block.kind === "thinking" ? props.block : undefined}>
            {(block) => <ThinkingBlock block={block()} showContent={true} />}
          </Match>
          <Match when={props.block.kind === "userMessage" ? props.block : undefined}>
            {(block) => <UserMessageBlock block={block()} onHydrateBody={props.onHydrateBody} />}
          </Match>
          <Match when={props.block.kind === "question" ? props.block : undefined}>
            {(block) => <QuestionHistoryBlock block={block()} />}
          </Match>
        </Switch>
      </box>
    </Show>
  )
}
