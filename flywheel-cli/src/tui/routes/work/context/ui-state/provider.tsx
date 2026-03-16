/** @jsxImportSource @opentui/solid */
/**
 * UI State Provider
 *
 * Context provider and hook for UI state.
 * Uses a singleton store to prevent dual-instance bugs.
 */

import { type Accessor, createSignal, onCleanup } from "solid-js"
import { createSimpleContext } from "@tui/shared/context/helper"
import type { WorkflowState } from "./types"
import { createStore } from "./store"
// TODO: Replace with flywheel logger when available
const debug = (...args: unknown[]) => {
  if (process.env.DEBUG) console.debug('[tui:ui-provider]', ...args);
};

export const { provider: UIStateProvider, use: useUIState } = createSimpleContext({
  name: "UIState",
  init: (props: { planName: string }) => {
    debug('[UI-PROVIDER] Provider init, getting singleton store')
    // Get or create the singleton store - state is preserved across remounts
    const store = createStore(props.planName)
    const [state, setState]: [Accessor<WorkflowState>, (v: WorkflowState) => void] = createSignal(store.getState())

    const unsubscribe = store.subscribe(() => {
      setState(store.getState())
    })

    onCleanup(() => unsubscribe())

    return {
      state,
      actions: store,
    }
  },
})
