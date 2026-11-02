import { SyntaxStyle, type NativeResourceOwner } from "@opentui/core"
import { getMarkdownSyntaxRules } from "./syntax-rules-markdown.js"
import type { TuiTheme, ThemeStyles } from "./theme/resolve.js"

export function generateSyntax(theme: TuiTheme, styles: ThemeStyles, owner: NativeResourceOwner) {
  return SyntaxStyle.fromTheme(getSyntaxRules(theme, styles), owner)
}

function getSyntaxRules(theme: TuiTheme, styles: ThemeStyles) {
  return [
    {
      scope: ["default"],
      style: {
        foreground: theme.text,
      },
    },
    {
      scope: ["prompt"],
      style: {
        foreground: theme.accent,
      },
    },
    {
      scope: ["extmark.file"],
      style: {
        foreground: theme.warning,
        bold: true,
      },
    },
    {
      scope: ["extmark.agent"],
      style: {
        foreground: theme.secondary,
        bold: true,
      },
    },
    {
      scope: ["extmark.paste"],
      style: {
        foreground: theme.primary,
        bold: true,
      },
    },
    {
      scope: ["extmark.image"],
      style: {
        foreground: theme.secondary,
        bold: true,
      },
    },
    {
      scope: ["comment"],
      style: {
        foreground: theme.chatCodeComment,
        ...styles.chatCodeComment,
      },
    },
    {
      scope: ["comment.documentation"],
      style: {
        foreground: theme.chatCodeComment,
        ...styles.chatCodeComment,
      },
    },
    {
      scope: ["string", "symbol"],
      style: {
        foreground: theme.chatCodeString,
      },
    },
    {
      scope: ["number", "boolean"],
      style: {
        foreground: theme.chatCodeNumber,
      },
    },
    {
      scope: ["character.special"],
      style: {
        foreground: theme.chatCodeString,
      },
    },
    {
      scope: ["keyword.return", "keyword.conditional", "keyword.repeat", "keyword.coroutine"],
      style: {
        foreground: theme.chatCodeKeyword,
        ...styles.chatCodeKeyword,
      },
    },
    {
      scope: ["keyword.type"],
      style: {
        foreground: theme.chatCodeType,
        ...styles.chatCodeKeywordType,
      },
    },
    {
      scope: ["keyword.function", "function.method"],
      style: {
        foreground: theme.chatCodeFunction,
      },
    },
    {
      scope: ["keyword"],
      style: {
        foreground: theme.chatCodeKeyword,
        ...styles.chatCodeKeyword,
      },
    },
    {
      scope: ["keyword.import"],
      style: {
        foreground: theme.chatCodeKeyword,
      },
    },
    {
      scope: ["operator", "keyword.operator", "punctuation.delimiter"],
      style: {
        foreground: theme.chatCodeOperator,
      },
    },
    {
      scope: ["keyword.conditional.ternary"],
      style: {
        foreground: theme.chatCodeOperator,
      },
    },
    {
      scope: ["variable", "variable.parameter", "function.method.call", "function.call"],
      style: {
        foreground: theme.chatCodeVariable,
      },
    },
    {
      scope: ["variable.member", "function", "constructor"],
      style: {
        foreground: theme.chatCodeFunction,
      },
    },
    {
      scope: ["type", "module"],
      style: {
        foreground: theme.chatCodeType,
      },
    },
    {
      scope: ["constant"],
      style: {
        foreground: theme.chatCodeNumber,
      },
    },
    {
      scope: ["property"],
      style: {
        foreground: theme.chatCodeVariable,
      },
    },
    {
      scope: ["class"],
      style: {
        foreground: theme.chatCodeType,
      },
    },
    {
      scope: ["parameter"],
      style: {
        foreground: theme.chatCodeVariable,
      },
    },
    {
      scope: ["punctuation", "punctuation.bracket"],
      style: {
        foreground: theme.chatCodePunctuation,
      },
    },
    {
      scope: ["variable.builtin", "type.builtin", "function.builtin", "module.builtin", "constant.builtin"],
      style: {
        foreground: theme.error,
      },
    },
    {
      scope: ["variable.super"],
      style: {
        foreground: theme.error,
      },
    },
    {
      scope: ["string.escape", "string.regexp"],
      style: {
        foreground: theme.chatCodeKeyword,
      },
    },
    {
      scope: ["keyword.directive"],
      style: {
        foreground: theme.chatCodeKeyword,
        ...styles.chatCodeKeyword,
      },
    },
    {
      scope: ["punctuation.special"],
      style: {
        foreground: theme.chatCodeOperator,
      },
    },
    {
      scope: ["keyword.modifier"],
      style: {
        foreground: theme.chatCodeKeyword,
        ...styles.chatCodeKeyword,
      },
    },
    {
      scope: ["keyword.exception"],
      style: {
        foreground: theme.chatCodeKeyword,
        ...styles.chatCodeKeyword,
      },
    },
    ...getMarkdownSyntaxRules(theme, styles),
  ]
}
