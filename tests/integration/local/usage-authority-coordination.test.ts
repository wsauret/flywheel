import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createUsageAuthority } from "../../../src/infra/llm/usage-authority.js";
import type { UsageEntry } from "../../../src/infra/llm/usage-entry.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

const usage: UsageEntry = {
  attemptId: "00000000-0000-4000-8000-000000000001", occurredAt: "2025-01-01T00:00:00.000Z", profileId: "default",
  currency: "USD", coverage: "complete",
  attribution: { kind: "unattributed" }, spendMode: "direct_api", credentialLineage: "00000000-0000-4000-8000-000000000002",
  model: "model", tokens: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, reasoning: 0 }, classification: "real_spend",
  price: { kind: "unavailable", reason: "catalog_missing" },
};

describe("usage authority coordination", () => {
  test("coordinates globally unique attempts through the canonical ledger", () => {
    const root = mkdtempSync(join(tmpdir(), "usage-authority-coordination-")); roots.push(root);
    const first = createUsageAuthority({ profileDir: root, profileId: "default" });
    const second = createUsageAuthority({ profileDir: root, profileId: "default" });
    expect(first.append(usage)).toEqual({ kind: "appended" });
    expect(second.append(usage)).toEqual({ kind: "duplicate" });
    expect(() => second.append({ ...usage, model: "conflicting-model" })).toThrow("conflicts with its existing ledger entry");
    first.dispose(); second.dispose();
  });

  test("refuses a partial authority when observation acquisition times out", async () => {
    const root = mkdtempSync(join(tmpdir(), "usage-authority-lock-"));
    roots.push(root);
    const seeded = createUsageAuthority({ profileDir: root, profileId: "default" });
    const dbFile = seeded.dbFile;
    seeded.dispose();
    const readyFile = join(root, "blocker.ready");
    // The blocker holds the write lock until this test releases it, rather than for a
    // fixed span. A fixed hold has to outlast process start plus the acquirer's 250ms
    // busy_timeout, and Windows pays enough for spawn and database open to lose that race.
    const releaseFile = join(root, "blocker.release");
    const blocker = Bun.spawn({
      cmd: [process.execPath, "-e", `
        const { Database } = await import("bun:sqlite");
        const db = new Database(process.env.DB_FILE);
        db.exec("pragma busy_timeout = 1000; begin immediate");
        await Bun.write(process.env.READY_FILE, "ready");
        const holdUntil = Date.now() + 30_000;
        while (!(await Bun.file(process.env.RELEASE_FILE).exists()) && Date.now() < holdUntil) await Bun.sleep(5);
        db.exec("commit");
        db.close();
      `],
      env: { ...process.env, DB_FILE: dbFile, READY_FILE: readyFile, RELEASE_FILE: releaseFile },
      stdout: "pipe",
      stderr: "pipe",
      windowsHide: true,
    });
    const deadline = Date.now() + 30_000;
    while (!existsSync(readyFile)) {
      if (Date.now() >= deadline) {
        blocker.kill(9);
        throw new Error("usage authority blocker did not acquire the database");
      }
      await Bun.sleep(5);
    }

    let acquisition: Error | undefined;
    try {
      // Dispose an unexpected success so cleanup is not blocked by a live handle.
      createUsageAuthority({ profileDir: root, profileId: "default" }).dispose();
    } catch (error) {
      acquisition = error instanceof Error ? error : new Error(String(error));
    }
    await Bun.write(releaseFile, "release");
    expect(acquisition).toBeInstanceOf(Error);
    expect(acquisition?.message ?? "").toContain("acquiring the database");
    expect(await blocker.exited).toBe(0);
    expect((await new Response(blocker.stderr).text())).toBe("");

    const reopened = createUsageAuthority({ profileDir: root, profileId: "default" });
    expect(reopened.pendingAlerts({ providerId: "provider", instanceId: "instance", subjectDigest: `v1:${"0".repeat(64)}` }, 1)).toEqual([]);
    reopened.dispose();
  });

  test("derives month bounds from the local calendar without mutating this process timezone", () => {
    const script = `import { localMonthBounds } from "./src/infra/llm/usage-authority-codec.ts"; console.log(JSON.stringify(localMonthBounds(Date.parse("2025-03-01T00:30:00.000Z"))))`;
    const result = Bun.spawnSync({ cmd: [process.execPath, "-e", script], cwd: join(import.meta.dir, "../../.."), env: { ...process.env, TZ: "America/Los_Angeles" }, windowsHide: true });
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout.toString())).toEqual({ startMs: Date.parse("2025-02-01T08:00:00.000Z"), endMs: Date.parse("2025-03-01T08:00:00.000Z"), start: "2025-02-01T08:00:00.000Z", end: "2025-03-01T08:00:00.000Z" });
  });
});
