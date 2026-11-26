import type { RGBA } from "@opentui/core"

export type TuiTheme = {
  primary: RGBA
  /** Hover-state step of `primary`: blended toward the ground's salient pole so
   *  glyph affordances (chevrons) visibly light up, since bold alone is
   *  invisible on symbols in most terminal fonts. */
  primaryBright: RGBA
  /** Hover-state step of `text`: the ground's full-contrast pole (white on dark,
   *  black on light), used to light up clickable header text under the mouse. */
  textBright: RGBA
  secondary: RGBA
  /** Resolver-derived bar and header color of a message that another
   *  session sent. The person's own messages use `secondary`, so this color
   *  must read as a different hue: `info`, or, where a theme's `info` is
   *  close in hue to its `secondary`, the farther of `accent` and `primary`. */
  sessionMessage: RGBA
  accent: RGBA
  /** Resolver-derived colour of a phase's name on every workflow surface,
   *  from `workflowNameColors` in name-colors.ts: `secondary`, unless its hue reads as a
   *  state of an agent. */
  phaseName: RGBA
  /** Resolver-derived colour of an agent's name on every workflow surface:
   *  `accent`, unless its hue reads as a state or as `phaseName`. */
  agentName: RGBA
  error: RGBA
  warning: RGBA
  success: RGBA
  info: RGBA
  text: RGBA
  textMuted: RGBA
  textSubtle: RGBA
  selectedListItemText: RGBA
  selectionBackground: RGBA
  selectionForeground: RGBA
  background: RGBA
  /** Resolver-derived elevated surface: `background` lifted a few percent
   *  toward `text`, so raised input surfaces (question dock, slash popup)
   *  read as subtly elevated in every theme. `backgroundPanel` varies too
   *  much across theme files to serve this role. */
  backgroundRaised: RGBA
  backgroundPanel: RGBA
  backgroundElement: RGBA
  backgroundMenu: RGBA
  border: RGBA
  borderActive: RGBA
  borderSubtle: RGBA
  diffAdded: RGBA
  diffRemoved: RGBA
  diffContext: RGBA
  diffHunkHeader: RGBA
  diffHighlightAdded: RGBA
  diffHighlightRemoved: RGBA
  diffAddedBg: RGBA
  diffRemovedBg: RGBA
  diffContextBg: RGBA
  diffLineNumber: RGBA
  diffAddedLineNumberBg: RGBA
  diffRemovedLineNumberBg: RGBA
  markdownText: RGBA
  markdownHeading: RGBA
  markdownLink: RGBA
  markdownLinkText: RGBA
  markdownCode: RGBA
  markdownBlockQuote: RGBA
  markdownEmph: RGBA
  markdownStrong: RGBA
  markdownHorizontalRule: RGBA
  markdownListItem: RGBA
  markdownListEnumeration: RGBA
  markdownImage: RGBA
  markdownImageText: RGBA
  markdownCodeBlock: RGBA
  chatCodeComment: RGBA
  chatCodeKeyword: RGBA
  chatCodeFunction: RGBA
  chatCodeVariable: RGBA
  chatCodeString: RGBA
  chatCodeNumber: RGBA
  chatCodeType: RGBA
  chatCodeOperator: RGBA
  chatCodePunctuation: RGBA
  thinkingOpacity: number
}
