/** @jsxImportSource @opentui/solid */
/**
 * Log Line Component
 *
 * Renders a single output line with support for:
 * - Color markers: [GREEN]...[/GREEN], etc.
 * - Markdown: # heading, ## heading, **bold**, `code`, - bullets
 * - Word-wrap
 * - Theme color mapping
 */

import { For } from "solid-js"
import type { RGBA } from "@opentui/core"
import { useTheme } from "@tui/shared/context/theme"
import type { Theme } from "@tui/shared/context/theme"

export interface LogLineProps {
  line: string
  availableWidth?: number
}

// ============================================================================
// Color marker map: marker name -> theme key
// ============================================================================

const COLOR_MAP: Record<string, keyof Theme> = {
  GREEN: "success",
  RED: "error",
  ORANGE: "warning",
  CYAN: "info",
  BLUE: "blue",
  GRAY: "textMuted",
  MAGENTA: "purple",
}

// ============================================================================
// Color marker parsing
// ============================================================================

interface TextSegment {
  text: string
  color?: keyof Theme
  bold?: boolean
}

/**
 * Parse color markers like [GREEN]text[/GREEN] into segments
 */
function parseColorMarkers(text: string): TextSegment[] {
  const segments: TextSegment[] = []
  const colorNames = Object.keys(COLOR_MAP).join("|")
  const regex = new RegExp(`\\[(${colorNames})\\](.*?)\\[/\\1\\]`, "g")
  let lastIndex = 0
  let match: RegExpExecArray | null

  while ((match = regex.exec(text)) !== null) {
    // Text before the marker
    if (match.index > lastIndex) {
      segments.push({ text: text.slice(lastIndex, match.index) })
    }
    // Colored text
    segments.push({
      text: match[2],
      color: COLOR_MAP[match[1]],
    })
    lastIndex = match.index + match[0].length
  }

  // Remaining text
  if (lastIndex < text.length) {
    segments.push({ text: text.slice(lastIndex) })
  }

  return segments.length > 0 ? segments : [{ text }]
}

// ============================================================================
// Line type detection
// ============================================================================

type LinePrefix = "bullet" | "numbered" | "none"

function detectLinePrefix(line: string): { prefix: LinePrefix; content: string; indent: number } {
  const trimmed = line.trimStart()
  const indent = line.length - trimmed.length

  if (/^[-*]\s/.test(trimmed)) {
    return { prefix: "bullet", content: trimmed.slice(2), indent }
  }
  if (/^\d+\.\s/.test(trimmed)) {
    const match = trimmed.match(/^\d+\.\s/)!
    return { prefix: "numbered", content: trimmed.slice(match[0].length), indent }
  }
  return { prefix: "none", content: trimmed, indent }
}

function detectHeading(line: string): { level: number; content: string } | null {
  const match = line.match(/^(#{1,3})\s+(.+)$/)
  if (!match) return null
  return { level: match[1].length, content: match[2] }
}

// ============================================================================
// Inline markdown: **bold** and `code`
// ============================================================================

function parseInlineMarkdown(text: string, theme: Theme): TextSegment[] {
  const segments: TextSegment[] = []
  // Match **bold** or `code`
  const regex = /(\*\*(.+?)\*\*|`([^`]+)`)/g
  let lastIndex = 0
  let match: RegExpExecArray | null

  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      segments.push({ text: text.slice(lastIndex, match.index) })
    }
    if (match[2]) {
      // **bold**
      segments.push({ text: match[2], bold: true })
    } else if (match[3]) {
      // `code`
      segments.push({ text: match[3], color: "info" })
    }
    lastIndex = match.index + match[0].length
  }

  if (lastIndex < text.length) {
    segments.push({ text: text.slice(lastIndex) })
  }

  return segments.length > 0 ? segments : [{ text }]
}

// ============================================================================
// Component
// ============================================================================

/**
 * @deprecated Use `<markdown>` with `syntaxStyle` from theme context instead.
 * Replaced by native OpenTUI markdown rendering in text-block.tsx.
 */
export function LogLine(props: LogLineProps) {
  const themeCtx = useTheme()

  const render = () => {
    const line = props.line
    if (!line || line.trim() === "") {
      return [{ text: " ", color: undefined as keyof Theme | undefined, bold: false }]
    }

    // Check for heading
    const heading = detectHeading(line)
    if (heading) {
      return [{
        text: `${"#".repeat(heading.level)} ${heading.content}`,
        color: "primary" as keyof Theme,
        bold: true,
      }]
    }

    // Check for bullet/numbered prefix
    const { prefix, content, indent } = detectLinePrefix(line)
    const indentStr = " ".repeat(indent)

    // First pass: parse color markers
    const colorSegments = parseColorMarkers(
      prefix === "bullet"
        ? `${indentStr}  • ${content}`
        : prefix === "numbered"
          ? `${indentStr}${line.trimStart().match(/^\d+\./)![0]} ${content}`
          : line
    )

    // Second pass: parse inline markdown within non-colored segments
    const finalSegments: TextSegment[] = []
    for (const seg of colorSegments) {
      if (seg.color) {
        finalSegments.push(seg)
      } else {
        const inlineSegs = parseInlineMarkdown(seg.text, themeCtx.theme)
        finalSegments.push(...inlineSegs)
      }
    }

    return finalSegments
  }

  return (
    <text>
      <For each={render()}>
        {(segment) => {
          const fg: RGBA | undefined = segment.color
            ? (themeCtx.theme[segment.color] as RGBA)
            : undefined
          const content = (
            <span
              style={{
                fg: fg ?? themeCtx.theme.text,
              }}
            >
              {segment.text}
            </span>
          )
          return segment.bold ? <b>{content}</b> : content
        }}
      </For>
    </text>
  )
}
