/**
 * Phase Action Creators
 *
 * Factory that takes store context and returns phase mutation functions.
 */

import type { WorkState, PhaseState } from "../../../state/types";

export interface StoreContext {
  getState(): WorkState;
  setState(s: WorkState): void;
  notify(): void;
  notifyImmediate(): void;
}

export function createPhaseActions(ctx: StoreContext) {
  const { getState, setState, notify, notifyImmediate } = ctx;

  return {
    addPhase(phase: { index: number; name: string }): void {
      const state = getState();
      const newPhase: PhaseState = {
        index: phase.index,
        name: phase.name,
        status: "pending",
      };
      setState({
        ...state,
        phases: [...state.phases, newPhase],
      });
      notify();
    },

    startPhase(index: number, name: string): void {
      const state = getState();
      const existing = state.phases.find((p) => p.index === index);

      let phases: PhaseState[];
      if (existing) {
        phases = state.phases.map((p) =>
          p.index === index
            ? { ...p, status: "running" as const, name, startTime: Date.now() }
            : p
        );
      } else {
        phases = [
          ...state.phases,
          { index, name, status: "running" as const, startTime: Date.now() },
        ];
      }

      setState({
        ...state,
        phases,
        selectedPhaseIndex: index,
      });
      notifyImmediate();
    },

    completePhase(index: number): void {
      const state = getState();
      const phase = state.phases.find((p) => p.index === index);
      if (!phase) return;

      const now = Date.now();
      const duration = phase.startTime ? (now - phase.startTime) / 1000 : 0;

      setState({
        ...state,
        phases: state.phases.map((p) =>
          p.index === index
            ? { ...p, status: "completed" as const, endTime: now, duration }
            : p
        ),
      });
      notify();
    },

    failPhase(index: number, reason: string): void {
      const state = getState();
      const phase = state.phases.find((p) => p.index === index);
      if (!phase) return;

      const now = Date.now();
      setState({
        ...state,
        phases: state.phases.map((p) =>
          p.index === index
            ? { ...p, status: "failed" as const, endTime: now, error: reason }
            : p
        ),
      });
      notify();
    },

    skipPhase(index: number): void {
      const state = getState();
      setState({
        ...state,
        phases: state.phases.map((p) =>
          p.index === index
            ? { ...p, status: "skipped" as const }
            : p
        ),
      });
      notify();
    },
  };
}
