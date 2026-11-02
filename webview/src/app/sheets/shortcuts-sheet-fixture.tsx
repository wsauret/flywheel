import { createComponent } from "solid-js"

import { mountClientSheet } from "../budget-render-fixture.js"
import { ShortcutsSheet } from "./shortcuts-sheet.js"

/** Mounts the production keyboard shortcuts sheet that Mod+/ opens. */
export function mountShortcutsSheet() {
  return mountClientSheet(() => createComponent(ShortcutsSheet, {}), {})
}
