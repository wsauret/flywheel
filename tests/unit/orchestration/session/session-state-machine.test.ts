import { describe, it, expect } from "bun:test";
import { safeParse } from "../../../helpers/schema-assertions.js";
import {
  SESSION_LIFECYCLE_STATES,
  SessionLifecycleStateSchema,
  type SessionLifecycleState,
  isValidTransition,
  isResumable,
} from "../../../../src/orchestration/session/types";

describe("SessionLifecycleStateSchema", () => {
  const allStates: readonly SessionLifecycleState[] = SESSION_LIFECYCLE_STATES;

  for (const state of allStates) {
    it(`accepts '${state}'`, () => {
      const result = safeParse(SessionLifecycleStateSchema, state);
      expect(result.success).toBe(true);
    });
  }

  it("rejects unknown and old state strings", () => {
    for (const old of ["running", "paused", "completed", "new", "work:active", "chat:idle", "archived", "trashed"]) {
      const result = safeParse(SessionLifecycleStateSchema, old);
      expect(result.success).toBe(false);
    }
  });

});

describe("isValidTransition", () => {
  const validCases: [SessionLifecycleState, SessionLifecycleState][] = [
    ["active", "inactive"],
    ["inactive", "active"],
  ];

  for (const [from, to] of validCases) {
    it(`allows ${from} -> ${to}`, () => {
      expect(isValidTransition(from, to)).toBe(true);
    });
  }

  const invalidCases: [SessionLifecycleState, SessionLifecycleState][] = [
    ["active", "active"],
    ["inactive", "inactive"],
  ];

  for (const [from, to] of invalidCases) {
    it(`rejects ${from} -> ${to}`, () => {
      expect(isValidTransition(from, to)).toBe(false);
    });
  }
});

describe("isResumable", () => {
  it("returns true for inactive sessions", () => {
    expect(isResumable("inactive")).toBe(true);
  });

  it("returns false for active sessions", () => {
    expect(isResumable("active")).toBe(false);
  });
});
