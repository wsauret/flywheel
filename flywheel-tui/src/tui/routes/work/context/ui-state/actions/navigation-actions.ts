/**
 * Navigation Action Creators
 *
 * Factory that takes store context and returns navigation mutation functions.
 */

import type { StoreContext } from "./workflow-actions";

export function createNavigationActions(ctx: StoreContext) {
  const { getState, setState, notify } = ctx;

  return {
    selectNext(): void {
      const state = getState();
      const maxIndex = Math.max(0, state.queueSteps.length - 1);
      const next = Math.min(state.selectedStepIndex + 1, maxIndex);
      setState({
        ...state,
        selectedStepIndex: next,
      });
      notify();
    },

    selectPrevious(): void {
      const state = getState();
      const prev = Math.max(0, state.selectedStepIndex - 1);
      setState({
        ...state,
        selectedStepIndex: prev,
      });
      notify();
    },

    selectStep(index: number): void {
      const state = getState();
      setState({
        ...state,
        selectedStepIndex: index,
      });
      notify();
    },
  };
}
