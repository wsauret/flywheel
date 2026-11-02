import { expect, test } from "bun:test";
import type { TurnParkedContext } from "../../../../src/infra/agent-loop-events.js";
import { createIdleCompaction } from "../../../../src/orchestration/chat/idle-compaction.js";
import { ChatTurnMailbox } from "../../../../src/orchestration/chat/turn-mailbox.js";

const parked: TurnParkedContext = {
  handoffWritten: false, turnCount: 1, activeBackgroundCount: 0, parkedOnBackgroundWork: false,
  waitRequested: false, userResumeRequired: false, park: "idle",
  idleCache: { observedAt: 0, ttlMs: 3_600_000, contextTokens: 200_000 },
};

function fixture() {
  let now = 0;
  let enabled = true;
  let pending: { run(): void; delay: number } | undefined;
  let calls = 0;
  const owner = createIdleCompaction({
    now: () => now, enabled: () => enabled, request: () => { calls++; },
    schedule: (run, delay) => { pending = { run, delay }; return () => { pending = undefined; }; },
  });
  return {
    owner, get pending() { return pending; }, get calls() { return calls; },
    advance(time: number) { now = time; const run = pending?.run; pending = undefined; run?.(); },
    disable() { enabled = false; owner.cancel(); },
  };
}

test.each([3_600_000, 86_400_000])("large idle context checkpoints once at ninety percent of the observed cache window: %d", (ttlMs) => {
  const f = fixture();
  f.owner.park({ ...parked, idleCache: { ...parked.idleCache!, ttlMs } });
  expect(f.pending?.delay).toBe(ttlMs * 0.9);
  f.advance(ttlMs * 0.9);
  expect(f.calls).toBe(1);
  expect(f.pending).toBeUndefined();
});

test.each([
  { park: "interrupted" as const }, { park: "waiting_on_work" as const },
  { waitRequested: true }, { idleCache: undefined },
  { idleCache: { ...parked.idleCache!, contextTokens: 199_999 } },
])("does not wake interrupted, background, small or opaque-cache parks: %j", (override) => {
  const f = fixture();
  f.owner.park({ ...parked, ...override });
  expect(f.pending).toBeUndefined();
});

test("new input and the Settings opt-out cancel a pending idle checkpoint", () => {
  const f = fixture();
  const mailbox = new ChatTurnMailbox(f.owner.cancel);
  f.owner.park(parked);
  mailbox.enqueueNextTurn("new work");
  expect(f.pending).toBeUndefined();
  mailbox.drainPending();
  mailbox.enqueueCompact("idle");
  mailbox.enqueueNextTurn("work before the checkpoint starts");
  expect(mailbox.drainPending()?.kind).toBe("message");
  expect(mailbox.hasPending).toBe(false);
  f.owner.park(parked);
  f.disable();
  expect(f.pending).toBeUndefined();
  f.owner.park(parked);
  expect(f.pending).toBeUndefined();
  expect(f.calls).toBe(0);
});

test("a missed deadline keeps context instead of requesting a checkpoint", () => {
  const f = fixture();
  f.owner.park(parked);
  f.advance(3_600_000);
  expect(f.calls).toBe(0);
  f.owner.park(parked);
  expect(f.pending).toBeUndefined();
});
