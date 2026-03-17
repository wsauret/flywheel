/**
 * Sidebar Logic — Pure functions for session sidebar
 *
 * Separated from JSX to enable unit testing without OpenTUI rendering.
 * Handles: session grouping by lifecycle state, keyboard navigation,
 * and selection action determination.
 */

import type { SessionSummary } from "../../session/manager";
import type { SessionLifecycleState } from "../../session/state-machine";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Display group keys for the sidebar. */
export type SessionGroupKey = "active" | "paused" | "other" | "archived" | "trash";

/** Map of group key → sessions in that group. */
export type SessionGroup = Record<SessionGroupKey, SessionSummary[]>;

/** Actions the sidebar can trigger when a session is selected. */
export type SelectionAction = "switch" | "resume" | "view";

/** Keyboard actions the sidebar handles. */
export type SidebarAction = "move-up" | "move-down" | "select";

/** Result of a sidebar key handler invocation. */
export interface SidebarKeyResult {
  selectedIndex: number;
  selectedSessionId?: string;
  action?: SelectionAction;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Display order for sidebar groups. */
export const GROUP_ORDER: readonly SessionGroupKey[] = [
  "active",
  "paused",
  "other",
  "archived",
  "trash",
] as const;

/** Human-readable labels for each group. */
export const GROUP_LABELS: Readonly<Record<SessionGroupKey, string>> = {
  active: "Active",
  paused: "Paused",
  other: "Other",
  archived: "Archived",
  trash: "Trash",
};

// ---------------------------------------------------------------------------
// Lifecycle state → group mapping
// ---------------------------------------------------------------------------

const STATE_TO_GROUP: Readonly<Record<SessionLifecycleState, SessionGroupKey>> = {
  "new": "other",
  "plan:draft": "other",
  "plan:imported": "other",
  "plan:approved": "other",
  "plan:needs-fix": "other",
  "work:active": "active",
  "work:paused": "paused",
  "work:review": "other",
  "completed": "other",
  "archived": "archived",
  "trashed": "trash",
};

// ---------------------------------------------------------------------------
// groupSessions
// ---------------------------------------------------------------------------

/**
 * Group an array of SessionSummary objects into display groups.
 * Preserves original order within each group.
 */
export function groupSessions(sessions: SessionSummary[]): SessionGroup {
  const groups: SessionGroup = {
    active: [],
    paused: [],
    other: [],
    archived: [],
    trash: [],
  };

  for (const session of sessions) {
    const key = STATE_TO_GROUP[session.lifecycleState] ?? "other";
    groups[key].push(session);
  }

  return groups;
}

// ---------------------------------------------------------------------------
// Flat list helper
// ---------------------------------------------------------------------------

/**
 * Flatten grouped sessions into a single ordered list following GROUP_ORDER.
 * This is the navigation order for up/down keys.
 */
function groupToFlatList(sessions: SessionSummary[]): SessionSummary[] {
  const groups = groupSessions(sessions);
  const flat: SessionSummary[] = [];
  for (const key of GROUP_ORDER) {
    flat.push(...groups[key]);
  }
  return flat;
}

// ---------------------------------------------------------------------------
// Selection action determination
// ---------------------------------------------------------------------------

/**
 * Determine what action to take when a session is selected.
 */
function getSelectionAction(session: SessionSummary): SelectionAction {
  switch (session.lifecycleState) {
    case "work:active":
      return "switch";
    case "work:paused":
      return "resume";
    default:
      return "view";
  }
}

// ---------------------------------------------------------------------------
// sidebarKeyHandler
// ---------------------------------------------------------------------------

/**
 * Pure function handling sidebar keyboard navigation.
 *
 * @param action - The keyboard action (move-up, move-down, select)
 * @param sessions - All sessions (ungrouped; will be grouped internally)
 * @param currentIndex - Current selected index in the flat list
 * @returns Updated index and optional selection info
 */
export function sidebarKeyHandler(
  action: SidebarAction,
  sessions: SessionSummary[],
  currentIndex: number,
): SidebarKeyResult {
  const flatList = groupToFlatList(sessions);
  const maxIndex = Math.max(0, flatList.length - 1);

  switch (action) {
    case "move-down": {
      if (flatList.length === 0) return { selectedIndex: 0 };
      return { selectedIndex: Math.min(currentIndex + 1, maxIndex) };
    }
    case "move-up": {
      if (flatList.length === 0) return { selectedIndex: 0 };
      return { selectedIndex: Math.max(currentIndex - 1, 0) };
    }
    case "select": {
      if (flatList.length === 0 || currentIndex >= flatList.length) {
        return { selectedIndex: currentIndex, selectedSessionId: undefined };
      }
      const session = flatList[currentIndex];
      return {
        selectedIndex: currentIndex,
        selectedSessionId: session.id,
        action: getSelectionAction(session),
      };
    }
  }
}
