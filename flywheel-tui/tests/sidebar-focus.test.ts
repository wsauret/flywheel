import { describe, it, expect } from "bun:test";
import {
  sidebarKeyHandler,
  getSelectionAction,
  groupSessions,
  GROUP_ORDER,
  type SidebarAction,
  type SelectionAction,
} from "../src/tui/components/sidebar-logic";
import type { SessionSummary } from "../src/session/manager";
import type { SessionLifecycleState } from "../src/session/state-machine";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSession(
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

/** Mirrors the internal groupToFlatList used by sidebarKeyHandler. */
function groupToFlatList(sessions: SessionSummary[]): SessionSummary[] {
  const groups = groupSessions(sessions);
  const flat: SessionSummary[] = [];
  for (const key of GROUP_ORDER) {
    flat.push(...groups[key]);
  }
  return flat;
}

// ---------------------------------------------------------------------------
// Focus state management — modelled as pure state transitions
// ---------------------------------------------------------------------------

/**
 * The shell manages two boolean focus flags: sidebarFocused and promptFocused.
 * Invariant: at most one can be true at any time.
 *
 * We model the transition functions the shell would apply:
 *   focusSidebar()  → { sidebarFocused: true,  promptFocused: false }
 *   focusPrompt()   → { sidebarFocused: false, promptFocused: true  }
 *   blurSidebar()   → { sidebarFocused: false, promptFocused: false }
 */
interface FocusState {
  sidebarFocused: boolean;
  promptFocused: boolean;
}

function focusSidebar(state: FocusState): FocusState {
  return { sidebarFocused: true, promptFocused: false };
}

function focusPrompt(state: FocusState): FocusState {
  return { sidebarFocused: false, promptFocused: true };
}

function blurSidebar(state: FocusState): FocusState {
  return { sidebarFocused: false, promptFocused: false };
}

describe("focus state management", () => {
  it("both start as false (neither focused)", () => {
    const state: FocusState = { sidebarFocused: false, promptFocused: false };
    expect(state.sidebarFocused).toBe(false);
    expect(state.promptFocused).toBe(false);
  });

  it("activating sidebar focus clears prompt focus", () => {
    const state: FocusState = { sidebarFocused: false, promptFocused: true };
    const next = focusSidebar(state);
    expect(next.sidebarFocused).toBe(true);
    expect(next.promptFocused).toBe(false);
  });

  it("activating prompt focus clears sidebar focus", () => {
    const state: FocusState = { sidebarFocused: true, promptFocused: false };
    const next = focusPrompt(state);
    expect(next.sidebarFocused).toBe(false);
    expect(next.promptFocused).toBe(true);
  });

  it("deactivating sidebar focus leaves neither focused", () => {
    const state: FocusState = { sidebarFocused: true, promptFocused: false };
    const next = blurSidebar(state);
    expect(next.sidebarFocused).toBe(false);
    expect(next.promptFocused).toBe(false);
  });

  it("mutual exclusion holds across multiple transitions", () => {
    let state: FocusState = { sidebarFocused: false, promptFocused: false };

    state = focusSidebar(state);
    expect(state.sidebarFocused).toBe(true);
    expect(state.promptFocused).toBe(false);

    state = focusPrompt(state);
    expect(state.sidebarFocused).toBe(false);
    expect(state.promptFocused).toBe(true);

    state = focusSidebar(state);
    expect(state.sidebarFocused).toBe(true);
    expect(state.promptFocused).toBe(false);

    state = blurSidebar(state);
    expect(state.sidebarFocused).toBe(false);
    expect(state.promptFocused).toBe(false);
  });

  it("at most one flag is true in every reachable state", () => {
    const transitions = [focusSidebar, focusPrompt, blurSidebar];
    const initial: FocusState = { sidebarFocused: false, promptFocused: false };

    // Exhaustively apply every transition from every state
    const queue: FocusState[] = [initial];
    const visited = new Set<string>();

    while (queue.length > 0) {
      const state = queue.shift()!;
      const key = `${state.sidebarFocused},${state.promptFocused}`;
      if (visited.has(key)) continue;
      visited.add(key);

      // Invariant: at most one is true
      expect(state.sidebarFocused && state.promptFocused).toBe(false);

      for (const transition of transitions) {
        queue.push(transition(state));
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Sidebar navigation — shell perspective
// ---------------------------------------------------------------------------

describe("sidebar navigation (shell perspective)", () => {
  // Build sessions spanning all groups. Flat order follows GROUP_ORDER:
  // active(2), paused(1), other(1=completed), archived(1), trash(1)
  const sessions = [
    makeSession({ lifecycleState: "work:active", name: "Active 1" }),
    makeSession({ lifecycleState: "work:active", name: "Active 2" }),
    makeSession({ lifecycleState: "work:paused", name: "Paused 1" }),
    makeSession({ lifecycleState: "completed", name: "Completed 1" }),
    makeSession({ lifecycleState: "archived", name: "Archived 1" }),
    makeSession({ lifecycleState: "trashed", name: "Trashed 1" }),
  ];

  // Flat list: [Active1(0), Active2(1), Paused1(2), Completed1(3), Archived1(4), Trashed1(5)]
  // Selectable:  0          1            2            3              —              —

  it("move-down from index 0 moves to next selectable session", () => {
    const result = sidebarKeyHandler("move-down", sessions, 0);
    expect(result.selectedIndex).toBe(1);
  });

  it("move-up from last selectable index moves to previous selectable session", () => {
    // Last selectable is Completed1 at index 3
    const result = sidebarKeyHandler("move-up", sessions, 3);
    expect(result.selectedIndex).toBe(2);
  });

  it("move-down at end of selectable list stays at current index", () => {
    // Completed1 at index 3 is last selectable; move-down should stay
    const result = sidebarKeyHandler("move-down", sessions, 3);
    expect(result.selectedIndex).toBe(3);
  });

  it("move-up at start of list stays at current index", () => {
    const result = sidebarKeyHandler("move-up", sessions, 0);
    expect(result.selectedIndex).toBe(0);
  });

  it("navigation skips archived and trashed sessions", () => {
    // From Completed1 (idx 3), move-down should NOT go to Archived1 (idx 4)
    const r1 = sidebarKeyHandler("move-down", sessions, 3);
    expect(r1.selectedIndex).toBe(3); // stays — no selectable below

    // From Active1 (idx 0), repeated move-down should reach Completed1 but not Archived1
    let idx = 0;
    for (let i = 0; i < 10; i++) {
      const r = sidebarKeyHandler("move-down", sessions, idx);
      idx = r.selectedIndex;
    }
    expect(idx).toBe(3); // Completed1 is the floor
  });

  it("full traversal visits only selectable sessions in order", () => {
    const visited: number[] = [];
    let idx = 0;
    visited.push(idx);
    for (let i = 0; i < 10; i++) {
      const r = sidebarKeyHandler("move-down", sessions, idx);
      if (r.selectedIndex === idx) break;
      idx = r.selectedIndex;
      visited.push(idx);
    }
    // Should visit: Active1(0) → Active2(1) → Paused1(2) → Completed1(3)
    expect(visited).toEqual([0, 1, 2, 3]);
  });
});

// ---------------------------------------------------------------------------
// Selection actions from focused sidebar
// ---------------------------------------------------------------------------

describe("sidebar selection from focused state", () => {
  it("select on paused session returns resume action", () => {
    const session = makeSession({ lifecycleState: "work:paused" });
    const result = sidebarKeyHandler("select", [session], 0);
    expect(result.action).toBe("resume");
    expect(result.selectedSessionId).toBe(session.id);
  });

  it("select on active session returns switch action", () => {
    const session = makeSession({ lifecycleState: "work:active" });
    const result = sidebarKeyHandler("select", [session], 0);
    expect(result.action).toBe("switch");
    expect(result.selectedSessionId).toBe(session.id);
  });

  it("select on completed session returns view action", () => {
    const session = makeSession({ lifecycleState: "completed" });
    const result = sidebarKeyHandler("select", [session], 0);
    expect(result.action).toBe("view");
    expect(result.selectedSessionId).toBe(session.id);
  });

  it("select on trashed session returns no action", () => {
    const session = makeSession({ lifecycleState: "trashed" });
    const result = sidebarKeyHandler("select", [session], 0);
    expect(result.selectedSessionId).toBeUndefined();
    expect(result.action).toBeUndefined();
  });

  it("select on archived session returns no action", () => {
    const session = makeSession({ lifecycleState: "archived" });
    const result = sidebarKeyHandler("select", [session], 0);
    expect(result.selectedSessionId).toBeUndefined();
    expect(result.action).toBeUndefined();
  });

  it("delete action returns delete for selectable sessions", () => {
    const session = makeSession({ lifecycleState: "work:active" });
    const result = sidebarKeyHandler("delete", [session], 0);
    expect(result.action).toBe("delete");
    expect(result.selectedSessionId).toBe(session.id);
  });

  it("delete action returns no action for non-selectable sessions", () => {
    const session = makeSession({ lifecycleState: "archived" });
    const result = sidebarKeyHandler("delete", [session], 0);
    expect(result.selectedSessionId).toBeUndefined();
    expect(result.action).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Guard conditions — sidebar focus activation
// ---------------------------------------------------------------------------

/**
 * Models the guard condition the shell checks before allowing sidebar focus.
 * The sidebar is only visible (and focusable) when:
 *   1. There are sessions to display
 *   2. The terminal is wide enough (>= 90 columns)
 */
function canFocusSidebar(sessions: SessionSummary[], terminalWidth: number): boolean {
  return sessions.length > 0 && terminalWidth >= 90;
}

describe("sidebar focus guard conditions", () => {
  it("sidebar focus should not activate with no sessions", () => {
    expect(canFocusSidebar([], 120)).toBe(false);
  });

  it("sidebar focus should not activate when terminal < 90 cols", () => {
    const sessions = [makeSession({ lifecycleState: "work:active" })];
    expect(canFocusSidebar(sessions, 80)).toBe(false);
    expect(canFocusSidebar(sessions, 89)).toBe(false);
  });

  it("sidebar focus activates when sessions exist and terminal >= 90 cols", () => {
    const sessions = [makeSession({ lifecycleState: "work:active" })];
    expect(canFocusSidebar(sessions, 90)).toBe(true);
    expect(canFocusSidebar(sessions, 120)).toBe(true);
    expect(canFocusSidebar(sessions, 200)).toBe(true);
  });

  it("sidebar focus activates at exact boundary (90 cols)", () => {
    const sessions = [makeSession({ lifecycleState: "completed" })];
    expect(canFocusSidebar(sessions, 89)).toBe(false);
    expect(canFocusSidebar(sessions, 90)).toBe(true);
  });

  it("sidebar focus with only non-selectable sessions still activates (sidebar is visible)", () => {
    // Archived/trashed sessions still appear in the sidebar — the sidebar is still visible
    const sessions = [
      makeSession({ lifecycleState: "archived" }),
      makeSession({ lifecycleState: "trashed" }),
    ];
    expect(canFocusSidebar(sessions, 120)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Mouse click behavior — getSelectionAction + flat index lookup
// ---------------------------------------------------------------------------

describe("sidebar mouse click behavior", () => {
  it("getSelectionAction returns resume for paused session", () => {
    const session = makeSession({ lifecycleState: "work:paused" });
    expect(getSelectionAction(session)).toBe("resume");
  });

  it("getSelectionAction returns switch for active session", () => {
    const session = makeSession({ lifecycleState: "work:active" });
    expect(getSelectionAction(session)).toBe("switch");
  });

  it("getSelectionAction returns null for archived session", () => {
    const session = makeSession({ lifecycleState: "archived" });
    expect(getSelectionAction(session)).toBeNull();
  });

  it("getSelectionAction returns null for trashed session", () => {
    const session = makeSession({ lifecycleState: "trashed" });
    expect(getSelectionAction(session)).toBeNull();
  });

  it("clicking a session should determine the correct flat index", () => {
    const active = makeSession({ lifecycleState: "work:active", name: "Active" });
    const paused = makeSession({ lifecycleState: "work:paused", name: "Paused" });
    const completed = makeSession({ lifecycleState: "completed", name: "Completed" });
    const archived = makeSession({ lifecycleState: "archived", name: "Archived" });

    const sessions = [active, paused, completed, archived];
    const flatList = groupToFlatList(sessions);

    // Flat order: active, paused, other(completed), archived
    const activeIdx = flatList.findIndex((s) => s.id === active.id);
    const pausedIdx = flatList.findIndex((s) => s.id === paused.id);
    const completedIdx = flatList.findIndex((s) => s.id === completed.id);
    const archivedIdx = flatList.findIndex((s) => s.id === archived.id);

    expect(activeIdx).toBe(0);
    expect(pausedIdx).toBe(1);
    expect(completedIdx).toBe(2);
    expect(archivedIdx).toBe(3);

    // Verify that selecting at those indices produces correct actions
    expect(sidebarKeyHandler("select", sessions, activeIdx).action).toBe("switch");
    expect(sidebarKeyHandler("select", sessions, pausedIdx).action).toBe("resume");
    expect(sidebarKeyHandler("select", sessions, completedIdx).action).toBe("view");
    // Archived is not selectable
    expect(sidebarKeyHandler("select", sessions, archivedIdx).action).toBeUndefined();
  });

  it("flat index order respects GROUP_ORDER for mixed sessions", () => {
    // Create sessions in random lifecycle order
    const trashed = makeSession({ lifecycleState: "trashed", name: "Trashed" });
    const paused = makeSession({ lifecycleState: "work:paused", name: "Paused" });
    const active = makeSession({ lifecycleState: "work:active", name: "Active" });
    const review = makeSession({ lifecycleState: "work:review", name: "Review" });
    const archived = makeSession({ lifecycleState: "archived", name: "Archived" });

    const sessions = [trashed, paused, active, review, archived];
    const flatList = groupToFlatList(sessions);

    // GROUP_ORDER: active, paused, other(review), archived, trash
    expect(flatList.map((s) => s.name)).toEqual([
      "Active",
      "Paused",
      "Review",
      "Archived",
      "Trashed",
    ]);
  });
});
