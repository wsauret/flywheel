import { batch, type JSX } from "solid-js"
import { createStore } from "solid-js/store"
import type { LaunchModalRoute } from "../../infra/launch-state.js"

type KeyHandler = (evt: { name: string; ctrl?: boolean; meta?: boolean; super?: boolean; shift?: boolean; sequence?: string; raw?: string; preventDefault?: () => void }) => void
type PasteHandler = (text: string) => void
type ModalElement = JSX.Element | (() => JSX.Element)
/** A modal's route, or a reader of it for a modal whose place moves while
 *  it is open, such as a workflow agent's view that moves to a sibling. */
type ModalRoute = LaunchModalRoute | (() => LaunchModalRoute)

function routeOf(route: ModalRoute | undefined): LaunchModalRoute | undefined {
  return typeof route === "function" ? route() : route
}

/** A stack entry is a class instance so Solid's store leaves it unwrapped:
 *  its object identity, not an id registry, is what a handle is bound to. */
class StackEntry {
  constructor(
    readonly element: ModalElement,
    readonly onClose?: () => void,
    readonly onKey?: KeyHandler,
    readonly onPaste?: PasteHandler,
    readonly anchor?: () => { left: number; top: number },
    readonly route?: ModalRoute,
  ) {}
}

export interface ModalReplaceOptions {
  onClose?: () => void
  onKey?: KeyHandler
  onPaste?: PasteHandler
  /** Anchored popovers dismiss on outside clicks; centered modals do not. */
  anchor?: () => { left: number; top: number }
  /** How a successor terminal reopens this modal; a modal without one is not reopened. */
  route?: ModalRoute
}

/** Identity of one modal entry, handed to the modal instance that opened it.
 *  Every asynchronous action captures its own handle instead of reading a
 *  mutable current modal at settlement time. */
export interface ModalHandle {
  /** Remove exactly this entry. Returns true when this call removed it, false
   *  when it was already gone. Idempotent: `onClose` runs at most once. */
  close(): boolean
  /** True while this exact entry is still on the stack. */
  isOpen(): boolean
  /** True while this exact entry is the top stack entry. */
  isTop(): boolean
}

export function createModalStack() {
  const [store, setStore] = createStore<{ stack: StackEntry[] }>({
    stack: [],
  })

  /** Detach first, then notify: a reentrant close from `onClose` finds the
   *  entry already gone, and a stale handle cannot remove a replacement. */
  function detach(entry: StackEntry): boolean {
    if (!store.stack.includes(entry)) return false
    setStore("stack", store.stack.filter((candidate) => candidate !== entry))
    entry.onClose?.()
    return true
  }

  function handleFor(entry: StackEntry): ModalHandle {
    return {
      close: () => detach(entry),
      isOpen: () => store.stack.includes(entry),
      isTop: () => store.stack.at(-1) === entry,
    }
  }

  function detachAll(entries: readonly StackEntry[]): void {
    for (const entry of entries) detach(entry)
  }

  return {
    get stack() { return store.stack },

    replace(element: ModalElement, options?: ModalReplaceOptions): ModalHandle {
      // Automatic dialogs must not observe a vacant slot during a replacement.
      return batch(() => {
        detachAll([...store.stack])
        const entry = new StackEntry(element, options?.onClose, options?.onKey, options?.onPaste, options?.anchor, options?.route)
        setStore("stack", [entry])
        return handleFor(entry)
      })
    },

    /** Push on top without detaching what is below. The settings tree uses
     *  this to layer a child modal over the settings root. */
    push(element: ModalElement, options?: ModalReplaceOptions): ModalHandle {
      const entry = new StackEntry(element, options?.onClose, options?.onKey, options?.onPaste, options?.anchor, options?.route)
      setStore("stack", [...store.stack, entry])
      return handleFor(entry)
    },

    /** Explicitly dismiss only the top entry. Centered backdrops never call it
     * from an outside click; keyboard and visible Close controls do. */
    dismiss(): boolean {
      const current = store.stack.at(-1)
      return current ? detach(current) : false
    },

    pop(): void {
      const current = store.stack.at(-1)
      if (current) detach(current)
    },

    clear(): void {
      detachAll([...store.stack])
    },

    input(evt: Parameters<KeyHandler>[0]): boolean {
      const top = store.stack.at(-1)
      if (!top?.onKey) return false
      top.onKey(evt)
      return true
    },

    paste(text: string): boolean {
      const top = store.stack.at(-1)
      if (!top?.onPaste) return false
      top.onPaste(text)
      return true
    },
  }
}

export type ModalContext = ReturnType<typeof createModalStack>

export interface ViewerHandle extends ModalHandle {
  /** True while this viewer is the top viewer, including under a dialog. */
  isActive(): boolean
  /** True while this viewer is the top viewer and no dialog covers it. */
  isFocused(): boolean
}

export type ViewerContext = Omit<ModalContext, "replace" | "push"> & {
  replace(element: ModalElement, options?: ModalReplaceOptions): ViewerHandle
  push(element: ModalElement, options?: ModalReplaceOptions): ViewerHandle
}

/** Owns dialog and transcript-viewer presentation as separate stacks while
 * exposing the shell-facing routing and lifecycle policy as one controller. */
export function createOverlayLayers() {
  const dialog = createModalStack()
  const viewerStack = createModalStack()

  function handleForViewer(handle: ModalHandle): ViewerHandle {
    return {
      ...handle,
      isActive: handle.isTop,
      isFocused: () => dialog.stack.length === 0 && handle.isTop(),
    }
  }

  const viewer: ViewerContext = {
    get stack() { return viewerStack.stack },
    replace(element, options) {
      dialog.clear()
      return handleForViewer(viewerStack.replace(element, options))
    },
    push(element, options) {
      dialog.clear()
      return handleForViewer(viewerStack.push(element, options))
    },
    dismiss: () => viewerStack.dismiss(),
    pop: () => viewerStack.pop(),
    clear: () => viewerStack.clear(),
    input: (evt) => viewerStack.input(evt),
    paste: (text) => viewerStack.paste(text),
  }

  return {
    dialog,
    viewer,

    input(evt: Parameters<KeyHandler>[0]): boolean {
      if (dialog.stack.length > 0) {
        dialog.input(evt)
        return true
      }
      if (viewer.stack.length > 0) {
        viewer.input(evt)
        return true
      }
      return false
    },

    paste(text: string): boolean {
      if (dialog.stack.length > 0) {
        dialog.paste(text)
        return true
      }
      if (viewer.stack.length > 0) {
        viewer.paste(text)
        return true
      }
      return false
    },

    isOpen(): boolean {
      return dialog.stack.length > 0 || viewer.stack.length > 0
    },

    /** The topmost routed modal, a dialog before the viewer under it. */
    route(): LaunchModalRoute {
      return routeOf(dialog.stack.findLast((entry) => entry.route)?.route) ?? routeOf(viewer.stack.findLast((entry) => entry.route)?.route) ?? { kind: "none" }
    },

    clear(): void {
      dialog.clear()
      viewer.clear()
    },
  }
}

export type OverlayLayers = ReturnType<typeof createOverlayLayers>
