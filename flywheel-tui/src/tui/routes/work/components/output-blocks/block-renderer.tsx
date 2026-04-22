/** @jsxImportSource @opentui/solid */
import { Switch, Match } from "solid-js"
import type { AnyBlock } from "@infra/output-blocks"
import { TextBlock } from "./text-block.js"
import { ToolEntry } from "./tool-entry.js"
import { ToolGroupBlock } from "./tool-group-block.js"
import { SystemBlock } from "./system-block.js"
import { ThinkingBlock } from "./thinking-block.js"
import { UserMessageBlock } from "./user-message-block.js"
import { TodoListBlock } from "./todo-list-block.js"
import { QuestionHistoryBlock } from "./question-history-block.js"

interface BlockRendererProps {
  block: AnyBlock
  expandedIds?: Set<string>
  onToggleExpand?: (id: string) => void
  showThinking?: boolean
}

export function BlockRenderer(props: BlockRendererProps) {
  return (
    <box marginTop={1}>
    <Switch>
      <Match when={props.block.kind === "text" ? props.block : undefined}>
        {(block) => <TextBlock block={block()} />}
      </Match>
      <Match when={props.block.kind === "tool" ? props.block : undefined}>
        {(block) => <ToolEntry block={block()} />}
      </Match>
      <Match when={props.block.kind === "toolGroup" ? props.block : undefined}>
        {(block) => (
          <ToolGroupBlock
            block={block()}
            expanded={props.expandedIds?.has(block().id) ?? false}
            onToggleExpand={props.onToggleExpand}
          />
        )}
      </Match>
      <Match when={props.block.kind === "system" ? props.block : undefined}>
        {(block) => <SystemBlock block={block()} />}
      </Match>
      <Match when={props.block.kind === "thinking" ? props.block : undefined}>
        {(block) => <ThinkingBlock block={block()} showContent={props.showThinking ?? true} />}
      </Match>
      <Match when={props.block.kind === "userMessage" ? props.block : undefined}>
        {(block) => <UserMessageBlock block={block()} />}
      </Match>
      <Match when={props.block.kind === "todoList" ? props.block : undefined}>
        {(block) => <TodoListBlock block={block()} />}
      </Match>
      <Match when={props.block.kind === "question" ? props.block : undefined}>
        {(block) => <QuestionHistoryBlock block={block()} />}
      </Match>
    </Switch>
    </box>
  )
}
