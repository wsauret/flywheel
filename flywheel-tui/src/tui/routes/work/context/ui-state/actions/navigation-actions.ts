/**
 * Navigation Action Creators
 *
 * Factory that takes store context and returns navigation mutation functions.
 */

import type { StoreContext } from "./phase-actions";

export function createNavigationActions(ctx: StoreContext) {
  const { getState, setState, notify } = ctx;

  return {
    selectNext(): void {
      const state = getState();
      const maxIndex = Math.max(0, state.phases.length - 1);
      const next = Math.min(state.selectedPhaseIndex + 1, maxIndex);
      setState({
        ...state,
        selectedPhaseIndex: next,
      });
      notify();
    },

    selectPrevious(): void {
      const state = getState();
      const prev = Math.max(0, state.selectedPhaseIndex - 1);
      setState({
        ...state,
        selectedPhaseIndex: prev,
      });
      notify();
    },

    selectPhase(index: number): void {
      const state = getState();
      setState({
        ...state,
        selectedPhaseIndex: index,
      });
      notify();
    },
  };
}
