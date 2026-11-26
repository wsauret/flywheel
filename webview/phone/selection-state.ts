import { pushGuideDismissalKey, type RemoteSelection } from "../../src/protocol/modules/remote/relay-device.js"
import { moveBrowserInputReload } from "../src/client/input/input-reload-storage.js"

/** What the phone keeps under the project it selected, and its move to the
 *  id that project has now. */

/** The scope of the client's input checkpoint: the selected project. */
export function inputScopeOf(selection: RemoteSelection | undefined): string {
  return JSON.stringify(selection ?? { unselected: true })
}

/** Moves the phone's state for a project, the draft and queued messages kept
 *  for a reload and the dismissal of the notifications offer, from the id a
 *  release before 2026-11-25 gave the project to its current id. State kept
 *  under the current id stays. Remove after 2027-05-25, with
 *  `resolveLegacyPlacement`. */
export async function movePhoneSelectionState(from: RemoteSelection, to: RemoteSelection): Promise<void> {
  try {
    const dismissed = localStorage.getItem(pushGuideDismissalKey(from))
    if (dismissed !== null && localStorage.getItem(pushGuideDismissalKey(to)) === null) localStorage.setItem(pushGuideDismissalKey(to), dismissed)
    localStorage.removeItem(pushGuideDismissalKey(from))
  } catch {
    // A browser that refuses storage shows the offer again after a relaunch.
  }
  await moveBrowserInputReload(inputScopeOf(from), inputScopeOf(to))
}
