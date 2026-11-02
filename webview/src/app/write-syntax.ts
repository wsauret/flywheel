import { getWriteSyntaxColors, WRITE_SYNTAX_ROLES, type WriteSyntaxThemeId } from "../../../src/protocol/write-syntax-theme.js"
import type { JSX } from "solid-js"

export interface WriteSyntaxPresentation {
  readonly class?: "write-syntax"
  readonly style?: JSX.CSSProperties
}

/** Returns scoped presentation for source emitted by Write, and none for other file tools. */
export function writeSyntaxPresentation(fileChangeKind: string | undefined, theme: WriteSyntaxThemeId): WriteSyntaxPresentation {
  if (fileChangeKind !== "create") return {}
  const dark = getWriteSyntaxColors(theme, "dark")
  const light = getWriteSyntaxColors(theme, "light")
  const style = Object.fromEntries(WRITE_SYNTAX_ROLES.map((role) => [
    `--fw-write-syntax-${role}`, `light-dark(${light[role]}, ${dark[role]})`,
  ]))
  return { class: "write-syntax", style }
}
