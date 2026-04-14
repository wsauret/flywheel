import { describe, it, expect } from "bun:test";
import {
  SessionStateSchema,
  type SessionState,
  VALID_TRANSITIONS,
  isValidTransition,
  isResumable,
} from "../src/orchestration/session/types";

// ---------------------------------------------------------------------------
// SessionStateSchema (z.enum — boundary type)
// ---------------------------------------------------------------------------
describe("SessionStateSchema", () => {
  const allStates: SessionState[] = ["active", "paused", "completed"];

  it("defines exactly 3 states", () => {
    expect(SessionStateSchema.options).toHaveLength(3);
  });

  for (const state of allStates) {
    it(`accepts '${state}'`, () => {
      const result = SessionStateSchema.safeParse(state);
      expect(result.success).toBe(true);
    });
  }

  it("rejects an unknown state string", () => {
    const result = SessionStateSchema.safeParse("running");
    expect(result.success).toBe(false);
  });

  it("rejects old state names", () => {
    for (const old of ["new", "work:active", "work:paused", "chat:active", "chat:idle", "budget_exhausted", "archived", "trashed"]) {
      const result = SessionStateSchema.safeParse(old);
      expect(result.success).toBe(false);
    }
  });

  it("rejects a number", () => {
    const result = SessionStateSchema.safeParse(42);
    expect(result.success).toBe(false);
  });

  it("rejects null", () => {
    const result = SessionStateSchema.safeParse(null);
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
    const states = SessionStateSchema.options;
    for (const state of states) {
      expect(VALID_TRANSITIONS).toHaveProperty(state);
    }
  });

  it("completed is terminal with empty transition array", () => {
    expect(VALID_TRANSITIONS["completed"]).toEqual([]);
  });

  it("active can transition to paused and completed", () => {
    expect(VALID_TRANSITIONS["active"]).toEqual(["paused", "completed"]);
  });

  it("paused can only transition to active", () => {
    expect(VALID_TRANSITIONS["paused"]).toEqual(["active"]);
  });

  it("every target in a transition array is a valid state", () => {
    const states = new Set<string>(SessionStateSchema.options);
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
  const validCases: [SessionState, SessionState][] = [
    ["active", "paused"],
    ["active", "completed"],
    ["paused", "active"],
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
  const invalidCases: [SessionState, SessionState][] = [
    // paused cannot go to completed (must go through active first)
    ["paused", "completed"],
    // completed cannot go anywhere (terminal)
    ["completed", "active"],
    ["completed", "paused"],
    ["completed", "completed"],
    // self-transitions are not valid in the transition table
    // (manager handles them as no-ops before consulting the table)
    ["active", "active"],
    ["paused", "paused"],
  ];

  for (const [from, to] of invalidCases) {
    it(`rejects ${from} -> ${to}`, () => {
      expect(isValidTransition(from, to)).toBe(false);
    });
  }
});

// ---------------------------------------------------------------------------
// isValidTransition — terminal state exhaustive check
// ---------------------------------------------------------------------------
describe("isValidTransition — terminal states reject ALL outbound", () => {
  const allStates = SessionStateSchema.options;

  // completed is fully terminal — no outbound transitions
  for (const target of allStates) {
    it(`completed -> ${target} is rejected`, () => {
      expect(isValidTransition("completed", target)).toBe(false);
    });
  }
});

// ---------------------------------------------------------------------------
// isValidTransition — pause/resume cycle
// ---------------------------------------------------------------------------
describe("isValidTransition — pause/resume cycle", () => {
  it("active -> paused -> active (pause/resume cycle)", () => {
    expect(isValidTransition("active", "paused")).toBe(true);
    expect(isValidTransition("paused", "active")).toBe(true);
  });

  it("active -> completed (finish)", () => {
    expect(isValidTransition("active", "completed")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// isResumable
// ---------------------------------------------------------------------------
describe("isResumable", () => {
  it("returns true for paused", () => {
    expect(isResumable("paused")).toBe(true);
  });

  it("returns false for active", () => {
    expect(isResumable("active")).toBe(false);
  });

  it("returns false for completed", () => {
    expect(isResumable("completed")).toBe(false);
  });
});
