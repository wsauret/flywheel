import { describe, expect, test } from "bun:test";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { temporaryDirectories } from "../../helpers/directories.js";
import { canonicalMutationPath, withFileMutationQueue, withMutationQueueKeys } from "../../../src/infra/file-mutation-queue.js";

describe("withFileMutationQueue", () => {
  const temporaryDirectory = temporaryDirectories();

  test("serializes calls on the same path", async () => {
    const testDir = temporaryDirectory("file-mutation-queue-");
    const path = join(testDir, "a.txt");
    writeFileSync(path, "");

    const observed: string[] = [];
    const slow = withFileMutationQueue(path, async () => {
      observed.push("slow-start");
      await Bun.sleep(20);
      observed.push("slow-end");
      return "slow";
    });
    const fast = withFileMutationQueue(path, async () => {
      observed.push("fast-start", "fast-end");
      return "fast";
    });

    const [slowResult, fastResult] = await Promise.all([slow, fast]);
    expect(slowResult).toBe("slow");
    expect(fastResult).toBe("fast");
    // Fast must wait for slow to finish entirely.
    expect(observed).toEqual(["slow-start", "slow-end", "fast-start", "fast-end"]);
  });

  test("does not serialize calls on different paths", async () => {
    const testDir = temporaryDirectory("file-mutation-queue-");
    const a = join(testDir, "a.txt");
    const b = join(testDir, "b.txt");
    writeFileSync(a, "");
    writeFileSync(b, "");

    const observed: string[] = [];
    const onA = withFileMutationQueue(a, async () => {
      observed.push("a-start");
      await Bun.sleep(20);
      observed.push("a-end");
    });
    const onB = withFileMutationQueue(b, async () => {
      observed.push("b-start", "b-end");
    });

    await Promise.all([onA, onB]);
    // b must complete before a finishes (proving they ran in parallel).
    const aEndIdx = observed.indexOf("a-end");
    const bEndIdx = observed.indexOf("b-end");
    expect(bEndIdx).toBeLessThan(aEndIdx);
  });

  test("symlinks pointing at the same realpath serialize correctly", async () => {
    const testDir = temporaryDirectory("file-mutation-queue-");
    const real = join(testDir, "real.txt");
    const link = join(testDir, "link.txt");
    writeFileSync(real, "");
    symlinkSync(real, link);

    const observed: string[] = [];
    const onReal = withFileMutationQueue(real, async () => {
      observed.push("real-start");
      await Bun.sleep(20);
      observed.push("real-end");
    });
    const onLink = withFileMutationQueue(link, async () => {
      observed.push("link-start", "link-end");
    });

    await Promise.all([onReal, onLink]);
    // link must wait for real because they resolve to the same realpath.
    expect(observed).toEqual(["real-start", "real-end", "link-start", "link-end"]);
  });

  test("non-existent paths still serialize (file may be created mid-call)", async () => {
    const testDir = temporaryDirectory("file-mutation-queue-");
    const path = join(testDir, "ghost.txt");
    // Path does not exist yet -- realpath will throw, queue falls back to resolved path.

    const observed: string[] = [];
    const first = withFileMutationQueue(path, async () => {
      observed.push("first-start");
      await Bun.sleep(20);
      writeFileSync(path, "now exists");
      observed.push("first-end");
    });
    const second = withFileMutationQueue(path, async () => {
      observed.push("second-start", "second-end");
    });

    await Promise.all([first, second]);
    expect(observed).toEqual(["first-start", "first-end", "second-start", "second-end"]);
  });

  test("canonicalizes missing destinations through linked parent directories", () => {
    const testDir = temporaryDirectory("file-mutation-queue-");
    const physical = join(testDir, "physical");
    const alias = join(testDir, "alias");
    mkdirSync(physical);
    symlinkSync(physical, alias, process.platform === "win32" ? "junction" : "dir");

    expect(canonicalMutationPath(join(alias, "nested", "new.txt"))).toBe(
      canonicalMutationPath(join(physical, "nested", "new.txt")),
    );
  });

  test("deduplicates and sorts already-canonical queue keys", async () => {
    const order: string[] = [];
    await withMutationQueueKeys(["z", "a", "z"], async () => {
      order.push("inside");
    }, key => {
      order.push(key);
    });
    expect(order).toEqual(["a", "z", "inside"]);
  });

  test("releases the queue when the operation throws", async () => {
    const testDir = temporaryDirectory("file-mutation-queue-");
    const path = join(testDir, "errs.txt");
    writeFileSync(path, "");

    await expect(
      withFileMutationQueue(path, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    // A subsequent call must still run -- prior failure should not deadlock.
    const result = await withFileMutationQueue(path, async () => "ok");
    expect(result).toBe("ok");
  });
});
