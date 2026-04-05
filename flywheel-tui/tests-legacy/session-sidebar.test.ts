import { describe, it, expect } from "bun:test";
import {
  groupSessions,
  sidebarKeyHandler,
  getOpenAction,
  type SessionGroup,
  type SidebarAction,
  GROUP_ORDER,
  GROUP_LABELS,
} from "../src/tui/session/sidebar-logic";
import type { SessionSummary } from "../src/orchestration/session/manager";
import type { SessionLifecycleState } from "../src/orchestration/session/state-machine";
import { makeSession, groupToFlatList } from "./helpers/sidebar";

// ---------------------------------------------------------------------------
// groupSessions()
// ---------------------------------------------------------------------------

describe("groupSessions", () => {
  it("returns all group keys even when no sessions exist", () => {
    const groups = groupSessions([]);
    expect(Object.keys(groups)).toEqual(
      expect.arrayContaining(["active", "paused", "archived", "trash"]),
    );
    for (const key of GROUP_ORDER) {
      expect(groups[key]).toHaveLength(0);
    }
  });

  it("groups work:active sessions into 'active'", () => {
    const sessions = [
      makeSession({ lifecycleState: "work:active", name: "Active 1" }),
      makeSession({ lifecycleState: "work:active", name: "Active 2" }),
    ];
    const groups = groupSessions(sessions);
    expect(groups.active).toHaveLength(2);
    expect(groups.paused).toHaveLength(0);
    expect(groups.archived).toHaveLength(0);
    expect(groups.trash).toHaveLength(0);
  });

  it("groups work:paused sessions into 'paused'", () => {
    const sessions = [
      makeSession({ lifecycleState: "work:paused", name: "Paused 1" }),
    ];
    const groups = groupSessions(sessions);
    expect(groups.paused).toHaveLength(1);
    expect(groups.active).toHaveLength(0);
  });

  it("groups archived sessions into 'archived'", () => {
    const sessions = [
      makeSession({ lifecycleState: "archived", name: "Archived 1" }),
    ];
    const groups = groupSessions(sessions);
    expect(groups.archived).toHaveLength(1);
  });

  it("groups trashed sessions into 'trash'", () => {
    const sessions = [
      makeSession({ lifecycleState: "trashed", name: "Trashed 1" }),
    ];
    const groups = groupSessions(sessions);
    expect(groups.trash).toHaveLength(1);
  });

  it("puts other lifecycle states into 'other'", () => {
    const sessions = [
      makeSession({ lifecycleState: "new", name: "New" }),
      makeSession({ lifecycleState: "plan:draft", name: "Draft" }),
      makeSession({ lifecycleState: "plan:imported", name: "Imported" }),
      makeSession({ lifecycleState: "plan:approved", name: "Approved" }),
      makeSession({ lifecycleState: "plan:needs-fix", name: "NeedsFix" }),
      makeSession({ lifecycleState: "work:review", name: "Review" }),
      makeSession({ lifecycleState: "completed", name: "Completed" }),
    ];
    const groups = groupSessions(sessions);
    expect(groups.other).toHaveLength(7);
    expect(groups.active).toHaveLength(0);
  });

  it("handles mixed lifecycle states correctly", () => {
    const sessions = [
      makeSession({ lifecycleState: "work:active", name: "Active" }),
      makeSession({ lifecycleState: "work:paused", name: "Paused" }),
      makeSession({ lifecycleState: "archived", name: "Archived" }),
      makeSession({ lifecycleState: "trashed", name: "Trashed" }),
      makeSession({ lifecycleState: "completed", name: "Completed" }),
    ];
    const groups = groupSessions(sessions);
    expect(groups.active).toHaveLength(1);
    expect(groups.paused).toHaveLength(1);
    expect(groups.archived).toHaveLength(1);
    expect(groups.trash).toHaveLength(1);
    expect(groups.other).toHaveLength(1);
  });

  it("preserves session order within groups", () => {
    const sessions = [
      makeSession({ lifecycleState: "work:active", name: "First" }),
      makeSession({ lifecycleState: "work:active", name: "Second" }),
      makeSession({ lifecycleState: "work:active", name: "Third" }),
    ];
    const groups = groupSessions(sessions);
    expect(groups.active.map((s) => s.name)).toEqual([
      "First",
      "Second",
      "Third",
    ]);
  });
});

// ---------------------------------------------------------------------------
// GROUP_LABELS & GROUP_ORDER
// ---------------------------------------------------------------------------

describe("GROUP_LABELS", () => {
  it("has labels for all groups", () => {
    expect(GROUP_LABELS.active).toBe("Active");
    expect(GROUP_LABELS.paused).toBe("Paused");
    expect(GROUP_LABELS.archived).toBe("Archived");
    expect(GROUP_LABELS.trash).toBe("Trash");
    expect(GROUP_LABELS.other).toBe("Other");
  });
});

describe("GROUP_ORDER", () => {
  it("has active first, then paused, other, archived, trash", () => {
    expect(GROUP_ORDER).toEqual(["active", "paused", "other", "archived", "trash"]);
  });
});

// ---------------------------------------------------------------------------
// sidebarKeyHandler — pure navigation logic
// ---------------------------------------------------------------------------

describe("sidebarKeyHandler", () => {
  // Build a flat list of session IDs for navigation tests
  const sessions = [
    makeSession({ lifecycleState: "work:active", name: "Active 1" }),
    makeSession({ lifecycleState: "work:active", name: "Active 2" }),
    makeSession({ lifecycleState: "work:paused", name: "Paused 1" }),
    makeSession({ lifecycleState: "archived", name: "Archived 1" }),
    makeSession({ lifecycleState: "trashed", name: "Trashed 1" }),
  ];

  // Flat list order follows GROUP_ORDER: active(2), paused(1), other(0), archived(1), trash(1)
  // Total navigable items: 5

  describe("move-down", () => {
    it("moves index from 0 to 1", () => {
      const result = sidebarKeyHandler("move-down", sessions, 0);
      expect(result.selectedIndex).toBe(1);
    });

    it("clamps at last index", () => {
      const result = sidebarKeyHandler("move-down", sessions, 4);
      expect(result.selectedIndex).toBe(4);
    });

    it("handles empty session list", () => {
      const result = sidebarKeyHandler("move-down", [], 0);
      expect(result.selectedIndex).toBe(0);
    });
  });

  describe("move-up", () => {
    it("moves index from 2 to 1", () => {
      const result = sidebarKeyHandler("move-up", sessions, 2);
      expect(result.selectedIndex).toBe(1);
    });

    it("clamps at 0", () => {
      const result = sidebarKeyHandler("move-up", sessions, 0);
      expect(result.selectedIndex).toBe(0);
    });

    it("handles empty session list", () => {
      const result = sidebarKeyHandler("move-up", [], 0);
      expect(result.selectedIndex).toBe(0);
    });
  });

  describe("select", () => {
    it("returns the session ID at the selected index", () => {
      const flatList = groupToFlatList(sessions);
      const result = sidebarKeyHandler("select", sessions, 0);
      expect(result.selectedSessionId).toBe(flatList[0].id);
    });

    it("returns undefined when index is out of bounds", () => {
      const result = sidebarKeyHandler("select", sessions, 99);
      expect(result.selectedSessionId).toBeUndefined();
    });

    it("returns undefined for empty list", () => {
      const result = sidebarKeyHandler("select", [], 0);
      expect(result.selectedSessionId).toBeUndefined();
    });
  });
});

// ---------------------------------------------------------------------------
// Selection callbacks — test that selecting triggers correct actions
// ---------------------------------------------------------------------------

describe("Session selection actions", () => {
  it("selecting a work:paused session returns 'resume' action", () => {
    const session = makeSession({ lifecycleState: "work:paused" });
    const sessions = [session];
    const result = sidebarKeyHandler("select", sessions, 0);
    expect(result.selectedSessionId).toBe(session.id);
    expect(result.action).toBe("resume");
  });

  it("selecting a work:active session returns 'open' action", () => {
    const session = makeSession({ lifecycleState: "work:active" });
    const sessions = [session];
    const result = sidebarKeyHandler("select", sessions, 0);
    expect(result.selectedSessionId).toBe(session.id);
    expect(result.action).toBe("open");
  });

  it("selecting a completed session returns 'open' action", () => {
    const session = makeSession({ lifecycleState: "completed" });
    const sessions = [session];
    const result = sidebarKeyHandler("select", sessions, 0);
    expect(result.selectedSessionId).toBe(session.id);
    expect(result.action).toBe("open");
  });

  it("selecting a work:review session returns 'open' action", () => {
    const session = makeSession({ lifecycleState: "work:review" });
    const sessions = [session];
    const result = sidebarKeyHandler("select", sessions, 0);
    expect(result.selectedSessionId).toBe(session.id);
    expect(result.action).toBe("open");
  });

  it("selecting an archived session returns no action (null — not selectable)", () => {
    const session = makeSession({ lifecycleState: "archived" });
    const sessions = [session];
    const result = sidebarKeyHandler("select", sessions, 0);
    expect(result.selectedSessionId).toBeUndefined();
    expect(result.action).toBeUndefined();
  });

  it("selecting a trashed session returns no action (null — not selectable)", () => {
    const session = makeSession({ lifecycleState: "trashed" });
    const sessions = [session];
    const result = sidebarKeyHandler("select", sessions, 0);
    expect(result.selectedSessionId).toBeUndefined();
    expect(result.action).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// getOpenAction — covers all lifecycle states
// ---------------------------------------------------------------------------

describe("getOpenAction (extended)", () => {
  it("work:paused → 'resume'", () => {
    const session = makeSession({ lifecycleState: "work:paused" });
    expect(getOpenAction(session)).toBe("resume");
  });

  it("budget_exhausted → 'resume'", () => {
    const session = makeSession({ lifecycleState: "budget_exhausted" });
    expect(getOpenAction(session)).toBe("resume");
  });

  it("work:active → 'open'", () => {
    const session = makeSession({ lifecycleState: "work:active" });
    expect(getOpenAction(session)).toBe("open");
  });

  it("completed → 'open' (view-only, not resume)", () => {
    const session = makeSession({ lifecycleState: "completed" });
    expect(getOpenAction(session)).toBe("open");
  });

  it("work:review → 'open'", () => {
    const session = makeSession({ lifecycleState: "work:review" });
    expect(getOpenAction(session)).toBe("open");
  });

  it("trashed → null (not selectable)", () => {
    const session = makeSession({ lifecycleState: "trashed" });
    expect(getOpenAction(session)).toBeNull();
  });

  it("archived → null (not selectable)", () => {
    const session = makeSession({ lifecycleState: "archived" });
    expect(getOpenAction(session)).toBeNull();
  });

  it("new → 'open'", () => {
    const session = makeSession({ lifecycleState: "new" });
    expect(getOpenAction(session)).toBe("open");
  });

  it("plan:draft → 'open'", () => {
    const session = makeSession({ lifecycleState: "plan:draft" });
    expect(getOpenAction(session)).toBe("open");
  });
});

// ---------------------------------------------------------------------------
// getOpenAction — new unified action
// ---------------------------------------------------------------------------

describe("getOpenAction", () => {
  it("work:active → 'open'", () => {
    const session = makeSession({ lifecycleState: "work:active" });
    expect(getOpenAction(session)).toBe("open");
  });

  it("work:paused → 'resume'", () => {
    const session = makeSession({ lifecycleState: "work:paused" });
    expect(getOpenAction(session)).toBe("resume");
  });

  it("budget_exhausted → 'resume'", () => {
    const session = makeSession({ lifecycleState: "budget_exhausted" });
    expect(getOpenAction(session)).toBe("resume");
  });

  it("completed → 'open'", () => {
    const session = makeSession({ lifecycleState: "completed" });
    expect(getOpenAction(session)).toBe("open");
  });

  it("work:review → 'open'", () => {
    const session = makeSession({ lifecycleState: "work:review" });
    expect(getOpenAction(session)).toBe("open");
  });

  it("new → 'open'", () => {
    const session = makeSession({ lifecycleState: "new" });
    expect(getOpenAction(session)).toBe("open");
  });

  it("plan:draft → 'open'", () => {
    const session = makeSession({ lifecycleState: "plan:draft" });
    expect(getOpenAction(session)).toBe("open");
  });

  it("plan:imported → 'open'", () => {
    const session = makeSession({ lifecycleState: "plan:imported" });
    expect(getOpenAction(session)).toBe("open");
  });

  it("plan:approved → 'open'", () => {
    const session = makeSession({ lifecycleState: "plan:approved" });
    expect(getOpenAction(session)).toBe("open");
  });

  it("plan:needs-fix → 'open'", () => {
    const session = makeSession({ lifecycleState: "plan:needs-fix" });
    expect(getOpenAction(session)).toBe("open");
  });

  it("trashed → null (not selectable)", () => {
    const session = makeSession({ lifecycleState: "trashed" });
    expect(getOpenAction(session)).toBeNull();
  });

  it("archived → null (not selectable)", () => {
    const session = makeSession({ lifecycleState: "archived" });
    expect(getOpenAction(session)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// sidebarKeyHandler — skip non-selectable sessions during navigation
// ---------------------------------------------------------------------------

describe("sidebarKeyHandler — skip non-selectable", () => {
  // Flat order (GROUP_ORDER): active, paused, other, archived, trash
  // So: [Active1, Paused1, Completed1, Archived1, Trashed1]
  const sessions = [
    makeSession({ lifecycleState: "work:active", name: "Active1" }),
    makeSession({ lifecycleState: "work:paused", name: "Paused1" }),
    makeSession({ lifecycleState: "completed", name: "Completed1" }),
    makeSession({ lifecycleState: "archived", name: "Archived1" }),
    makeSession({ lifecycleState: "trashed", name: "Trashed1" }),
  ];

  it("move-down from Completed1 (idx 2) skips Archived1 and Trashed1, clamps at 2", () => {
    // Completed1 is the last selectable item (idx 2), move-down should stay there
    const result = sidebarKeyHandler("move-down", sessions, 2);
    expect(result.selectedIndex).toBe(2);
  });

  it("move-up from Completed1 (idx 2) goes to Paused1 (idx 1)", () => {
    const result = sidebarKeyHandler("move-up", sessions, 2);
    expect(result.selectedIndex).toBe(1);
  });

  it("move-down from Active1 (idx 0) goes to Paused1 (idx 1)", () => {
    const result = sidebarKeyHandler("move-down", sessions, 0);
    expect(result.selectedIndex).toBe(1);
  });

  it("move-down from Paused1 (idx 1) goes to Completed1 (idx 2)", () => {
    const result = sidebarKeyHandler("move-down", sessions, 1);
    expect(result.selectedIndex).toBe(2);
  });

  it("handles all non-selectable list (only trashed/archived)", () => {
    const allNonSelectable = [
      makeSession({ lifecycleState: "archived", name: "A" }),
      makeSession({ lifecycleState: "trashed", name: "T" }),
    ];
    const result = sidebarKeyHandler("move-down", allNonSelectable, 0);
    // No selectable sessions, should stay at 0
    expect(result.selectedIndex).toBe(0);
  });

  it("select on a non-selectable session returns no action", () => {
    // Archived1 is at flat index 3 — but even if we try to select at idx 3
    const result = sidebarKeyHandler("select", sessions, 3);
    expect(result.selectedSessionId).toBeUndefined();
    expect(result.action).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// sidebarKeyHandler — delete action
// ---------------------------------------------------------------------------

describe("sidebarKeyHandler — delete action", () => {
  const sessions = [
    makeSession({ lifecycleState: "work:active", name: "Active1" }),
    makeSession({ lifecycleState: "work:paused", name: "Paused1" }),
    makeSession({ lifecycleState: "completed", name: "Completed1" }),
  ];

  it("delete action returns the session ID + 'delete' action", () => {
    const flat = groupToFlatList(sessions);
    const result = sidebarKeyHandler("delete", sessions, 0);
    expect(result.selectedSessionId).toBe(flat[0].id);
    expect(result.action).toBe("delete");
  });

  it("delete on non-selectable session returns no action", () => {
    const sessionsWithTrash = [
      makeSession({ lifecycleState: "trashed", name: "Trashed1" }),
    ];
    const result = sidebarKeyHandler("delete", sessionsWithTrash, 0);
    expect(result.selectedSessionId).toBeUndefined();
    expect(result.action).toBeUndefined();
  });

  it("delete on empty list returns no action", () => {
    const result = sidebarKeyHandler("delete", [], 0);
    expect(result.selectedSessionId).toBeUndefined();
    expect(result.action).toBeUndefined();
  });

  it("delete on out-of-bounds index returns no action", () => {
    const result = sidebarKeyHandler("delete", sessions, 99);
    expect(result.selectedSessionId).toBeUndefined();
    expect(result.action).toBeUndefined();
  });
});


