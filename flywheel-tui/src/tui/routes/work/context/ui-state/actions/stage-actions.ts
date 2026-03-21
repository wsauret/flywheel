/**
 * Stage Action Creators
 *
 * Factory that takes store context and returns stage mutation functions.
 * Stages are hierarchical groups (plan, work, review, ship) that contain phases.
 * Used in pipeline mode to track cross-stage progress.
 */

import type { PhaseState, StageGroup } from "../../../state/types";
import type { StoreContext } from "./phase-actions";

export function createStageActions(ctx: StoreContext) {
  const { getState, setState, notify, notifyImmediate } = ctx;

  /**
   * Helper: return a new stages array with the target stage replaced.
   * Returns null if the stage is not found (no-op).
   */
  function mapStage(
    stages: StageGroup[],
    label: string,
    fn: (stage: StageGroup) => StageGroup,
  ): StageGroup[] | null {
    let found = false;
    const result = stages.map((s) => {
      if (s.label === label) {
        found = true;
        return fn(s);
      }
      return s;
    });
    return found ? result : null;
  }

  return {
    addStage(label: string): void {
      const state = getState();
      // Don't add duplicate stages
      if (state.stages.some((s) => s.label === label)) return;
      const newStage: StageGroup = {
        label,
        status: "pending",
        phases: [],
      };
      setState({
        ...state,
        stages: [...state.stages, newStage],
      });
      notify();
    },

    startStage(label: string): void {
      const state = getState();
      const stages = mapStage(state.stages, label, (s) => ({
        ...s,
        status: "running",
      }));
      if (!stages) return;
      setState({ ...state, stages });
      notifyImmediate();
    },

    completeStage(label: string): void {
      const state = getState();
      const stages = mapStage(state.stages, label, (s) => ({
        ...s,
        status: "completed",
      }));
      if (!stages) return;
      setState({ ...state, stages });
      notify();
    },

    failStage(label: string): void {
      const state = getState();
      const stages = mapStage(state.stages, label, (s) => ({
        ...s,
        status: "failed",
      }));
      if (!stages) return;
      setState({ ...state, stages });
      notify();
    },

    addPhaseToStage(stageLabel: string, phase: PhaseState): void {
      const state = getState();
      const stages = mapStage(state.stages, stageLabel, (s) => ({
        ...s,
        phases: [...s.phases, phase],
      }));
      if (!stages) return;
      setState({ ...state, stages });
      notify();
    },

    startPhaseInStage(stageLabel: string, phaseIndex: number, name: string): void {
      const state = getState();
      const stages = mapStage(state.stages, stageLabel, (s) => {
        const existing = s.phases.find((p) => p.index === phaseIndex);
        let phases: PhaseState[];
        if (existing) {
          phases = s.phases.map((p) =>
            p.index === phaseIndex
              ? { ...p, status: "running" as const, name, startTime: Date.now() }
              : p,
          );
        } else {
          phases = [
            ...s.phases,
            { index: phaseIndex, name, status: "running" as const, startTime: Date.now() },
          ];
        }
        return { ...s, phases };
      });
      if (!stages) return;
      setState({ ...state, stages });
      notifyImmediate();
    },

    completePhaseInStage(stageLabel: string, phaseIndex: number): void {
      const state = getState();
      const stages = mapStage(state.stages, stageLabel, (s) => {
        const phase = s.phases.find((p) => p.index === phaseIndex);
        if (!phase) return s;
        const now = Date.now();
        const duration = phase.startTime ? (now - phase.startTime) / 1000 : 0;
        return {
          ...s,
          phases: s.phases.map((p) =>
            p.index === phaseIndex
              ? { ...p, status: "completed" as const, endTime: now, duration }
              : p,
          ),
        };
      });
      if (!stages) return;
      setState({ ...state, stages });
      notify();
    },

    failPhaseInStage(stageLabel: string, phaseIndex: number, reason: string): void {
      const state = getState();
      const stages = mapStage(state.stages, stageLabel, (s) => {
        const phase = s.phases.find((p) => p.index === phaseIndex);
        if (!phase) return s;
        const now = Date.now();
        return {
          ...s,
          phases: s.phases.map((p) =>
            p.index === phaseIndex
              ? { ...p, status: "failed" as const, endTime: now, error: reason }
              : p,
          ),
        };
      });
      if (!stages) return;
      setState({ ...state, stages });
      notify();
    },
  };
}
