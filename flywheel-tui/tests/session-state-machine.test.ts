import { describe, it, expect } from "bun:test";
import {
  SessionLifecycleStateSchema,
  type SessionLifecycleState,
  VALID_TRANSITIONS,
  isValidTransition,
} from "../src/session/state-machine";

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
    "budget_exhausted",
    "completed",
    "archived",
    "trashed",
  ];

  it("defines exactly 12 states", () => {
    expect(SessionLifecycleStateSchema.options).toHaveLength(12);
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

  it("terminal states (archived, trashed) have empty transition arrays", () => {
    expect(VALID_TRANSITIONS["archived"]).toEqual([]);
    expect(VALID_TRANSITIONS["trashed"]).toEqual([]);
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
    ["new", "trashed"],
    // plan:approved cannot go backwards
    ["plan:approved", "plan:draft"],
    ["plan:approved", "new"],
    // terminal states reject all outbound
    ["archived", "new"],
    ["archived", "trashed"],
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
// isValidTransition — terminal state exhaustive check
// ---------------------------------------------------------------------------
describe("isValidTransition — terminal states reject ALL outbound", () => {
  const allStates = SessionLifecycleStateSchema.options;
  const terminalStates: SessionLifecycleState[] = ["archived", "trashed"];

  for (const terminal of terminalStates) {
    for (const target of allStates) {
      it(`${terminal} -> ${target} is rejected`, () => {
        expect(isValidTransition(terminal, target)).toBe(false);
      });
    }
  }
});
