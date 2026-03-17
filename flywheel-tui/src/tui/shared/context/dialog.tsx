/** @jsxImportSource @opentui/solid */
import { Show, createContext, useContext, type JSX, type ParentProps, createSignal } from "solid-js"
import { useTheme } from "./theme"
import { DialogWrapper } from "@tui/shared/ui/dialog-wrapper"

// Store the content factory function, not the rendered element
// This allows the content to be rendered inside the Show wrapper
// where all contexts are available, and properly cleaned up when dialog closes
type DialogContentFactory = () => JSX.Element

export type DialogContextValue = {
  readonly current: DialogContentFactory | null
  show(content: () => JSX.Element): void
  close(): void
  isOpen(): boolean
}

const DialogContext = createContext<DialogContextValue>()

export function DialogProvider(props: ParentProps) {
  // Use a signal to store the content factory
  // This avoids solid-js/store's deep tracking which can cause the factory to be called prematurely
  const [contentFactory, setContentFactory] = createSignal<DialogContentFactory | null>(null)

  const value: DialogContextValue = {
    get current() {
      return contentFactory()
    },
    show(content) {
      // Store the content factory function, not the rendered result
      // The actual rendering happens inside the Show wrapper below,
      // where all parent contexts (Theme, Toast, etc.) are accessible
      // When close() sets current to null, Show unmounts the content,
      // and SolidJS properly cleans up all reactive subscriptions
      setContentFactory(() => content)
    },
    close() {
      // Setting to null unmounts the dialog content via Show's conditional rendering
      // SolidJS automatically disposes all reactive subscriptions when unmounting
      setContentFactory(null)
    },
    isOpen() {
      return contentFactory() !== null
    },
  }

  return (
    <DialogContext.Provider value={value}>
      {props.children}
      <Show when={contentFactory()}>
        {(factory) => (
          /* Call the content factory to render dialog content
             This happens inside the Show, so when Show unmounts (contentFactory becomes null),
             SolidJS properly cleans up all reactive subscriptions from the content */
          <DialogWrapper>{factory()()}</DialogWrapper>
        )}
      </Show>
    </DialogContext.Provider>
  )
}

export function useDialog() {
  const value = useContext(DialogContext)
  if (!value) {
    throw new Error("Dialog context must be used within a context provider")
  }
  return value
}
