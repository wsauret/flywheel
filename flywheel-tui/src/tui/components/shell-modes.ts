/**
 * Shell Modes — Pure logic for AppState and layout
 *
 * Extracted from flywheel-shell.tsx so behavior can be unit-tested
 * without the OpenTUI runtime. Covers:
 *   - AppState type (activity state, not screen selection)
 *   - Escape behavior per state
 *   - Ctrl+C behavior per state
 *   - assertNever exhaustiveness guard
 *   - Responsive collapse thresholds for three-column layout
 */

// ---------------------------------------------------------------------------
// AppState — describes what the app is *doing*
// ---------------------------------------------------------------------------

/**
 * AppState describes what the app is *doing* rather than which *screen* to show.
 * The layout is always SharedLayout; only content varies based on state.
 */
export type AppState = "idle" | "working" | "completed" | "importing"

// ---------------------------------------------------------------------------
// Escape behavior per state
// ---------------------------------------------------------------------------

export type EscapeStateBehavior =
  | "exit-tui"        // idle: Esc exits the application
  | "double-esc-stop" // working: first Esc shows hint, second stops
  | "return-idle"     // completed: go back to idle
  | "cancel-import"   // importing: cancel the import flow

/**
 * What should happen when Esc is pressed in a given AppState.
 */
export function escapeForState(state: AppState): EscapeStateBehavior {
  switch (state) {
    case "idle":        return "exit-tui"
    case "working":     return "double-esc-stop"
    case "completed":   return "return-idle"
    case "importing":   return "cancel-import"
    default:            return assertNever(state)
  }
}

// ---------------------------------------------------------------------------
// Ctrl+C behavior per state
// ---------------------------------------------------------------------------

export type CtrlCStateBehavior = "exit-tui" | "stop-workflow" | "return-idle"

/**
 * What should happen when Ctrl+C is pressed in a given AppState.
 */
export function ctrlCForState(state: AppState): CtrlCStateBehavior {
  switch (state) {
    case "idle":        return "exit-tui"
    case "working":     return "stop-workflow"
    case "completed":   return "return-idle"
    case "importing":   return "exit-tui"
    default:            return assertNever(state)
  }
}

// ---------------------------------------------------------------------------
// Responsive collapse thresholds
// ---------------------------------------------------------------------------

/** Minimum terminal width to show the right panel (WorkflowPanel). */
export const MIN_WIDTH_PANEL = 120

/** Minimum terminal width to show the left sidebar (SessionSidebar). */
export const MIN_WIDTH_SIDEBAR = 90

/** Default sidebar width in columns. */
export const SIDEBAR_WIDTH = 25

/** Default panel width in columns (wider to fit phase names + durations). */
export const PANEL_WIDTH = 38

export interface LayoutVisibility {
  showSidebar: boolean
  showPanel: boolean
}

/**
 * Determine which columns are visible at a given terminal width.
 */
export function layoutVisibility(terminalWidth: number): LayoutVisibility {
  return {
    showSidebar: terminalWidth >= MIN_WIDTH_SIDEBAR,
    showPanel: terminalWidth >= MIN_WIDTH_PANEL,
  }
}

// ---------------------------------------------------------------------------
// assertNever
// ---------------------------------------------------------------------------

/**
 * Exhaustiveness guard. TypeScript will error at compile time if a switch
 * doesn't cover every variant.
 */
export function assertNever(x: never): never {
  throw new Error(`Unexpected value: ${x}`)
}
