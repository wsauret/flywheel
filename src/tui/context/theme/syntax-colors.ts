import type { RGBA } from "@opentui/core"
import type { TuiTheme } from "./tui-theme.js"

/** The colors that a syntax highlighter paints each token role with. */
export interface SyntaxColors {
  readonly text: RGBA
  readonly comment: RGBA
  readonly keyword: RGBA
  readonly function: RGBA
  readonly variable: RGBA
  readonly string: RGBA
  readonly number: RGBA
  readonly type: RGBA
  readonly operator: RGBA
  readonly punctuation: RGBA
}

/** The syntax colors of transcript code, read from the theme's chat code roles. */
export function chatSyntaxColors(theme: TuiTheme): SyntaxColors {
  return {
    text: theme.text,
    comment: theme.chatCodeComment,
    keyword: theme.chatCodeKeyword,
    function: theme.chatCodeFunction,
    variable: theme.chatCodeVariable,
    string: theme.chatCodeString,
    number: theme.chatCodeNumber,
    type: theme.chatCodeType,
    operator: theme.chatCodeOperator,
    punctuation: theme.chatCodePunctuation,
  }
}
