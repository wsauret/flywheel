/** @jsxImportSource @opentui/solid */
/**
 * Starter Chooser Component
 *
 * Presents initial workflow options ("New from idea", "Start from existing plan")
 * via the DialogProvider overlay pattern using DialogSelect.
 *
 * "Resume session" is intentionally excluded — the sidebar handles session resumption.
 *
 * Pure logic (options, types, helpers) lives in `./starter-chooser-options.ts`
 * so unit tests can import without pulling in the JSX runtime.
 */

import { DialogSelect } from "@tui/shared/ui/dialog-select"
import type { DialogContextValue } from "@tui/shared/context/dialog"
import { STARTER_OPTIONS, type StarterSelection } from "./starter-chooser-options"

// Re-export for convenience so consumers can import from either file
export { STARTER_OPTIONS, getStarterOptionByValue, type StarterSelection } from "./starter-chooser-options"

// ---------------------------------------------------------------------------
// Dialog launcher
// ---------------------------------------------------------------------------

/**
 * Opens the starter chooser as a dialog overlay.
 *
 * @param dialog - DialogProvider context value (from `useDialog()`)
 * @param onSelect - Callback when user picks an option
 */
export function openStarterChooser(
  dialog: DialogContextValue,
  onSelect: (value: StarterSelection) => void,
) {
  dialog.show(() => (
    <StarterChooser
      onSelect={(value) => {
        dialog.close()
        onSelect(value)
      }}
      onCancel={() => dialog.close()}
    />
  ))
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface StarterChooserProps {
  onSelect: (value: StarterSelection) => void
  onCancel?: () => void
}

function StarterChooser(props: StarterChooserProps) {
  return (
    <DialogSelect<StarterSelection>
      title="What would you like to do?"
      options={STARTER_OPTIONS}
      placeholder="Choose a starting point..."
      onSelect={props.onSelect}
      onCancel={props.onCancel}
    />
  )
}

export default StarterChooser
