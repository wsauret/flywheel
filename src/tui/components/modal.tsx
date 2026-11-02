/** @jsxImportSource @opentui/solid */

import { usePaste, useRenderer, useTerminalDimensions } from "@opentui/solid"
import { createContext, createEffect, For, Show, type ParentProps, untrack, useContext } from "solid-js"
import { createOverlayLayers, type ModalContext, type OverlayLayers } from "./modal-stack.js"
import { useQuestionInput } from "./question-input.js"
import { useCopySelection } from "../hooks/use-copy-selection.js"
import type { Clipboard } from "../utils/clipboard.js"
import { AttachmentImagesProvider } from "../context/attachment-images.js"
import { openImageViewer } from "./image-viewer.js"
import type { UserMessageImage } from "@infra/output-blocks"

const ModalCtx = createContext<ModalContext>()
const OverlayCtx = createContext<OverlayLayers>()

export function useModal(): ModalContext {
  const ctx = useContext(ModalCtx)
  if (!ctx) throw new Error("useModal must be used within ModalProvider")
  return ctx
}

export function useOverlay(): OverlayLayers {
  const ctx = useContext(OverlayCtx)
  if (!ctx) throw new Error("useOverlay must be used within ModalProvider")
  return ctx
}

/** The transparent backdrop owns hit testing without repainting the transcript.
 *  Centered dialogs require explicit dismissal; anchored popovers also close
 *  on an outside click. */
function Backdrop(props: ParentProps<{ clipboard: Clipboard; anchor: (() => { left: number; top: number }) | undefined; onDismiss: () => void }>) {
  const dimensions = useTerminalDimensions()
  const copySelection = useCopySelection(untrack(() => props.clipboard))

  return (
    <box
      onMouseDown={() => { if (props.anchor) props.onDismiss() }}
      onMouseUp={() => {
        copySelection()
      }}
      width={dimensions().width}
      height={dimensions().height}
      alignItems="center"
      justifyContent="center"
      position="absolute"
      zIndex={3000}
      left={0}
      top={0}
    >
      <box
        position={props.anchor ? "absolute" : "relative"}
        left={props.anchor?.().left}
        top={props.anchor?.().top}
        onMouseDown={(event) => event.stopPropagation()}
        onMouseUp={(event) => {
          copySelection()
          event.stopPropagation()
        }}
      >
        {props.children}
      </box>
    </box>
  )
}

export function ModalProvider(props: ParentProps<{ clipboard: Clipboard }>) {
  const overlay = createOverlayLayers()
  const questionInput = useQuestionInput()
  const renderer = useRenderer()
  const openImage = (image: UserMessageImage, label: string) => openImageViewer(overlay.viewer, image, label)

  // Everything under an open modal is background: a highlight made before the
  // modal opened must not stay lit behind the scrim, so opening any modal
  // entry drops the renderer's selection. New highlights cannot start outside
  // the modal because the scrim wins the hit test.
  createEffect(() => {
    if (overlay.isOpen()) renderer.clearSelection()
  })

  // Paste is a separate channel from keystrokes (bracketed paste is one
  // PasteEvent, not per-char keys); route it to the active modal, e.g. the
  // auth modal's API-key field, then to a pending question's freeform field
  // (whose prompt textarea - the only other paste receiver - is unmounted
  // while the question is showing). Untaken paste falls through to the
  // prompt's own onPaste, so only consume when one of the two claims it.
  usePaste((event) => {
    const text = new TextDecoder().decode(event.bytes)
    if (overlay.paste(text) || questionInput.paste(text)) event.preventDefault()
  })

  // Pure overlay provider. The prompt owns its own cursor (createComposerFocus),
  // reacting to whether both layers are empty, so opening or closing an overlay needs
  // no focus bookkeeping here.
  return (
    <OverlayCtx.Provider value={overlay}>
      <ModalCtx.Provider value={overlay.dialog}>
        <AttachmentImagesProvider value={{ visible: () => !overlay.isOpen(), open: openImage }}>
          {props.children}
        </AttachmentImagesProvider>
        <box position="absolute" zIndex={3000}>
          <For each={overlay.viewer.stack}>{(entry) =>
            <AttachmentImagesProvider value={{ visible: () => overlay.viewer.stack.at(-1) === entry && overlay.dialog.stack.length === 0, open: openImage }}>
            <Backdrop clipboard={props.clipboard} anchor={entry.anchor} onDismiss={() => { if (overlay.viewer.stack.at(-1) === entry) overlay.viewer.pop() }}>
              {typeof entry.element === "function" ? entry.element() : entry.element}
            </Backdrop>
            </AttachmentImagesProvider>
          }</For>
          <Show when={overlay.dialog.stack.at(-1)} keyed>{(entry) =>
            <AttachmentImagesProvider value={{ visible: () => true, open: openImage }}>
            <Backdrop clipboard={props.clipboard} anchor={entry.anchor} onDismiss={() => { if (overlay.dialog.stack.at(-1) === entry) overlay.dialog.pop() }}>
              {typeof entry.element === "function" ? entry.element() : entry.element}
            </Backdrop>
            </AttachmentImagesProvider>
          }</Show>
        </box>
      </ModalCtx.Provider>
    </OverlayCtx.Provider>
  )
}
