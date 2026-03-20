/** @jsxImportSource @opentui/solid */
import { createSignal, createMemo, createEffect, For, onCleanup } from "solid-js"
import { useTheme } from "@tui/shared/context/theme"
import { useTerminalDimensions } from "@opentui/solid"
import { COMMANDS } from "@tui/config/commands"
import fuzzysort from "fuzzysort"
import type { PromptProps } from "./types"
import type { BoxRenderable, ScrollBoxRenderable } from "@opentui/core"

export function Prompt(props: PromptProps) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let inputRef: any
  let scrollRef: ScrollBoxRenderable | undefined
  let anchorRef: BoxRenderable | undefined

  const themeCtx = useTheme()
  const dimensions = useTerminalDimensions()
  const [input, setInput] = createSignal("")
  const [showAutocomplete, setShowAutocomplete] = createSignal(false)
  const [selectedIndex, setSelectedIndex] = createSignal(0)

  // Track anchor position changes for reactive repositioning
  const [positionTick, setPositionTick] = createSignal(0)

  createEffect(() => {
    if (showAutocomplete()) {
      let lastPos = { x: 0, y: 0, width: 0 }
      const interval = setInterval(() => {
        if (!anchorRef) return
        if (anchorRef.x !== lastPos.x || anchorRef.y !== lastPos.y || anchorRef.width !== lastPos.width) {
          lastPos = { x: anchorRef.x, y: anchorRef.y, width: anchorRef.width }
          setPositionTick((t) => t + 1)
        }
      }, 50)
      onCleanup(() => clearInterval(interval))
    }
  })

  // Compute dropdown position from anchor ref's absolute screen coordinates.
  // These are used directly (not relative to parent) because the dropdown
  // is rendered at the root shell level via the overlay slot.
  const dropdownPosition = createMemo(() => {
    if (!showAutocomplete() || !anchorRef) return { x: 0, y: 0, width: 0 }
    positionTick()
    return {
      x: anchorRef.x,
      y: anchorRef.y,
      width: anchorRef.width,
    }
  })

  // Calculate responsive width (80% of terminal width, max 100, min 50)
  const promptWidth = () => Math.min(100, Math.max(50, Math.floor(dimensions().width * 0.8)))

  // Fuzzy-sort commands based on typed query
  const sortedCommands = createMemo(() => {
    const value = input()
    if (!value.startsWith("/")) return []
    const query = value.slice(1).toLowerCase()
    if (query === "") return [...COMMANDS]

    const results = fuzzysort.go(query, COMMANDS, {
      keys: [(c) => c.name.slice(1), "description"],
      limit: 10,
      scoreFn: (r) => {
        let score = r.score
        if (r[0] && r[0].target.startsWith(query)) score *= 2
        return score
      },
    })

    if (results.length > 0) return results.map((r) => r.obj)
    return [...COMMANDS]
  })

  // Dynamic height: cap at 10, option count, or available space above anchor
  const dropdownHeight = createMemo(() => {
    const count = sortedCommands().length || 1
    if (!showAutocomplete()) return Math.min(10, count)
    positionTick()
    const spaceAbove = anchorRef ? Math.max(1, anchorRef.y) : 10
    return Math.min(10, count, spaceAbove)
  })

  // Scroll-to-selected using scrollTop/viewportHeight
  const scrollToSelected = () => {
    if (!scrollRef) return
    const viewportHeight = Math.min(dropdownHeight(), sortedCommands().length)
    const scrollBottom = scrollRef.scrollTop + viewportHeight
    const idx = selectedIndex()
    if (idx < scrollRef.scrollTop) {
      scrollRef.scrollBy(idx - scrollRef.scrollTop)
    } else if (idx + 1 > scrollBottom) {
      scrollRef.scrollBy(idx + 1 - scrollBottom)
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
    const newValue = selected.name
    setInput(newValue)
    hide()
    inputRef?.setCursorByOffset?.(newValue.length)
  }

  const isCommandPrefix = (value: string) => {
    const trimmed = value.trim()
    return trimmed.startsWith("/") && !trimmed.includes(" ")
  }

  const handleInput = (value: string) => {
    if (props.disabled) return
    setInput(value)

    if (isCommandPrefix(value)) {
      setShowAutocomplete(true)
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
        const cmds = sortedCommands()
        const selected = cmds[selectedIndex()]
        if (selected && input().trim() === selected.name) {
          hide()
          handleSubmit()
          return
        }
        selectCurrent()
        return
      }
    }

    if (evt.name === "return") {
      handleSubmit()
    }
  }

  // Pad command names to align descriptions
  const maxCommandWidth = createMemo(() => {
    const cmds = sortedCommands()
    if (cmds.length === 0) return 0
    return Math.max(...cmds.map((c) => c.name.length))
  })

  // ── Autocomplete dropdown (rendered separately at root level via overlay slot) ──

  const AutocompleteDropdown = () => (
    <box
      visible={showAutocomplete()}
      position="absolute"
      top={dropdownPosition().y - dropdownHeight() - 2}
      left={dropdownPosition().x}
      width={dropdownPosition().width}
      zIndex={9999}
      borderColor={themeCtx.theme.border}
      border={["top", "bottom", "left", "right"]}
      borderStyle="rounded"
      backgroundColor={themeCtx.theme.background}
    >
      <scrollbox
        ref={(r: ScrollBoxRenderable) => (scrollRef = r)}
        backgroundColor={themeCtx.theme.background}
        height={dropdownHeight()}
        scrollbarOptions={{ visible: false }}
      >
        <For each={sortedCommands()}>
          {(cmd, index) => {
            const isSelected = () => index() === selectedIndex()
            return (
              <box
                flexDirection="row"
                gap={1}
                paddingLeft={1}
                paddingRight={1}
                backgroundColor={isSelected() ? themeCtx.theme.backgroundElement : "transparent"}
              >
                <text fg={isSelected() ? themeCtx.theme.primary : themeCtx.theme.textMuted}>
                  {isSelected() ? ">" : " "}
                </text>
                <text fg={isSelected() ? themeCtx.theme.primary : themeCtx.theme.text} flexShrink={0}>
                  {cmd.name.padEnd(maxCommandWidth() + 1)}
                </text>
                <text fg={themeCtx.theme.textMuted} wrapMode="none">
                  {cmd.description}
                </text>
              </box>
            )
          }}
        </For>
      </scrollbox>
    </box>
  )

  return {
    // Input element (rendered in the prompt area)
    Input: () => (
      <box
        ref={(r: BoxRenderable) => (anchorRef = r)}
        flexDirection="column"
        gap={0}
        width={promptWidth()}
      >
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
            placeholder={props.disabled ? (props.placeholder || "Dialog open...") : (props.placeholder || "Enter a plan path, or /help")}
            placeholderColor={themeCtx.theme.textMuted}
            onInput={handleInput}
            onKeyDown={handleKeyDown}
            focused={props.focused !== undefined ? props.focused : !props.disabled}
            textColor={themeCtx.theme.text}
            focusedTextColor={themeCtx.theme.text}
            cursorColor={themeCtx.theme.primary}
            backgroundColor="transparent"
            focusedBackgroundColor="transparent"
          />
        </box>

        <box visible={!!props.hint} marginTop={1}>
          <text fg={themeCtx.theme.textMuted}>{props.hint ?? ""}</text>
        </box>
      </box>
    ),
    // Autocomplete overlay (rendered at root level by shell)
    Overlay: AutocompleteDropdown,
  }
}
