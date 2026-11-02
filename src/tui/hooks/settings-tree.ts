import type { JSX } from "solid-js"
import type { ModalContext, ModalHandle, ModalReplaceOptions } from "../components/modal-stack.js"

/** The settings root the tree children sit on. Bound late because the
 *  settings hook is constructed after the children it links to. */
interface SettingsRoot {
  open: () => void
  isOpen: () => boolean
}

/** Settings is the root of the settings tree: Theme, Auth, Models, and
 *  Auth Profile always open with the settings modal underneath, whether
 *  entered from a settings row or directly via their own command. A child's
 *  `replace` becomes "ensure the settings root is the bottom entry, then push
 *  this child on top", so the left arrow pops back to settings from any entry
 *  point while escape still clears the whole stack. */
export interface SettingsTree {
  /** The modal context tree children open through. */
  childModal: ModalContext
  bindRoot: (root: SettingsRoot) => void
}

export function createSettingsTree(modal: ModalContext): SettingsTree {
  let root: SettingsRoot | undefined

  function treeReplace(element: JSX.Element | (() => JSX.Element), options?: ModalReplaceOptions): ModalHandle {
    if (!root) throw new Error("settings tree root is not bound")
    if (root.isOpen()) {
      // A sibling child may sit on top of the root; detach it so the tree
      // never grows past root plus one child.
      while (modal.stack.length > 1) modal.pop()
    } else {
      // Opening the root replaces whatever modal was showing, so a direct
      // command like /auth lands on a fresh [settings, child] stack.
      root.open()
    }
    return modal.push(element, options)
  }

  const childModal: ModalContext = {
    get stack() { return modal.stack },
    replace: treeReplace,
    push: (element, options) => modal.push(element, options),
    pop: () => modal.pop(),
    dismiss: () => modal.dismiss(),
    clear: () => modal.clear(),
    input: (evt) => modal.input(evt),
    paste: (text) => modal.paste(text),
  }

  return { childModal, bindRoot: (bound) => { root = bound } }
}
