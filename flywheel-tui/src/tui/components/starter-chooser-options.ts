/**
 * Starter Chooser — Pure logic & option definitions
 *
 * Exported separately from the JSX component so unit tests can import
 * these without pulling in the OpenTUI/SolidJS JSX runtime.
 */

import type { DialogSelectOption } from "@tui/shared/ui/dialog-select/types"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Discriminated values for each starter option */
export type StarterSelection = "new-idea" | "import-plan"

// ---------------------------------------------------------------------------
// Option definitions
// ---------------------------------------------------------------------------

export const STARTER_OPTIONS: DialogSelectOption<StarterSelection>[] = [
  {
    value: "new-idea",
    title: "New from idea",
    description: "Describe what you want to build and generate a plan",
    category: "Start",
  },
  {
    value: "import-plan",
    title: "Start from existing plan",
    description: "Import a plan markdown file from disk",
    category: "Start",
  },
]

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/** Look up a starter option by its value */
export function getStarterOptionByValue(
  value: StarterSelection,
): DialogSelectOption<StarterSelection> | undefined {
  return STARTER_OPTIONS.find((o) => o.value === value)
}
