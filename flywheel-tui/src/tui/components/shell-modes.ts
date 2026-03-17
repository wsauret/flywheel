/**
 * Shell Modes — Pure logic for ViewMode state machine
 *
 * Extracted from flywheel-shell.tsx so transitions can be unit-tested
 * without the OpenTUI runtime. Covers:
 *   - ViewMode type and transition actions
 *   - Transition function (current mode + action → next mode)
 *   - Escape behavior per mode
 *   - assertNever exhaustiveness guard
 *   - Responsive collapse thresholds for three-column layout
 */

// ---------------------------------------------------------------------------
// ViewMode type
// ---------------------------------------------------------------------------

export type ViewMode = "launcher" | "working" | "completed" | "importing"

// ---------------------------------------------------------------------------
// Transition actions
// ---------------------------------------------------------------------------

/** Actions that cause a ViewMode transition. */
export type ViewAction =
  | "start-workflow"    // user submits a plan/command
  | "workflow-ended"    // workflow completes, fails, or is interrupted
  | "stop-workflow"     // user explicitly stops (double-Esc, /stop)
  | "new-session"       // /new command — back to launcher
  | "start-import"      // begin plan import flow
  | "cancel-import"     // cancel import, return to previous mode
  | "confirm-import"    // import confirmed, start workflow

// ---------------------------------------------------------------------------
// Transition function
// ---------------------------------------------------------------------------

/**
 * Pure state-machine transition: given the current mode and an action,
 * return the next mode.
 *
 * Returns `null` if the action is invalid for the current mode
 * (callers should ignore or log).
 */
export function transitionViewMode(
  current: ViewMode,
  action: ViewAction,
): ViewMode | null {
  switch (current) {
    case "launcher":
      switch (action) {
        case "start-workflow":  return "working"
        case "start-import":    return "importing"
        default:                return null
      }
    case "working":
      switch (action) {
        case "workflow-ended":  return "completed"
        case "stop-workflow":   return "completed"
        default:                return null
      }
    case "completed":
      switch (action) {
        case "start-workflow":  return "working"
        case "new-session":     return "launcher"
        case "start-import":    return "importing"
        default:                return null
      }
    case "importing":
      switch (action) {
        case "cancel-import":   return "launcher"
        case "confirm-import":  return "working"
        default:                return null
      }
    default:
      return assertNever(current)
  }
}

// ---------------------------------------------------------------------------
// Escape behavior per mode
// ---------------------------------------------------------------------------

export type EscapeBehavior =
  | "exit-tui"        // launcher: Esc exits the application
  | "double-esc-stop" // working: first Esc shows hint, second stops
  | "return-launcher"  // completed: go back to launcher
  | "cancel-import"   // importing: cancel the import flow

/**
 * What should happen when Esc is pressed in a given ViewMode.
 */
export function escapeForMode(mode: ViewMode): EscapeBehavior {
  switch (mode) {
    case "launcher":    return "exit-tui"
    case "working":     return "double-esc-stop"
    case "completed":   return "return-launcher"
    case "importing":   return "cancel-import"
    default:            return assertNever(mode)
  }
}

// ---------------------------------------------------------------------------
// Ctrl+C behavior per mode
// ---------------------------------------------------------------------------

export type CtrlCBehavior = "exit-tui" | "stop-workflow" | "return-launcher"

/**
 * What should happen when Ctrl+C is pressed in a given ViewMode.
 */
export function ctrlCForMode(mode: ViewMode): CtrlCBehavior {
  switch (mode) {
    case "launcher":    return "exit-tui"
    case "working":     return "stop-workflow"
    case "completed":   return "return-launcher"
    case "importing":   return "exit-tui"
    default:            return assertNever(mode)
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
 * over ViewMode doesn't cover every variant.
 */
export function assertNever(x: never): never {
  throw new Error(`Unexpected ViewMode value: ${x}`)
}
