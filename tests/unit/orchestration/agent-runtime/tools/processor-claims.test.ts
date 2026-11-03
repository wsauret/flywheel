import { describe, expect, it, jest } from "bun:test";
import type { CommandHandover } from "../../../../../src/infra/command-handover.js";
import type { HandoverAnswer } from "../../../../../src/infra/owned-subprocess.js";
import { armUnheldDeadline, createProcessorClaims } from "../../../../../src/orchestration/agent-runtime/tools/processor-claims.js";
import { makeMockOwnedProcess, type OwnedExit } from "./_bash-fixtures.js";

const EXIT: OwnedExit = { code: 0, signal: null, statusOf: "payload", ownership: "surrendered" };
const REQUEST: CommandHandover = { channel: "channel", recordPath: "/scratch/record.json", userDataRoot: "/scratch/account" };

function running(token: string, handOver?: (request: CommandHandover) => Promise<HandoverAnswer>) {
  const exit = Promise.withResolvers<OwnedExit>();
  return { exit, owned: makeMockOwnedProcess({ token, exited: exit.promise, ...(handOver ? { handOver } : {}) }) };
}

describe("processor claims", () => {
  it("claims a container until its owned exit", async () => {
    const claims = createProcessorClaims();
    const { exit, owned } = running("owned:a");
    claims.claim(owned, { order: 5, exempt: false });
    expect(claims.claims()).toEqual([{ token: "owned:a", pid: owned.pid, order: 5, exempt: false }]);
    exit.resolve(EXIT);
    await exit.promise;
    await Bun.sleep(0);
    expect(claims.claims()).toEqual([]);
  });

  it("ends a claim when the next build takes the command, and keeps it when the handover is not acknowledged", async () => {
    const claims = createProcessorClaims();
    let answer: HandoverAnswer = { kind: "unacknowledged" };
    const { owned } = running("owned:a", async () => answer);
    const claimed = claims.claim(owned, { order: 1, exempt: false });
    await claimed.handOver?.(REQUEST);
    expect(claims.claims()).toHaveLength(1);
    answer = { kind: "handed_over" };
    await claimed.handOver?.(REQUEST);
    expect(claims.claims()).toEqual([]);
  });

  it("lists a session's held tool calls oldest first and tells only the sessions whose holds changed", () => {
    let nowMs = 1_000;
    const claims = createProcessorClaims(() => nowMs);
    const told: string[] = [];
    claims.onHoldsChanged((sessionId) => { told.push(sessionId); });
    claims.claim(running("owned:new").owned, { order: 20, exempt: false, sessionId: "s-1", toolUseId: "toolu_new" });
    claims.claim(running("owned:old").owned, { order: 10, exempt: false, sessionId: "s-1", toolUseId: "toolu_old" });
    claims.claim(running("owned:other").owned, { order: 30, exempt: false, sessionId: "s-2", toolUseId: "toolu_other" });

    claims.applyHolds([{ token: "owned:new", ahead: 1 }, { token: "owned:old", ahead: 0 }, { token: "owned:gone", ahead: 4 }]);
    expect(claims.heldToolCallIds("s-1")).toEqual(["toolu_old", "toolu_new"]);
    expect(claims.heldToolCallIds("s-2")).toEqual([]);
    expect(told).toEqual(["s-1"]);

    // A new place in the queue changes no status.
    claims.applyHolds([{ token: "owned:new", ahead: 0 }, { token: "owned:old", ahead: 0 }]);
    expect(told).toEqual(["s-1"]);
    expect(claims.heldTime("owned:new").hold()).toEqual({ ahead: 0 });

    nowMs += 300;
    claims.applyHolds([{ token: "owned:new", ahead: 0 }]);
    expect(told).toEqual(["s-1", "s-1"]);
    expect(claims.heldTime("owned:old").heldMs()).toBe(300);
    expect(claims.heldTime("owned:old").hold()).toBeUndefined();
    expect(claims.heldTime("owned:unknown").heldMs()).toBe(0);
  });

  it("keeps a container's place and hold when a host takes it from the keeper, with the host's exemption", () => {
    let nowMs = 0;
    const claims = createProcessorClaims(() => nowMs);
    const { owned } = running("owned:kept");
    claims.claim(owned, { order: 7, exempt: false, sessionId: "s-1", toolUseId: "toolu_kept" });
    claims.applyHolds([{ token: "owned:kept", ahead: 2 }]);
    nowMs = 50;
    claims.claim(owned, { order: 99, exempt: true, sessionId: "s-1", toolUseId: "toolu_kept" });
    expect(claims.claims()).toEqual([{ token: "owned:kept", pid: owned.pid, order: 7, exempt: true }]);
    expect(claims.heldTime("owned:kept").heldMs()).toBe(50);
    expect(claims.heldToolCallIds("s-1")).toEqual(["toolu_kept"]);
  });
});

describe("a deadline that counts only time not held", () => {
  it("moves later by the hold, at the release of the hold", async () => {
    // The clock is faked, so a stall of a slow runner's event loop cannot use up the deadline that remains after the
    // release.
    jest.useFakeTimers();
    try {
      const claims = createProcessorClaims();
      const { owned } = running("owned:a");
      claims.claim(owned, { order: 1, exempt: false });
      claims.applyHolds([{ token: "owned:a", ahead: 0 }]);
      let expired = false;
      const cancel = armUnheldDeadline(Date.now() + 5, claims.heldTime("owned:a"), () => { expired = true; });
      try {
        jest.advanceTimersByTime(25);
        expect(expired).toBe(false);
        claims.applyHolds([]);
        // The deadline arms again when the release settles.
        await claims.heldTime("owned:a").released();
        // 25 ms were held, so 5 ms of the deadline remain.
        jest.advanceTimersByTime(4);
        expect(expired).toBe(false);
        jest.advanceTimersByTime(1);
        expect(expired).toBe(true);
      } finally {
        cancel();
      }
    } finally {
      jest.useRealTimers();
    }
  });

  it("expires at once when a deadline not held is already past", () => {
    let expired = false;
    armUnheldDeadline(Date.now() - 1, createProcessorClaims().heldTime("owned:none"), () => { expired = true; });
    expect(expired).toBe(true);
  });
});
