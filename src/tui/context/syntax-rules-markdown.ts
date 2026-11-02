// Markdown-specific syntax highlighting rules, split from syntax-rules.ts for file size
import type { TuiTheme, ThemeStyles } from "./theme/resolve.js"

export function getMarkdownSyntaxRules(theme: TuiTheme, styles: ThemeStyles) {
  return [
    {
      scope: ["markup.heading"],
      style: {
        foreground: theme.markdownHeading,
        ...styles.heading,
      },
    },
    {
      scope: ["markup.heading.1"],
      style: {
        foreground: theme.markdownHeading,
        ...styles.heading1,
      },
    },
    {
      scope: ["markup.heading.2"],
      style: {
        foreground: theme.markdownHeading,
        ...styles.heading2,
      },
    },
    {
      scope: ["markup.heading.3"],
      style: {
        foreground: theme.markdownHeading,
        ...styles.heading3,
      },
    },
    {
      scope: ["markup.heading.4"],
      style: {
        foreground: theme.markdownHeading,
        ...styles.heading4,
      },
    },
    {
      scope: ["markup.heading.5"],
      style: {
        foreground: theme.markdownHeading,
        ...styles.heading5,
      },
    },
    {
      scope: ["markup.heading.6"],
      style: {
        foreground: theme.markdownHeading,
        ...styles.heading6,
      },
    },
    {
      scope: ["markup.bold", "markup.strong"],
      style: {
        foreground: theme.markdownStrong,
        ...styles.strong,
      },
    },
    {
      scope: ["markup.italic"],
      style: {
        foreground: theme.markdownEmph,
        ...styles.emphasis,
      },
    },
    {
      scope: ["markup.list"],
      style: {
        foreground: theme.markdownListItem,
      },
    },
    {
      scope: ["markup.quote"],
      style: {
        foreground: theme.markdownBlockQuote,
        ...styles.blockquote,
      },
    },
    {
      scope: ["markup.raw", "markup.raw.block"],
      style: {
        foreground: theme.markdownCode,
        ...styles.inlineCode,
      },
    },
    {
      scope: ["markup.link"],
      style: {
        foreground: theme.markdownLink,
        ...styles.link,
      },
    },
    {
      scope: ["markup.link.label"],
      style: {
        foreground: theme.markdownLinkText,
        ...styles.linkLabel,
      },
    },
    {
      scope: ["markup.link.url"],
      style: {
        foreground: theme.markdownLink,
        ...styles.link,
      },
    },
    {
      scope: ["label"],
      style: {
        foreground: theme.markdownLinkText,
      },
    },
    {
      scope: ["spell", "nospell"],
      style: {
        foreground: theme.text,
      },
    },
    {
      scope: ["conceal"],
      style: {
        foreground: theme.textMuted,
      },
    },
    {
      scope: ["string.special", "string.special.url"],
      style: {
        foreground: theme.markdownLink,
        underline: true,
      },
    },
    {
      scope: ["character"],
      style: {
        foreground: theme.chatCodeString,
      },
    },
    {
      scope: ["float"],
      style: {
        foreground: theme.chatCodeNumber,
      },
    },
    {
      scope: ["comment.error"],
      style: {
        foreground: theme.error,
        italic: true,
        bold: true,
      },
    },
    {
      scope: ["comment.warning"],
      style: {
        foreground: theme.warning,
        italic: true,
        bold: true,
      },
    },
    {
      scope: ["comment.todo", "comment.note"],
      style: {
        foreground: theme.info,
        italic: true,
        bold: true,
      },
    },
    {
      scope: ["namespace"],
      style: {
        foreground: theme.chatCodeType,
      },
    },
    {
      scope: ["field"],
      style: {
        foreground: theme.chatCodeVariable,
      },
    },
    {
      scope: ["type.definition"],
      style: {
        foreground: theme.chatCodeType,
        bold: true,
      },
    },
    {
      scope: ["keyword.export"],
      style: {
        foreground: theme.chatCodeKeyword,
      },
    },
    {
      scope: ["attribute", "annotation"],
      style: {
        foreground: theme.warning,
      },
    },
    {
      scope: ["tag"],
      style: {
        foreground: theme.error,
      },
    },
    {
      scope: ["tag.attribute"],
      style: {
        foreground: theme.chatCodeKeyword,
      },
    },
    {
      scope: ["tag.delimiter"],
      style: {
        foreground: theme.chatCodeOperator,
      },
    },
    {
      scope: ["markup.strikethrough"],
      style: {
        foreground: theme.textMuted,
        ...styles.strikethrough,
      },
    },
    {
      scope: ["markup.underline"],
      style: {
        foreground: theme.text,
        underline: true,
      },
    },
    {
      scope: ["markup.list.checked"],
      style: {
        foreground: theme.success,
      },
    },
    {
      scope: ["markup.list.unchecked"],
      style: {
        foreground: theme.textMuted,
      },
    },
    {
      scope: ["diff.plus"],
      style: {
        foreground: theme.diffHighlightAdded,
        background: theme.diffAddedBg,
      },
    },
    {
      scope: ["diff.minus"],
      style: {
        foreground: theme.diffHighlightRemoved,
        background: theme.diffRemovedBg,
      },
    },
    {
      scope: ["diff.delta"],
      style: {
        foreground: theme.textMuted,
      },
    },
    {
      scope: ["error"],
      style: {
        foreground: theme.error,
        bold: true,
      },
    },
    {
      scope: ["warning"],
      style: {
        foreground: theme.warning,
        bold: true,
      },
    },
    {
      scope: ["info"],
      style: {
        foreground: theme.info,
      },
    },
    {
      scope: ["debug"],
      style: {
        foreground: theme.textMuted,
      },
    },
  ]
}
