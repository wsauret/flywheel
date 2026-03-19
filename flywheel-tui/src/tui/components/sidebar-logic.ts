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
export type SelectionAction = "open" | "delete";

/** Keyboard actions the sidebar handles. */
export type SidebarAction = "move-up" | "move-down" | "select" | "delete";

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
 *
 * Exported for use in memoized flat-list derivation in the shell.
 */
export function groupToFlatList(sessions: SessionSummary[]): SessionSummary[] {
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
 * Determine whether a session can be opened in the viewport.
 * Returns "open" for all selectable sessions, null for archived/trashed.
 */
export function getOpenAction(session: SessionSummary): SelectionAction | null {
  switch (session.lifecycleState) {
    case "trashed":
    case "archived":
      return null;
    default:
      return "open";
  }
}

/**
 * Determine what action to take when a session is selected.
 * Returns null for non-selectable sessions (trashed / archived).
 *
 * @deprecated Use `getOpenAction()` instead. Kept for backward compatibility.
 */
export function getSelectionAction(session: SessionSummary): SelectionAction | null {
  return getOpenAction(session);
}

// ---------------------------------------------------------------------------
// sidebarKeyHandler
// ---------------------------------------------------------------------------

/**
 * Check whether a session is selectable (not trashed/archived).
 */
function isSelectable(session: SessionSummary): boolean {
  return getSelectionAction(session) !== null;
}

/**
 * Find the next selectable index in the given direction.
 * Returns `fallback` if no selectable session exists.
 */
function findNextSelectable(
  flatList: SessionSummary[],
  from: number,
  direction: 1 | -1,
  fallback: number,
): number {
  let idx = from;
  while (idx >= 0 && idx < flatList.length) {
    if (isSelectable(flatList[idx])) return idx;
    idx += direction;
  }
  return fallback;
}

/**
 * Pure function handling sidebar keyboard navigation.
 *
 * @param action - The keyboard action (move-up, move-down, select, delete)
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

  switch (action) {
    case "move-down": {
      if (flatList.length === 0) return { selectedIndex: 0 };
      // Find next selectable session below current position
      const next = findNextSelectable(flatList, currentIndex + 1, 1, currentIndex);
      return { selectedIndex: next };
    }
    case "move-up": {
      if (flatList.length === 0) return { selectedIndex: 0 };
      // Find next selectable session above current position
      const next = findNextSelectable(flatList, currentIndex - 1, -1, currentIndex);
      return { selectedIndex: next };
    }
    case "select": {
      if (flatList.length === 0 || currentIndex >= flatList.length) {
        return { selectedIndex: currentIndex };
      }
      const session = flatList[currentIndex];
      const selectionAction = getSelectionAction(session);
      if (selectionAction === null) {
        // Non-selectable session — no action
        return { selectedIndex: currentIndex };
      }
      return {
        selectedIndex: currentIndex,
        selectedSessionId: session.id,
        action: selectionAction,
      };
    }
    case "delete": {
      if (flatList.length === 0 || currentIndex >= flatList.length) {
        return { selectedIndex: currentIndex };
      }
      const session = flatList[currentIndex];
      if (!isSelectable(session)) {
        // Non-selectable session — no delete action
        return { selectedIndex: currentIndex };
      }
      return {
        selectedIndex: currentIndex,
        selectedSessionId: session.id,
        action: "delete",
      };
    }
  }
}
