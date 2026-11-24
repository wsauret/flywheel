/**
 * True when base surfaces must stay on the terminal's default background.
 *
 * macOS Terminal.app native-draws connected box glyphs (stretched to join
 * across rows) only over default-background cells; any explicit background
 * SGR forces the raw font glyph and gaps every border at row boundaries.
 * There the base surfaces render as SGR 49 cells and OSC 11 paints the theme
 * background behind them (see hooks/create-terminal-background.ts).
 *
 * Every other terminal draws box glyphs correctly over explicit backgrounds,
 * and some (Warp) ignore OSC 11 entirely, which would replace the theme
 * background with the terminal's own color. Those terminals keep exact
 * per-cell theme painting. tmux reports TERM_PROGRAM=tmux and swallows
 * OSC 11, so it lands on the explicit path as well.
 */
export function baseSurfacesUseDefaultBackground(env: { readonly [key: string]: string | undefined } = process.env): boolean {
  return env["TERM_PROGRAM"] === "Apple_Terminal"
}
