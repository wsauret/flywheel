import { describe, expect, test } from "bun:test";
import type { PreparedPackage } from "../../../../../src/orchestration/agent-runtime/review-types.js";
import { decodeSkillCorpusCleanupResponse } from "../../../../../src/orchestration/modules/learning/skill-corpus-cleanup-classifier.js";
import { classifySkillCorpusCleanupWork } from "../../../../../src/orchestration/modules/learning/skill-corpus-cleanup-work.js";

function work(id: string) {
  const identity = { sha256: id.padEnd(64, "0"), bytes: id.length };
  const pkg: PreparedPackage = { identity, files: [] };
  return {
    requestIdentity: identity,
    coreIdentity: { version: 1 as const, ...identity },
    corePackageId: `core-${id}`,
    corePackageIdentity: identity,
    candidateShardIdentity: identity,
    corePackage: { id: `core-${id}`, files: [] },
    candidates: [{ id: `candidate-${id}`, identity, package: pkg }],
  };
}

describe("classifySkillCorpusCleanupWork", () => {
  test("returns each output in request order", async () => {
    const result = await classifySkillCorpusCleanupWork([work("a"), work("b"), work("c")], async (request) => request.corePackageId);

    expect(result).toEqual(["core-a", "core-b", "core-c"]);
  });

  test("limits concurrent child requests", async () => {
    let active = 0;
    let maximum = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const running = classifySkillCorpusCleanupWork([work("a"), work("b"), work("c"), work("d")], async () => {
      active += 1;
      maximum = Math.max(maximum, active);
      await gate;
      active -= 1;
      return "done";
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(maximum).toBe(2);
    release();
    expect(await running).toEqual(["done", "done", "done", "done"]);
  });

  test("does not dequeue new work after a sibling rejects and rejects only after active work settles", async () => {
    let releaseSibling!: () => void;
    const sibling = new Promise<void>((resolve) => { releaseSibling = resolve; });
    const started: string[] = [];
    let siblingSettled = false;
    const running = classifySkillCorpusCleanupWork([work("a"), work("b"), work("c"), work("d")], async (request) => {
      started.push(request.corePackageId);
      if (request.corePackageId === "core-a") throw new Error("rejected");
      await sibling;
      siblingSettled = true;
      return "done";
    });
    let rejected = false;
    const observed = running.catch((error: unknown) => {
      rejected = true;
      expect(siblingSettled).toBe(true);
      throw error;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(started).toEqual(["core-a", "core-b"]);
    expect(rejected).toBe(false);
    releaseSibling();
    await expect(observed).rejects.toThrow("rejected");
    expect(started).toEqual(["core-a", "core-b"]);
  });

  test.each([undefined, "not-json"])("does not start queued work after strict decoding rejects %p", async (output) => {
    const started: string[] = [];
    const running = classifySkillCorpusCleanupWork([work("a"), work("b"), work("c")], async (request) => {
      started.push(request.corePackageId);
      if (!decodeSkillCorpusCleanupResponse(request, output)) throw new Error("invalid cleanup output");
      return output;
    });

    await expect(running).rejects.toThrow("invalid cleanup output");
    expect(started).toEqual(["core-a", "core-b"]);
  });
});
