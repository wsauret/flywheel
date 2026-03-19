/**
 * Shared test helpers for sidebar tests.
 *
 * Extracted from session-sidebar.test.ts and sidebar-focus.test.ts
 * to eliminate duplication.
 */

import {
  groupToFlatList,
} from "../../src/tui/components/sidebar-logic";
import type { SessionSummary } from "../../src/session/manager";
import type { SessionLifecycleState } from "../../src/session/state-machine";

// Re-export the canonical groupToFlatList from sidebar-logic
export { groupToFlatList } from "../../src/tui/components/sidebar-logic";

/**
 * Create a minimal SessionSummary for testing.
 * Only lifecycleState is required; all other fields have defaults.
 */
export function makeSession(
  overrides: Partial<SessionSummary> & { lifecycleState: SessionLifecycleState },
): SessionSummary {
  return {
    id: crypto.randomUUID(),
    name: "Test Session",
    planPath: "plans/test.md",
    currentPhase: 0,
    totalCost: 0,
    lastUpdated: new Date().toISOString(),
    ...overrides,
  };
}
