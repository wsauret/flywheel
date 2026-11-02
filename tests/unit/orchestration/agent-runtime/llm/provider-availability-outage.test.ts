/** The provider outage (service-row) coordination between processes: what one
 *  process's outage record means to another, how the fleet's one recheck is
 *  arbitrated, and how a sole source publishes an unfenced recovery. The
 *  quota-window coordination lives in
 *  `provider-availability-authority.test.ts`. */

import { describe, expect, test } from "bun:test";
import {
  type AvailabilityAuthority,
  AvailabilityCorruptError,
  type AvailabilityKey,
} from "../../../../../src/infra/llm/availability-store.js";
import { harness, NOW_MS, OUTAGE_HOLD_MS, OUTAGE_MEMORY_MS, SAFE_RECHECK_MS, availabilityFixtures, subscription } from "./_provider-availability-harness.js";

const { tempDbFile, createAuthority: createAvailabilityAuthority } = availabilityFixtures();

describe("provider outage coordination on the service row", () => {
  const ACCOUNT = subscription("openai_api", "account-one");
  const SERVICE_KEY: AvailabilityKey = { scope: "provider", provider: "openai_api", window: "service" };

  test("an outage one process records suppresses the provider for another, without touching quota", () => {
    const dbFile = tempDbFile();
    const first = harness([], createAvailabilityAuthority({ dbFile }), [ACCOUNT]);
    first.availability.markUnreachable("openai_api");

    const second = harness([], createAvailabilityAuthority({ dbFile }), [ACCOUNT]);
    second.availability.refreshProjection();

    expect(second.availability.serviceStanding("openai_api")).toEqual({
      kind: "suppressed",
      exhaustion: { exhaustedAtMs: NOW_MS, resetsAtMs: NOW_MS + OUTAGE_HOLD_MS },
    });
    // The outage is the service's fact alone: the account's quota rows state
    // nothing, so the moment the provider answers again nothing holds it.
    expect(second.availability.genericQuotaStanding(ACCOUNT)).toEqual({ kind: "live" });
  });

  test("after the bound one process wins the recheck, the other holds back, and the fenced live commit returns the fleet", async () => {
    const dbFile = tempDbFile();
    const first = harness([], createAvailabilityAuthority({ dbFile }), [ACCOUNT]);
    first.availability.markUnreachable("openai_api");
    first.advance(SAFE_RECHECK_MS + 1);
    const second = harness([], createAvailabilityAuthority({ dbFile }), [ACCOUNT]);
    second.advance(SAFE_RECHECK_MS + 1);
    second.availability.refreshProjection();

    expect(first.availability.serviceStanding("openai_api")).toEqual({ kind: "probe_due" });
    const probe = first.availability.claimServiceProbe("openai_api");
    expect(probe).toMatchObject({ window: "service" });
    if (probe === undefined) throw new Error("expected the claim to win");

    second.availability.refreshProjection();
    expect(second.availability.claimServiceProbe("openai_api")).toBeUndefined();
    const pending = second.availability.serviceStanding("openai_api");
    if (pending.kind !== "recheck_pending") throw new Error("expected pending recheck");

    first.availability.markReachable("openai_api");
    await second.availability.waitForChange(pending, new AbortController().signal);
    expect(second.availability.serviceStanding("openai_api")).toEqual({ kind: "live" });
  });

  test("a sole source that served through its suppression publishes the recovery unfenced", () => {
    const dbFile = tempDbFile();
    const first = harness([], createAvailabilityAuthority({ dbFile }), [ACCOUNT]);
    first.availability.markUnreachable("openai_api");

    first.availability.markReachable("openai_api");

    const second = harness([], createAvailabilityAuthority({ dbFile }), [ACCOUNT]);
    second.availability.refreshProjection();
    expect(second.availability.serviceStanding("openai_api")).toEqual({ kind: "live" });
    expect(createAvailabilityAuthority({ dbFile }).snapshotFor([SERVICE_KEY]).rows[0])
      .toMatchObject({ state: "live", source: "provider-recovered" });
  });

  test("an outage record the authority refuses never blocks the fallback: markUnreachable keeps the fact in memory", () => {
    const failing = new AvailabilityCorruptError({ message: "corrupt", at: "test", reason: "corrupt" });
    const dbFile = tempDbFile();
    const authority = createAvailabilityAuthority({ dbFile });
    const broken: AvailabilityAuthority = {
      ...authority,
      commit: () => { throw failing },
    };
    const { availability } = harness([], broken, [ACCOUNT]);

    expect(() => availability.markUnreachable("openai_api")).not.toThrow();
    // This process still routes around the outage on its own word.
    expect(availability.serviceStanding("openai_api").kind).toBe("suppressed");
  });

  test("an outage hold starts short and lengthens only while the outage persists", () => {
    const dbFile = tempDbFile();
    const { availability, advance } = harness([], createAvailabilityAuthority({ dbFile }), [ACCOUNT]);
    const resetsAt = (): number | undefined => {
      const standing = availability.serviceStanding("openai_api");
      return standing.kind === "suppressed" ? standing.exhaustion.resetsAtMs : undefined;
    };

    // One spent candidate is one mark, and a first mark costs the fleet a minute.
    availability.markUnreachable("openai_api");
    expect(resetsAt()).toBe(NOW_MS + OUTAGE_HOLD_MS);

    // A second mark inside the hold, from a session that spent its own
    // retries at the same time, restates the outage without lengthening it.
    advance(10_000);
    availability.markUnreachable("openai_api");
    expect(resetsAt()).toBe(NOW_MS + 10_000 + OUTAGE_HOLD_MS);

    // Each failed recheck doubles the hold, up to the safe recheck bound.
    advance(OUTAGE_HOLD_MS + 1);
    availability.markUnreachable("openai_api");
    expect(resetsAt()).toBe(NOW_MS + 10_000 + OUTAGE_HOLD_MS + 1 + 2 * OUTAGE_HOLD_MS);
    advance(2 * OUTAGE_HOLD_MS + 1);
    availability.markUnreachable("openai_api");
    expect(resetsAt()).toBe(NOW_MS + 10_000 + 3 * OUTAGE_HOLD_MS + 2 + 4 * OUTAGE_HOLD_MS);
    advance(4 * OUTAGE_HOLD_MS + 1);
    availability.markUnreachable("openai_api");
    expect(resetsAt()).toBe(NOW_MS + 10_000 + 7 * OUTAGE_HOLD_MS + 3 + SAFE_RECHECK_MS);

    // A recovery ends the escalation: the next outage starts short again.
    availability.markReachable("openai_api");
    expect(availability.serviceStanding("openai_api")).toEqual({ kind: "live" });
    advance(1_000);
    availability.markUnreachable("openai_api");
    expect(resetsAt()).toBe(NOW_MS + 11_000 + 7 * OUTAGE_HOLD_MS + 3 + OUTAGE_HOLD_MS);
  });

  test("an outage remembered long after its hold expired starts short again", () => {
    const { availability, advance } = harness([], createAvailabilityAuthority({ dbFile: tempDbFile() }), [ACCOUNT]);
    availability.markUnreachable("openai_api");
    advance(OUTAGE_HOLD_MS + OUTAGE_MEMORY_MS + 1);
    availability.markUnreachable("openai_api");
    const standing = availability.serviceStanding("openai_api");
    expect(standing.kind === "suppressed" ? standing.exhaustion.resetsAtMs : undefined).toBe(NOW_MS + 2 * OUTAGE_HOLD_MS + OUTAGE_MEMORY_MS + 1);
  });
});
