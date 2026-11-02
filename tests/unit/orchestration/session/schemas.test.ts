import { safeParse } from "../../../helpers/schema-assertions.js";
import { resolve } from "node:path";
import { describe, expect, it } from "bun:test";
import { SessionSchema } from "../../../../src/orchestration/session/schemas";
import { toBudgetLimits } from "../../../../src/workflows/budget";

describe("toBudgetLimits", () => {
  it("converts zero budgets to unlimited nullable runtime limits", () => {
    expect(toBudgetLimits({
      max_invocations: 0,
      max_tokens: 0,
      max_wall_clock_minutes: 0,
    })).toEqual({
      max_invocations: 0,
      max_tokens: null,
      max_wall_clock_minutes: null,
    });
  });
});


/** A canonical absolute directory for the running platform. The schema admits
 *  only a path equal to its own resolution, and a POSIX literal is not that on
 *  Windows, where it resolves onto the current drive. */
const CANONICAL_DIR = resolve("/repo/packages/app");

describe("SessionSchema", () => {
  // Every session the producer writes carries name + lifecycleState (manager.create
  // always sets both), so the schema requires them — these bases supply the full
  // required shape and each test layers on only its distinguishing field.
  const chatBase = {
    label: "Chat",
    name: "Chat",
    lifecycleState: "active" as const,
    lastUpdated: "2026-03-20T10:00:00Z",
    executionCwd: CANONICAL_DIR,
    kind: "chat" as const,
    command: "chat" as const,
  };
  

  it("requires lifecycleState and name (no default masks a missing producer write)", () => {
    const complete = { ...chatBase, conversationId: "conv-1" };
    expect(safeParse(SessionSchema, { ...complete, lifecycleState: undefined }).success).toBe(false);
    expect(safeParse(SessionSchema, { ...complete, name: undefined }).success).toBe(false);
  });

  it("requires an executionCwd: the session is the only execution-directory authority", () => {
    const { executionCwd: _omitted, ...withoutExecutionCwd } = chatBase;
    expect(safeParse(SessionSchema, { ...withoutExecutionCwd, conversationId: "conv-1" }).success).toBe(false);
  });

  it("rejects an executionCwd that is not a canonical absolute directory", () => {
    const complete = { ...chatBase, conversationId: "conv-1" };
    for (const executionCwd of ["", "packages/app", "/repo/packages/app/", "/repo/./packages/app", "/repo/packages/../packages/app"]) {
      expect(safeParse(SessionSchema, { ...complete, executionCwd }).success).toBe(false);
    }
    expect(safeParse(SessionSchema, { ...complete, executionCwd: resolve("/") }).success).toBe(true);
  });

  it("rejects a chat session without a conversationId (the tree key is mandatory)", () => {
    expect(safeParse(SessionSchema, { ...chatBase }).success).toBe(false);
  });

});
