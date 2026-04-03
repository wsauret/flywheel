/** @jsxImportSource @opentui/solid */
/**
 * BlockRenderer Component
 *
 * Switch component that renders the correct block type based on `block.kind`.
 * Imports components directly — no barrel file to avoid circular imports.
 */

import { Switch, Match } from "solid-js"
import type { AnyBlock } from "@tui/types"
import { TextBlock } from "./text-block"
import { ToolBlock } from "./tool-block"
import { AgentBlock } from "./agent-block"
import { ContextGroupBlock } from "./context-group-block"
import { SystemBlock } from "./system-block"

export interface BlockRendererProps {
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
      <Match when={props.block.kind === "contextGroup" ? props.block : undefined}>
        {(block) => <ContextGroupBlock block={block()} />}
      </Match>
      <Match when={props.block.kind === "system" ? props.block : undefined}>
        {(block) => <SystemBlock block={block()} />}
      </Match>
    </Switch>
  )
}
