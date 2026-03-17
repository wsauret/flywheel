import { describe, it, expect } from "bun:test";
import {
  groupSessions,
  sidebarKeyHandler,
  type SessionGroup,
  type SidebarAction,
  GROUP_ORDER,
  GROUP_LABELS,
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

  it("selecting a work:active session returns 'switch' action", () => {
    const session = makeSession({ lifecycleState: "work:active" });
    const sessions = [session];
    const result = sidebarKeyHandler("select", sessions, 0);
    expect(result.selectedSessionId).toBe(session.id);
    expect(result.action).toBe("switch");
  });

  it("selecting a completed session returns 'view' action", () => {
    const session = makeSession({ lifecycleState: "completed" });
    const sessions = [session];
    const result = sidebarKeyHandler("select", sessions, 0);
    expect(result.selectedSessionId).toBe(session.id);
    expect(result.action).toBe("view");
  });

  it("selecting an archived session returns 'view' action", () => {
    const session = makeSession({ lifecycleState: "archived" });
    const sessions = [session];
    const result = sidebarKeyHandler("select", sessions, 0);
    expect(result.action).toBe("view");
  });

  it("selecting a trashed session returns 'view' action", () => {
    const session = makeSession({ lifecycleState: "trashed" });
    const sessions = [session];
    const result = sidebarKeyHandler("select", sessions, 0);
    expect(result.action).toBe("view");
  });
});

// ---------------------------------------------------------------------------
// Helper — mirrors the groupToFlatList used internally
// ---------------------------------------------------------------------------

function groupToFlatList(sessions: SessionSummary[]): SessionSummary[] {
  const groups = groupSessions(sessions);
  const flat: SessionSummary[] = [];
  for (const key of GROUP_ORDER) {
    flat.push(...groups[key]);
  }
  return flat;
}
