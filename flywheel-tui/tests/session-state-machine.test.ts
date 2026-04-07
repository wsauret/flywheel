import { describe, it, expect } from "bun:test";
import {
  SessionLifecycleStateSchema,
  type SessionLifecycleState,
  VALID_TRANSITIONS,
  isValidTransition,
  isResumable,
} from "../src/orchestration/session/state-machine";

// ---------------------------------------------------------------------------
// SessionLifecycleStateSchema (z.enum — boundary type)
// ---------------------------------------------------------------------------
describe("SessionLifecycleStateSchema", () => {
  const allStates: SessionLifecycleState[] = [
    "new",
    "plan:draft",
    "plan:imported",
    "plan:approved",
    "plan:needs-fix",
    "work:active",
    "work:paused",
    "work:review",
    "chat:active",
    "chat:idle",
    "budget_exhausted",
    "completed",
    "archived",
    "trashed",
  ];

  it("defines exactly 14 states", () => {
    expect(SessionLifecycleStateSchema.options).toHaveLength(14);
  });

  for (const state of allStates) {
    it(`accepts '${state}'`, () => {
      const result = SessionLifecycleStateSchema.safeParse(state);
      expect(result.success).toBe(true);
    });
  }

  it("rejects an unknown state string", () => {
    const result = SessionLifecycleStateSchema.safeParse("running");
    expect(result.success).toBe(false);
  });

  it("rejects a number", () => {
    const result = SessionLifecycleStateSchema.safeParse(42);
    expect(result.success).toBe(false);
  });

  it("rejects null", () => {
    const result = SessionLifecycleStateSchema.safeParse(null);
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// VALID_TRANSITIONS record
// ---------------------------------------------------------------------------
describe("VALID_TRANSITIONS", () => {
  it("is a frozen object (immutable)", () => {
    expect(Object.isFrozen(VALID_TRANSITIONS)).toBe(true);
  });

  it("has an entry for every state in the schema", () => {
    const states = SessionLifecycleStateSchema.options;
    for (const state of states) {
      expect(VALID_TRANSITIONS).toHaveProperty(state);
    }
  });

  it("trashed is terminal with empty transition array", () => {
    expect(VALID_TRANSITIONS["trashed"]).toEqual([]);
  });

  it("archived can only transition to trashed", () => {
    expect(VALID_TRANSITIONS["archived"]).toEqual(["trashed"]);
  });

  it("every target in a transition array is a valid state", () => {
    const states = new Set<string>(SessionLifecycleStateSchema.options);
    for (const [_from, targets] of Object.entries(VALID_TRANSITIONS) as [
      string,
      readonly string[],
    ][]) {
      for (const target of targets) {
        expect(states.has(target)).toBe(true);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// isValidTransition — valid transitions
// ---------------------------------------------------------------------------
describe("isValidTransition — valid transitions", () => {
  const validCases: [SessionLifecycleState, SessionLifecycleState][] = [
    // new ->
    ["new", "plan:draft"],
    ["new", "plan:imported"],
    ["new", "trashed"],
    ["new", "chat:active"],
    // plan:draft ->
    ["plan:draft", "plan:imported"],
    ["plan:draft", "plan:needs-fix"],
    ["plan:draft", "trashed"],
    // plan:imported ->
    ["plan:imported", "plan:approved"],
    ["plan:imported", "plan:needs-fix"],
    ["plan:imported", "trashed"],
    // plan:approved ->
    ["plan:approved", "work:active"],
    ["plan:approved", "trashed"],
    // plan:needs-fix ->
    ["plan:needs-fix", "plan:imported"],
    ["plan:needs-fix", "plan:approved"],
    ["plan:needs-fix", "trashed"],
    // work:active ->
    ["work:active", "work:paused"],
    ["work:active", "work:review"],
    ["work:active", "completed"],
    ["work:active", "trashed"],
    ["work:active", "budget_exhausted"],
    // work:paused ->
    ["work:paused", "work:active"],
    ["work:paused", "trashed"],
    ["work:paused", "archived"],
    // budget_exhausted ->
    ["budget_exhausted", "work:active"],
    ["budget_exhausted", "trashed"],
    // work:review ->
    ["work:review", "work:active"],
    ["work:review", "completed"],
    ["work:review", "trashed"],
    // chat:active ->
    ["chat:active", "chat:idle"],
    ["chat:active", "completed"],
    ["chat:active", "trashed"],
    // chat:idle ->
    ["chat:idle", "chat:active"],
    ["chat:idle", "completed"],
    ["chat:idle", "trashed"],
    // completed ->
    ["completed", "archived"],
    ["completed", "trashed"],
    ["completed", "work:active"],
  ];

  for (const [from, to] of validCases) {
    it(`allows ${from} -> ${to}`, () => {
      expect(isValidTransition(from, to)).toBe(true);
    });
  }
});

// ---------------------------------------------------------------------------
// isValidTransition — invalid transitions
// ---------------------------------------------------------------------------
describe("isValidTransition — invalid transitions", () => {
  const invalidCases: [SessionLifecycleState, SessionLifecycleState][] = [
    // new cannot jump to work or completed
    ["new", "work:active"],
    ["new", "completed"],
    ["new", "archived"],
    // plan:approved cannot go backwards
    ["plan:approved", "plan:draft"],
    ["plan:approved", "new"],
    // terminal states reject all outbound
    ["archived", "new"],
    ["archived", "work:active"],
    ["archived", "completed"],
    ["trashed", "new"],
    ["trashed", "archived"],
    ["trashed", "plan:draft"],
    ["trashed", "work:active"],
    // self-transitions are not valid
    ["new", "new"],
    ["work:active", "work:active"],
    ["archived", "archived"],
    ["trashed", "trashed"],
    // completed cannot go to plan states
    ["completed", "plan:draft"],
    ["completed", "plan:imported"],
    ["completed", "new"],
    // cross-kind transitions are invalid
    ["chat:active", "work:active"],
    ["chat:active", "work:paused"],
    ["work:active", "chat:idle"],
    ["work:active", "chat:active"],
    // self-transitions for chat states
    ["chat:active", "chat:active"],
    ["chat:idle", "chat:idle"],
  ];

  for (const [from, to] of invalidCases) {
    it(`rejects ${from} -> ${to}`, () => {
      expect(isValidTransition(from, to)).toBe(false);
    });
  }
});

// ---------------------------------------------------------------------------
// isValidTransition — skip edges (multi-hop valid paths)
// ---------------------------------------------------------------------------
describe("isValidTransition — skip edges (multi-hop paths)", () => {
  it("new -> plan:imported -> plan:approved -> work:active (fast import path)", () => {
    expect(isValidTransition("new", "plan:imported")).toBe(true);
    expect(isValidTransition("plan:imported", "plan:approved")).toBe(true);
    expect(isValidTransition("plan:approved", "work:active")).toBe(true);
  });

  it("plan:needs-fix -> plan:approved -> work:active (fix-then-approve shortcut)", () => {
    expect(isValidTransition("plan:needs-fix", "plan:approved")).toBe(true);
    expect(isValidTransition("plan:approved", "work:active")).toBe(true);
  });

  it("work:active -> completed -> work:active (re-run cycle)", () => {
    expect(isValidTransition("work:active", "completed")).toBe(true);
    expect(isValidTransition("completed", "work:active")).toBe(true);
  });

  it("work:active -> work:paused -> work:active (pause/resume cycle)", () => {
    expect(isValidTransition("work:active", "work:paused")).toBe(true);
    expect(isValidTransition("work:paused", "work:active")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Regression: new -> trashed must be allowed (was missing from VALID_TRANSITIONS)
// ---------------------------------------------------------------------------
describe("isValidTransition — regression: new -> trashed", () => {
  it("VALID_TRANSITIONS['new'] includes 'trashed'", () => {
    expect(VALID_TRANSITIONS["new"]).toContain("trashed");
  });

  it("allows new -> trashed", () => {
    expect(isValidTransition("new", "trashed")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// isValidTransition — terminal state exhaustive check
// ---------------------------------------------------------------------------
describe("isValidTransition — terminal states reject ALL outbound", () => {
  const allStates = SessionLifecycleStateSchema.options;

  // trashed is fully terminal — no outbound transitions
  for (const target of allStates) {
    it(`trashed -> ${target} is rejected`, () => {
      expect(isValidTransition("trashed", target)).toBe(false);
    });
  }

  // archived can only go to trashed
  for (const target of allStates) {
    if (target === "trashed") {
      it(`archived -> trashed is allowed`, () => {
        expect(isValidTransition("archived", "trashed")).toBe(true);
      });
    } else {
      it(`archived -> ${target} is rejected`, () => {
        expect(isValidTransition("archived", target)).toBe(false);
      });
    }
  }
});

// ---------------------------------------------------------------------------
// isResumable — chat:idle is NOT resumable
// ---------------------------------------------------------------------------
describe("isResumable", () => {
  it("returns true for work:paused", () => {
    expect(isResumable("work:paused")).toBe(true);
  });

  it("returns true for budget_exhausted", () => {
    expect(isResumable("budget_exhausted")).toBe(true);
  });

  it("returns false for chat:idle (chat is not resumable)", () => {
    expect(isResumable("chat:idle")).toBe(false);
  });

  it("returns false for chat:active", () => {
    expect(isResumable("chat:active")).toBe(false);
  });

  it("returns false for other non-resumable states", () => {
    const nonResumable: SessionLifecycleState[] = [
      "new", "plan:draft", "plan:imported", "plan:approved",
      "plan:needs-fix", "work:active", "work:review",
      "completed", "archived", "trashed",
    ];
    for (const state of nonResumable) {
      expect(isResumable(state)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// Chat lifecycle — skip edges (multi-hop paths)
// ---------------------------------------------------------------------------
describe("isValidTransition — chat lifecycle paths", () => {
  it("new -> chat:active -> chat:idle -> chat:active (idle/active cycle)", () => {
    expect(isValidTransition("new", "chat:active")).toBe(true);
    expect(isValidTransition("chat:active", "chat:idle")).toBe(true);
    expect(isValidTransition("chat:idle", "chat:active")).toBe(true);
  });

  it("chat:active -> completed (finish a chat)", () => {
    expect(isValidTransition("chat:active", "completed")).toBe(true);
  });

  it("chat:idle -> completed (finish an idle chat)", () => {
    expect(isValidTransition("chat:idle", "completed")).toBe(true);
  });
});
