/**
 * Shared test helpers for sidebar tests.
 *
 * Extracted from session-sidebar.test.ts and sidebar-focus.test.ts
 * to eliminate duplication.
 */

import {
  groupToFlatList,
} from "../../src/tui/session/sidebar-logic";
import type { SessionSummary } from "../../src/orchestration/session/manager";
import type { SessionState } from "../../src/orchestration/session/state-machine";

// Re-export the canonical groupToFlatList from sidebar-logic
export { groupToFlatList } from "../../src/tui/session/sidebar-logic";

/**
 * Create a minimal SessionSummary for testing.
 * Only state is required; all other fields have defaults.
 */
export function makeSession(
  overrides: Partial<SessionSummary> & { state: SessionState },
): SessionSummary {
  return {
    id: crypto.randomUUID(),
    name: "Test Session",
    planPath: "plans/test.md",
    currentStep: 0,
    totalCost: 0,
    lastUpdated: new Date().toISOString(),
    ...overrides,
  };
}
