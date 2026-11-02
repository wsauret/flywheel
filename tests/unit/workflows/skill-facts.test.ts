import { describe, expect, it } from "bun:test";
import {
  parseSkillFact,
  skillCleanupCompletedFact,
} from "../../../src/workflows/skill-facts.js";

const CORE = { version: 1 as const, sha256: "a".repeat(64), bytes: 10 };
const MANIFEST = [{ id: "core", packageIdentity: { sha256: "b".repeat(64), bytes: 10 } }] as const;

describe("skill cleanup facts", () => {
  it("continues to decode retired version 4 claim transitions", () => {
    // The claim family no longer has a producer (the lease lives in the
    // in-flight companion table), but stores written before that change still
    // hold these rows and the transition bridge reads the newest of them.
    const claim = { type: "skill.cleanup.claimed", version: 4, actor: "flywheel", payload: { coreIdentity: CORE, coreManifest: MANIFEST, ownerId: "owner", token: "token", forced: true, claimedAt: 1, expiresAt: 2 } } as const;
    expect(parseSkillFact(claim)).toEqual(claim);
  });

  it("stores the exact sorted core manifest in version 4 completion", () => {
    const fact = skillCleanupCompletedFact({ coreIdentity: CORE, coreManifest: MANIFEST, ownerId: "owner", token: "token", completedAt: 2 });
    expect(parseSkillFact(fact)).toEqual(fact);
    expect(() => parseSkillFact({ ...fact, payload: { ...fact.payload, coreManifest: MANIFEST.toReversed() } })).not.toThrow();
    expect(() => parseSkillFact({ ...fact, payload: { ...fact.payload, extra: true } })).toThrow();
  });

  it("continues to decode historical version 1 cleanup facts without treating them as version 4", () => {
    const historical = { type: "skill.cleanup.completed", version: 1, actor: "flywheel", payload: { corpusIdentity: CORE, ownerId: "owner", token: "token", completedAt: 2 } } as const;
    expect(parseSkillFact(historical)).toEqual(historical);
  });

  it("continues to decode every version 2 cleanup transition", () => {
    const claim = { coreIdentity: CORE, coreManifest: MANIFEST, ownerId: "owner", token: "token", claimedAt: 1, expiresAt: 2 } as const;
    const historical = [
      { type: "skill.cleanup.claimed", version: 2, actor: "flywheel", payload: claim },
      { type: "skill.cleanup.renewed", version: 2, actor: "flywheel", payload: { coreIdentity: CORE, ownerId: "owner", token: "token", renewedAt: 1, expiresAt: 2 } },
      { type: "skill.cleanup.deferred", version: 2, actor: "flywheel", payload: { coreIdentity: CORE, ownerId: "owner", token: "token", deferredAt: 1, cooldownUntil: 2, reason: "later" } },
      { type: "skill.cleanup.completed", version: 2, actor: "flywheel", payload: { coreIdentity: CORE, coreManifest: MANIFEST, ownerId: "owner", token: "token", completedAt: 2 } },
    ] as const;

    expect(historical.map((fact) => parseSkillFact(fact))).toEqual([...historical]);
  });
});
