/** @jsxImportSource @opentui/solid */
/**
 * BlockRenderer Component
 *
 * Switch component that renders the correct block type based on `block.kind`.
 * Imports components directly — no barrel file to avoid circular imports.
 */

import { Switch, Match } from "solid-js"
import type { AnyBlock } from "@infra/output-blocks"
import { TextBlock } from "./text-block.js"
import { ToolBlock } from "./tool-block.js"
import { AgentBlock } from "./agent-block.js"
import { SystemBlock } from "./system-block.js"
import { ThinkingBlock } from "./thinking-block.js"
import { UserMessageBlock } from "./user-message-block.js"
import { TodoListBlock } from "./todo-list-block.js"

interface BlockRendererProps {
  block: AnyBlock
  expandedIds?: Set<string>
  onToggleExpand?: (id: string) => void
}

export function BlockRenderer(props: BlockRendererProps) {
  return (
    <Switch>
      <Match when={props.block.kind === "text" ? props.block : undefined}>
        {(block) => <TextBlock block={block()} />}
      </Match>
      <Match when={props.block.kind === "tool" ? props.block : undefined}>
        {(block) => <ToolBlock block={block()} />}
      </Match>
      <Match when={props.block.kind === "agent" ? props.block : undefined}>
        {(block) => (
          <AgentBlock
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
        {(block) => <ThinkingBlock block={block()} />}
      </Match>
      <Match when={props.block.kind === "userMessage" ? props.block : undefined}>
        {(block) => <UserMessageBlock block={block()} />}
      </Match>
      <Match when={props.block.kind === "todoList" ? props.block : undefined}>
        {(block) => <TodoListBlock block={block()} />}
      </Match>
    </Switch>
  )
}
