/**
 * Tests for createHandoffObserver — the watchdog that nudges the model when
 * a turn ends without a handoff write and goes permanently quiet once the
 * handoff lands. It has no queue-lifecycle authority: the injection queue is
 * session-scoped and outlives the worker. Composed inside
 * createWorkflowLoopObservers (workflow runners) and installed directly on
 * subagent runners.
 */

import { describe, expect, test } from "bun:test";

import { createHandoffObserver, handoffNudge } from "../../../../src/workflows/shared/handoff-observer.js";

describe("createHandoffObserver", () => {
  test("the nudge rejects incomplete-work blockers and directs in-step investigation", () => {
    for (const nudge of [handoffNudge(true), handoffNudge(false)]) {
      expect(nudge).toMatch(/remaining milestones/i);
      expect(nudge).toMatch(/another implementation pass/i);
      expect(nudge).toMatch(/one hypothesis at a time/i);
      expect(nudge).toMatch(/focused experiment or proof of concept/i);
      expect(nudge).toMatch(/continue/i);
    }
  });

  // An agent without message_session has no parent that can answer, so the
  // nudge must not send it to a tool it lacks (PI-AGENT-024).
  test("names message_session only when the agent has its parent channel", () => {
    const nudged = (parentChannel: boolean): string[] => {
      const sent: string[] = [];
      createHandoffObserver({ injectionQueue: { enqueue: (text) => { sent.push(text); } }, parentChannel }).onTurnEnded({ handoffWritten: false, turnCount: 1 });
      return sent;
    };

    expect(nudged(true)).toEqual([handoffNudge(true)]);
    expect(handoffNudge(true)).toContain("message your parent with message_session and wait for its reply.");
    expect(nudged(false)).toEqual([handoffNudge(false)]);
    expect(handoffNudge(false)).not.toContain("message_session");
    expect(handoffNudge(false)).toContain("decide on your own judgment, because no parent can answer during this run, and state each assumption in your handoff.");
  });
});
