/** @jsxImportSource @opentui/solid */
import { createSignal, createMemo, createEffect, Show, For } from "solid-js"
import { useTheme } from "@tui/shared/context/theme"
import { useTerminalDimensions } from "@opentui/solid"
import { COMMANDS } from "@tui/config/commands"
import type { PromptProps } from "./types"
import type { ScrollBoxRenderable } from "@opentui/core"

export function Prompt(props: PromptProps) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let inputRef: any
  let scrollRef: ScrollBoxRenderable | undefined

  const themeCtx = useTheme()
  const dimensions = useTerminalDimensions()
  const [input, setInput] = createSignal("")
  const [showAutocomplete, setShowAutocomplete] = createSignal(false)
  const [selectedIndex, setSelectedIndex] = createSignal(0)

  // Calculate responsive width (80% of terminal width, max 100, min 50)
  const promptWidth = () => Math.min(100, Math.max(50, Math.floor(dimensions().width * 0.8)))

  // All commands, sorted by relevance to what the user has typed after "/"
  // Always returns every command -- never filters, only re-orders.
  const sortedCommands = createMemo(() => {
    const value = input()
    if (!value.startsWith("/")) return []
    const query = value.slice(1).toLowerCase()
    if (query === "") return [...COMMANDS]

    return [...COMMANDS].sort((a, b) => {
      const aName = a.name.slice(1).toLowerCase()
      const bName = b.name.slice(1).toLowerCase()
      const aPrefix = aName.startsWith(query)
      const bPrefix = bName.startsWith(query)
      const aContains = aName.includes(query)
      const bContains = bName.includes(query)
      // Prefix matches first
      if (aPrefix && !bPrefix) return -1
      if (!aPrefix && bPrefix) return 1
      // Then substring matches
      if (aContains && !bContains) return -1
      if (!aContains && bContains) return 1
      // Then alphabetical
      return aName.localeCompare(bName)
    })
  })

  const DROPDOWN_HEIGHT = COMMANDS.length

  // Auto-scroll selected item into view (same pattern as SelectMenu)
  const scrollToSelected = () => {
    if (!scrollRef) return
    const children = scrollRef.getChildren()
    const target = children[selectedIndex()]
    if (!target) return

    const itemTop = target.y - scrollRef.y
    const itemBottom = itemTop + target.height

    if (itemBottom > scrollRef.height) {
      scrollRef.scrollBy(itemBottom - scrollRef.height)
    } else if (itemTop < 0) {
      scrollRef.scrollBy(itemTop)
    }
  }

  createEffect(() => {
    selectedIndex()
    scrollToSelected()
  })

  const hide = () => {
    setShowAutocomplete(false)
  }

  const selectCurrent = () => {
    const cmds = sortedCommands()
    const selected = cmds[selectedIndex()]
    if (!selected) return
    const newValue = selected.name // e.g. "/work"
    setInput(newValue)
    hide()
    inputRef?.setCursorByOffset?.(newValue.length)
  }

  // Autocomplete only for bare command prefixes (e.g. "/wo"), not
  // once the user has typed arguments (e.g. "/work some-plan.md").
  const isCommandPrefix = (value: string) => {
    const trimmed = value.trim()
    return trimmed.startsWith("/") && !trimmed.includes(" ")
  }

  const handleInput = (value: string) => {
    if (props.disabled) return
    setInput(value)

    if (isCommandPrefix(value)) {
      setShowAutocomplete(true)
      // Reset selection to top (best match) on every keystroke
      setSelectedIndex(0)
    } else {
      hide()
    }
  }

  const handleSubmit = () => {
    if (props.disabled) return
    const value = input()
    if (!value.trim()) return

    setInput("")
    hide()
    props.onSubmit(value.trim())
  }

  const handleKeyDown = (evt: { name?: string }) => {
    if (props.disabled) return

    // Escape handling
    if (evt.name === "escape") {
      if (showAutocomplete()) {
        hide()
        return
      }
      if (input().trim() === "") {
        props.onEscape?.()
      } else {
        setInput("")
      }
      return
    }

    // When autocomplete is open, intercept navigation keys
    if (showAutocomplete() && sortedCommands().length > 0) {
      const count = sortedCommands().length

      if (evt.name === "up") {
        setSelectedIndex((prev) => (prev <= 0 ? count - 1 : prev - 1))
        return
      }
      if (evt.name === "down") {
        setSelectedIndex((prev) => (prev >= count - 1 ? 0 : prev + 1))
        return
      }
      if (evt.name === "tab") {
        selectCurrent()
        return
      }
      if (evt.name === "return") {
        // Fill the command into the prompt, do NOT submit
        selectCurrent()
        return
      }
    }

    // Normal enter -> submit
    if (evt.name === "return") {
      handleSubmit()
    }
  }

  return (
    <box flexDirection="column" gap={0} width={promptWidth()}>
      {/* Autocomplete dropdown - renders above the input box */}
      <Show when={showAutocomplete()}>
        <box
          borderColor={themeCtx.theme.border}
          border={["top", "bottom", "left", "right"]}
          borderStyle="rounded"
          backgroundColor={themeCtx.theme.background}
          marginBottom={0}
        >
          <scrollbox
            ref={(r: ScrollBoxRenderable) => (scrollRef = r)}
            flexDirection="column"
            gap={0}
            paddingLeft={1}
            paddingRight={1}
            height={DROPDOWN_HEIGHT}
            scrollbarOptions={{ visible: false }}
          >
            <For each={sortedCommands()}>
              {(cmd, index) => {
                const isSelected = () => index() === selectedIndex()
                return (
                  <box flexDirection="row" gap={1} backgroundColor={isSelected() ? themeCtx.theme.backgroundElement : "transparent"}>
                    <text fg={isSelected() ? themeCtx.theme.primary : themeCtx.theme.textMuted}>
                      {isSelected() ? ">" : " "}
                    </text>
                    <text fg={isSelected() ? themeCtx.theme.primary : themeCtx.theme.text}>
                      {cmd.name}
                    </text>
                    <text fg={themeCtx.theme.textMuted}>
                      {cmd.description}
                    </text>
                  </box>
                )
              }}
            </For>
          </scrollbox>
        </box>
      </Show>

      {/* Input box */}
      <box
        borderColor={themeCtx.theme.border}
        border={["top", "bottom", "left", "right"]}
        borderStyle="rounded"
        paddingLeft={1}
        paddingRight={1}
        paddingBottom={1}
      >
        <input
          ref={(r) => (inputRef = r)}
          value={input()}
          placeholder={props.disabled ? "Dialog open..." : (props.placeholder || "Enter a plan path, or /help")}
          placeholderColor={themeCtx.theme.textMuted}
          onInput={handleInput}
          onKeyDown={handleKeyDown}
          focused={!props.disabled}
          textColor={themeCtx.theme.text}
          focusedTextColor={themeCtx.theme.text}
          cursorColor={themeCtx.theme.primary}
          backgroundColor="transparent"
          focusedBackgroundColor="transparent"
        />
      </box>

      <Show when={props.hint}>
        <box marginTop={1}>
          <text fg={themeCtx.theme.textMuted}>{props.hint}</text>
        </box>
      </Show>
    </box>
  )
}
