/**
 * Phase Navigation
 *
 * Simplified flat phase list navigation (no agent tree).
 * Provides helpers for navigating the phase timeline.
 */

import type { WorkState, PhaseState } from "./types"

export interface NavigableItem {
  id: string
  type: "phase"
  phase: PhaseState
}

/**
 * Convert work state phases into a flat navigable list
 */
export function getPhaseLayout(state: WorkState): NavigableItem[] {
  return state.phases.map((phase) => ({
    id: `phase-${phase.index}`,
    type: "phase" as const,
    phase,
  }))
}

/**
 * Get the next phase index, clamped to bounds
 */
export function getNextPhaseIndex(currentIndex: number, totalPhases: number): number {
  return Math.min(currentIndex + 1, totalPhases - 1)
}

/**
 * Get the previous phase index, clamped to bounds
 */
export function getPreviousPhaseIndex(currentIndex: number): number {
  return Math.max(currentIndex - 1, 0)
}

/**
 * Calculate which items are visible in a viewport
 */
export function calculateVisibleItems(
  totalItems: number,
  viewportHeight: number,
  scrollOffset: number,
): { start: number; end: number } {
  const start = Math.max(0, scrollOffset)
  const end = Math.min(totalItems, start + viewportHeight)
  return { start, end }
}
