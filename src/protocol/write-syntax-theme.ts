import { Schema } from "effect"
import nord from "./write-syntax-themes/nord.json" with { type: "json" }
import slate from "./write-syntax-themes/slate.json" with { type: "json" }
import vesper from "./write-syntax-themes/vesper.json" with { type: "json" }

export const WRITE_SYNTAX_ROLES = ["text", "comment", "keyword", "function", "variable", "string", "number", "type", "operator", "punctuation"] as const
export type WriteSyntaxColors = { readonly [Role in (typeof WRITE_SYNTAX_ROLES)[number]]: string }

const WRITE_SYNTAX_THEMES = [
  { id: "nord", label: "Nord", colors: nord },
  { id: "slate", label: "Slate", colors: slate },
  { id: "vesper", label: "Vesper", colors: vesper },
] as const satisfies readonly { readonly id: string; readonly label: string; readonly colors: { readonly dark: WriteSyntaxColors; readonly light: WriteSyntaxColors } }[]

export type WriteSyntaxThemeId = (typeof WRITE_SYNTAX_THEMES)[number]["id"]
export const WRITE_SYNTAX_THEME_IDS = WRITE_SYNTAX_THEMES.map(({ id }) => id)
export const WRITE_SYNTAX_THEME_OPTIONS = WRITE_SYNTAX_THEMES.map(({ id, label }) => ({ value: id, label }))
export const WriteSyntaxThemeIdSchema = Schema.Literals(WRITE_SYNTAX_THEME_IDS)
export const DEFAULT_WRITE_SYNTAX_THEME_ID: WriteSyntaxThemeId = "nord"

/** Returns the self-contained syntax colors for Write tool code in one interface mode. */
export function getWriteSyntaxColors(id: WriteSyntaxThemeId, mode: "dark" | "light"): WriteSyntaxColors {
  // SAFETY: WriteSyntaxThemeId is derived from this closed registry, so every admitted id has a palette.
  return WRITE_SYNTAX_THEMES.find((theme) => theme.id === id)!.colors[mode]
}
