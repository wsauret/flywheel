import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { ContainedDirectory } from "../../../../src/infra/descriptor-directory.js";
import {
  acquireLock,
  acquireLockIn,
  acquireLockSync,
  liveSharedHoldersIn,
  LockRefusal,
  registerSharedHolderIn,
  releaseLock,
  releaseLockIn,
  releaseSharedHolderIn,
  sharedHoldersIn,
  tryAcquireLockSync,
  type LockDirectory,
  type LockOwnership,
} from "../../../../src/infra/ownership-file-lock.js";
import { Log } from "../../../../src/infra/log.js";
import { bootIdentity, processStart } from "../../../../src/infra/process-container.js";
import { createProcessHolders, processHolders } from "../../../../src/infra/process-holder.js";
import { temporaryDirectories } from "../../../helpers/directories.js";

const temporaryDirectory = temporaryDirectories();

/** A pid no host gives to a process. */
const DEAD_PID = 2_147_483_647;

/** Mode 000 hides a file only from a process without root's override. */
const POSIX_STAGING_UNAVAILABLE = process.platform === "win32" || process.getuid?.() === 0;

function makeTmpLockPath(): string {
  return join(temporaryDirectory("auth-lock-test-"), "auth.json.lock");
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** The first-level claim on one observed owner, a name every build shares. */
function ownerClaimPath(lockPath: string, owner: string): string {
  return `${lockPath}.reclaim.${sha256(owner)}`;
}

/** The claim on the claim `claim`, which its claimant `owner` published. */
function claimOnClaimPath(lockPath: string, claim: string, owner: string): string {
  return `${lockPath}.reclaim.${sha256(`${basename(claim)}\0${owner}`)}`;
}

function reclaimEntries(lockPath: string): string[] {
  return readdirSync(dirname(lockPath)).filter((name) => name.includes(".reclaim."));
}

describe("ownership file lock", () => {
  let ownership: LockOwnership | undefined;

  afterEach(() => {
    if (ownership) releaseLock(ownership);
    ownership = undefined;
  });

  test("records and releases its owner", async () => {
    const lockPath = makeTmpLockPath();
    ownership = await acquireLock(lockPath);
    expect(JSON.parse(await Bun.file(lockPath).text())).toEqual({ pid: process.pid, owner: ownership.owner, ...processHolders.own() });
    releaseLock(ownership);
    ownership = undefined;
    expect(existsSync(lockPath)).toBe(false);
  });

  // A record without identity is waited for while its pid runs and is never
  // taken over, so a process whose own identity the kernel does not give
  // loses only the protection against a reused pid, never the lock.
  test("a process that cannot read its own identity takes a free lock with a record naming its pid alone, and names its identity once the read succeeds", async () => {
    const lockPath = makeTmpLockPath();
    let failing = true;
    const holders = createProcessHolders({
      start: (pid) => (pid === process.pid && failing ? { kind: "unproven" } : processStart(pid)),
      boot: () => bootIdentity(),
    });
    const own = spyOn(processHolders, "own").mockImplementation(() => holders.own());
    const warn = spyOn(Log.create({ service: "process-holder" }), "warn").mockImplementation(() => {});
    try {
      const first = await acquireLock(lockPath, 1);
      expect(JSON.parse(await Bun.file(lockPath).text())).toEqual({ pid: process.pid, owner: first.owner });
      releaseLock(first);
      expect(warn).toHaveBeenCalledTimes(1);

      failing = false;
      ownership = await acquireLock(lockPath, 1);
      expect(JSON.parse(await Bun.file(lockPath).text())).toEqual({ pid: process.pid, owner: ownership.owner, ...processHolders.own() });
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      own.mockRestore();
      warn.mockRestore();
    }
  });

  test("does not steal an old lock owned by a live process", async () => {
    const lockPath = makeTmpLockPath();
    writeFileSync(lockPath, JSON.stringify({ pid: process.pid, owner: "live-owner" }));
    await expect(acquireLock(lockPath, 1)).rejects.toThrow("Failed to acquire lock");
    expect(existsSync(lockPath)).toBe(true);
  });

  // acquireLockSync duplicates the retry/liveness ladder for synchronous
  // callers (the config writer); cover it directly, not via the async twin.
  test("sync: does not steal an old lock owned by a live process", () => {
    const lockPath = makeTmpLockPath();
    writeFileSync(lockPath, JSON.stringify({ pid: process.pid, owner: "live-owner" }));
    expect(() => acquireLockSync(lockPath, 1)).toThrow("Failed to acquire lock");
    expect(existsSync(lockPath)).toBe(true);
  });

  test("sync: steals a lock only after proving its owner is dead", () => {
    const lockPath = makeTmpLockPath();
    writeFileSync(lockPath, JSON.stringify({ pid: DEAD_PID, owner: "dead-owner" }));
    ownership = acquireLockSync(lockPath, 1);
    expect(ownership.owner).not.toBe("dead-owner");
  });

  test("steals a lock only after proving its owner is dead", async () => {
    const lockPath = makeTmpLockPath();
    writeFileSync(lockPath, JSON.stringify({ pid: DEAD_PID, owner: "dead-owner" }));
    ownership = await acquireLock(lockPath);
    expect(ownership.owner).not.toBe("dead-owner");
  });

  // A kernel gives a freed pid to the next process, so a record whose pid
  // runs a process with another start stamp names a holder that is gone.
  test("reclaims a lock whose pid now runs another process", async () => {
    const lockPath = makeTmpLockPath();
    const { boot } = processHolders.own() ?? expect.unreachable("the kernel did not give this test process its identity");
    writeFileSync(lockPath, JSON.stringify({ pid: process.pid, owner: "recycled", v: 1, start: "1", ...(boot === undefined ? {} : { boot }) }));
    ownership = await acquireLock(lockPath, 1);
    expect(ownership.owner).not.toBe("recycled");
  });

  // Windows records no boot, because its creation time is absolute.
  test.skipIf(process.platform === "win32")("reclaims a lock that an earlier boot's process recorded", async () => {
    const lockPath = makeTmpLockPath();
    writeFileSync(lockPath, JSON.stringify({ pid: process.pid, owner: "earlier-boot", ...processHolders.own(), boot: "0".repeat(32) }));
    ownership = await acquireLock(lockPath, 1);
    expect(ownership.owner).not.toBe("earlier-boot");
  });

  test("keeps a record whose identity version this build cannot read, and names the version", async () => {
    const lockPath = makeTmpLockPath();
    const future = JSON.stringify({ pid: DEAD_PID, owner: "future", v: 99 });
    writeFileSync(lockPath, future);
    const refusal = acquireLock(lockPath, 1);
    await expect(refusal).rejects.toBeInstanceOf(LockRefusal);
    await expect(refusal).rejects.toThrow("version 99");
    expect(await Bun.file(lockPath).text()).toBe(future);
  });

  test("does not release a lock owned by another acquisition", async () => {
    const lockPath = makeTmpLockPath();
    ownership = await acquireLock(lockPath);
    releaseLock({ path: lockPath, owner: "other-owner" });
    expect(existsSync(lockPath)).toBe(true);
  });

  test("does not remove a replacement while reclaim for the observed owner is held", async () => {
    const lockPath = makeTmpLockPath();
    const deadOwner = "dead-owner";
    writeFileSync(lockPath, JSON.stringify({ pid: DEAD_PID, owner: deadOwner }));
    const identity = createHash("sha256").update(deadOwner).digest("hex");
    const claimPath = `${lockPath}.reclaim.${identity}`;
    writeFileSync(claimPath, "");

    const contender = acquireLock(lockPath, 1);
    unlinkSync(lockPath);
    writeFileSync(lockPath, JSON.stringify({ pid: process.pid, owner: "replacement" }));
    unlinkSync(claimPath);

    await expect(contender).rejects.toThrow("Failed to acquire lock");
    expect(JSON.parse(await Bun.file(lockPath).text())).toEqual({ pid: process.pid, owner: "replacement" });
  });

  test("reclaims a dead owner's lock behind a claim that a dead claimant left", async () => {
    const lockPath = makeTmpLockPath();
    writeFileSync(lockPath, JSON.stringify({ pid: DEAD_PID, owner: "dead-owner" }));
    writeFileSync(ownerClaimPath(lockPath, "dead-owner"), JSON.stringify({ pid: DEAD_PID, owner: "dead-claimant", ...processHolders.own() }));
    ownership = await acquireLock(lockPath, 1);
    expect(ownership.owner).not.toBe("dead-owner");
    expect(reclaimEntries(lockPath)).toEqual([]);
  });

  // Each claim on a claim is itself a claim, so a chain of leaked claims is
  // removed from its far end, and the chain a reclaim may build is bounded.
  test("removes a chain of two leaked claims, and waits on a chain of three", async () => {
    const lockPath = makeTmpLockPath();
    writeFileSync(lockPath, JSON.stringify({ pid: DEAD_PID, owner: "dead-owner" }));
    const first = ownerClaimPath(lockPath, "dead-owner");
    const second = claimOnClaimPath(lockPath, first, "first-claimant");
    const third = claimOnClaimPath(lockPath, second, "second-claimant");
    const leak = (path: string, owner: string): void => writeFileSync(path, JSON.stringify({ pid: DEAD_PID, owner }));
    leak(first, "first-claimant");
    leak(second, "second-claimant");
    leak(third, "third-claimant");
    await expect(acquireLock(lockPath, 1)).rejects.toThrow(basename(third));

    unlinkSync(third);
    ownership = await acquireLock(lockPath, 1);
    expect(reclaimEntries(lockPath)).toEqual([]);
  });

  // An earlier release created its claim empty and wrote nothing into it, so
  // a claim it leaked names no claimant to prove gone. Its age is the proof.
  // Remove after 2026-12-25, with the empty-claim rule.
  test("removes an earlier release's empty claim once it is ten minutes old", async () => {
    const lockPath = makeTmpLockPath();
    writeFileSync(lockPath, JSON.stringify({ pid: DEAD_PID, owner: "dead-owner" }));
    const claim = ownerClaimPath(lockPath, "dead-owner");
    writeFileSync(claim, "");
    const elevenMinutesAgo = new Date(Date.now() - 11 * 60_000);
    utimesSync(claim, elevenMinutesAgo, elevenMinutesAgo);
    ownership = await acquireLock(lockPath, 1);
    expect(reclaimEntries(lockPath)).toEqual([]);
  });

  test("waits on an earlier release's empty claim that is younger than ten minutes, and names it", async () => {
    const lockPath = makeTmpLockPath();
    writeFileSync(lockPath, JSON.stringify({ pid: DEAD_PID, owner: "dead-owner" }));
    const claim = ownerClaimPath(lockPath, "dead-owner");
    writeFileSync(claim, "");
    const refusal = acquireLock(lockPath, 1);
    await expect(refusal).rejects.toThrow(basename(claim));
    await expect(refusal).rejects.toThrow("earlier release");
    expect(existsSync(claim)).toBe(true);
  });

  test("a release clears a claim that a dead claimant left on its own owner", async () => {
    const lockPath = makeTmpLockPath();
    const held = await acquireLock(lockPath);
    writeFileSync(ownerClaimPath(lockPath, held.owner), JSON.stringify({ pid: DEAD_PID, owner: "dead-claimant" }));
    releaseLock(held);
    expect(existsSync(lockPath)).toBe(false);
    expect(reclaimEntries(lockPath)).toEqual([]);
  });

  test("a single attempt reclaims a live owner that the caller proves gone, asks again under the claim, and names the holder it removed", () => {
    const lockPath = makeTmpLockPath();
    const stranger = JSON.stringify({ pid: process.pid, owner: "stranger" });
    writeFileSync(lockPath, stranger);
    const answers = [true, false];
    // An attempt that does not take the lock says why.
    expect(tryAcquireLockSync(lockPath, { ownerProvenGone: () => answers.shift() ?? false })).toEqual({ kind: "blocked", reason: `pid ${process.pid} holds it and is running` });
    expect(readdirSync(dirname(lockPath))).toEqual([basename(lockPath)]);

    const tried = tryAcquireLockSync(lockPath, { ownerProvenGone: (pid) => pid === process.pid });
    if (tried.kind !== "acquired") throw new Error(`the lock was not taken: ${tried.reason}`);
    ownership = tried;
    expect(JSON.parse(readFileSync(lockPath, "utf-8")).owner).toBe(tried.owner);
    expect(tried.reclaimed).toEqual({ kind: "holder", pid: process.pid, proof: "caller-proven" });
  });

  // Every build publishes a lock whole, so an empty lock or one whose bytes
  // are not a record is damage that names no holder. Only a caller that
  // proves no holder runs may remove it.
  test("a lock that names no holder is kept, unless the caller proves that no holder runs", () => {
    for (const [bytes, entry] of [["", "empty"], ["{ not a record", "malformed"]] as const) {
      const lockPath = makeTmpLockPath();
      writeFileSync(lockPath, bytes);
      expect(tryAcquireLockSync(lockPath)).toMatchObject({ kind: "blocked" });
      expect(tryAcquireLockSync(lockPath, { noHolderRuns: false })).toMatchObject({ kind: "blocked" });
      expect(readFileSync(lockPath, "utf-8")).toBe(bytes);

      const tried = tryAcquireLockSync(lockPath, { noHolderRuns: true });
      if (tried.kind !== "acquired") throw new Error(`the lock was not taken: ${tried.reason}`);
      expect(tried.reclaimed).toEqual({ kind: "nameless", entry });
      expect(JSON.parse(readFileSync(lockPath, "utf-8")).owner).toBe(tried.owner);
      expect(reclaimEntries(lockPath)).toEqual([]);
      releaseLock(tried);
    }
  });

  // A proof is reported only for the record it removed: a holder that
  // released the lock between the observation and the claim was not reclaimed.
  test("a single attempt that finds the lock free under its claim names no reclaimed holder", () => {
    const lockPath = makeTmpLockPath();
    writeFileSync(lockPath, JSON.stringify({ pid: process.pid, owner: "releasing" }));
    const tried = tryAcquireLockSync(lockPath, {
      ownerProvenGone: () => {
        unlinkSync(lockPath);
        return true;
      },
    });
    if (tried.kind !== "acquired") throw new Error(`the lock was not taken: ${tried.reason}`);
    ownership = tried;
    expect(tried.reclaimed).toBeUndefined();
  });

  test("publishes every record through a link of a complete owner file", async () => {
    const dir = temporaryDirectory("auth-lock-spy-");
    writeFileSync(join(dir, "auth.json.lock"), JSON.stringify({ pid: DEAD_PID, owner: "dead-owner" }));
    const contained = ContainedDirectory.open(dir, []);
    const created: string[] = [];
    const linked: Array<{ readonly name: string; readonly record: unknown }> = [];
    const spy: LockDirectory = {
      readFile: (name, maxBytes) => contained.readFile(name, maxBytes),
      createExclusive: (name, content) => {
        created.push(name);
        return contained.createExclusive(name, content);
      },
      linkFile: (existing, name) => {
        linked.push({ name, record: JSON.parse(contained.readFile(existing, 4096)?.toString("utf-8") ?? "null") });
        return contained.linkFile(existing, name);
      },
      removeFile: (name) => contained.removeFile(name),
      entryNames: () => contained.entryNames(),
      regularFileModifiedAt: (name) => contained.regularFileModifiedAt(name),
    };
    try {
      const hold = await acquireLockIn(spy, "auth.json.lock", 1);
      const shared = registerSharedHolderIn(spy, "auth.json.lock");
      releaseSharedHolderIn(spy, shared);
      releaseLockIn(spy, hold);
    } finally {
      contained.close();
    }
    expect(created.filter((name) => !name.includes(".owner."))).toEqual([]);
    expect(linked.filter(({ name }) => name.includes(".reclaim.")).length).toBe(2);
    expect(linked.filter(({ name }) => name.includes(".shared.")).length).toBe(1);
    for (const { record } of linked) expect(record).toEqual({ pid: process.pid, owner: expect.any(String), ...processHolders.own() });
    expect(readdirSync(dir)).toEqual([]);
  });

  test("publishes only complete canonical records and removes owner artifacts", async () => {
    const lockPath = makeTmpLockPath();
    ownership = await acquireLock(lockPath);
    expect(JSON.parse(await Bun.file(lockPath).text())).toEqual({ pid: process.pid, owner: ownership.owner, ...processHolders.own() });
    expect(readdirSync(dirname(lockPath)).filter((name) => name.includes(".owner."))).toEqual([]);
  });

  test("serializes concurrent reclaimers", async () => {
    const lockPath = makeTmpLockPath();
    writeFileSync(lockPath, JSON.stringify({ pid: DEAD_PID, owner: "dead-owner" }));
    const first = acquireLock(lockPath);
    const second = acquireLock(lockPath);
    const firstOwnership = await first;
    releaseLock(firstOwnership);
    ownership = await second;
    expect(ownership.owner).not.toBe(firstOwnership.owner);
  });

  // A foreign occupant (a directory, an oversized file) can never become a
  // lock record, so acquisition refuses it immediately instead of walking the
  // full backoff ladder. The elapsed-time bound is what proves the fail-fast:
  // the production ladder is ~2s even at its floor.
  test("refuses a directory at the lock name without walking the backoff ladder", async () => {
    const lockPath = makeTmpLockPath();
    mkdirSync(lockPath);
    const start = performance.now();
    await expect(acquireLock(lockPath)).rejects.toThrow("foreign object");
    expect(performance.now() - start).toBeLessThan(500);
  });

  test("sync: refuses a directory at the lock name without walking the backoff ladder", () => {
    const lockPath = makeTmpLockPath();
    mkdirSync(lockPath);
    const start = performance.now();
    expect(() => acquireLockSync(lockPath)).toThrow("foreign object");
    expect(performance.now() - start).toBeLessThan(500);
  });

  test("refuses an oversized file at the lock name as foreign", async () => {
    const lockPath = makeTmpLockPath();
    writeFileSync(lockPath, `{"padding":"${"x".repeat(5000)}"}`);
    const refusal = acquireLock(lockPath);
    await expect(refusal).rejects.toBeInstanceOf(LockRefusal);
    await expect(refusal).rejects.toThrow("foreign object");
  });

  // A path is resolved the way a contained directory resolves an entry: a
  // link at the lock's name is never followed to the record it points at.
  test.skipIf(process.platform === "win32")("refuses a link at the lock name as foreign and never follows it", async () => {
    const lockPath = makeTmpLockPath();
    const target = join(dirname(lockPath), "elsewhere.json");
    writeFileSync(target, JSON.stringify({ pid: DEAD_PID, owner: "dead-owner" }));
    symlinkSync(target, lockPath);
    const refusal = acquireLock(lockPath, 1);
    await expect(refusal).rejects.toBeInstanceOf(LockRefusal);
    await expect(refusal).rejects.toThrow("foreign object");
    expect(lstatSync(lockPath).isSymbolicLink()).toBe(true);
    expect(existsSync(target)).toBe(true);
  });

  // A read that fails is a question the file system did not answer, not a
  // foreign object: the holder may be live and release the name.
  test.skipIf(POSIX_STAGING_UNAVAILABLE)("waits on a lock it cannot read, and names the read error", async () => {
    const lockPath = makeTmpLockPath();
    writeFileSync(lockPath, JSON.stringify({ pid: process.pid, owner: "hidden" }));
    chmodSync(lockPath, 0);
    await expect(acquireLock(lockPath, 1)).rejects.toThrow("could not be read: EACCES");
    expect(existsSync(lockPath)).toBe(true);
  });

  // Malformed bytes in a regular file are indistinguishable from a record this
  // process may simply not reclaim, so they stay on the conservative ladder.
  test("a malformed regular file is retried, not refused as foreign", async () => {
    const lockPath = makeTmpLockPath();
    writeFileSync(lockPath, "not json");
    await expect(acquireLock(lockPath, 1)).rejects.toThrow("Failed to acquire lock");
  });

  // Valid churn between observations must never read as foreign: an occupant
  // released mid-acquisition is contention, and the next attempt wins the name.
  test("acquires after a held lock is released mid-ladder", async () => {
    const lockPath = makeTmpLockPath();
    writeFileSync(lockPath, JSON.stringify({ pid: process.pid, owner: "live-owner" }));
    const contender = acquireLock(lockPath, 1);
    await Bun.sleep(5);
    unlinkSync(lockPath);
    ownership = await contender;
    expect(ownership.owner).not.toBe("live-owner");
  });
});

describe("shared holders", () => {
  function withGateDirectory<T>(use: (directory: ContainedDirectory, path: string) => T): T {
    const path = temporaryDirectory("shared-holder-test-");
    const directory = ContainedDirectory.open(path, []);
    try {
      return use(directory, path);
    } finally {
      directory.close();
    }
  }

  test.skipIf(POSIX_STAGING_UNAVAILABLE)("counts and keeps a holder it cannot read", () => {
    withGateDirectory((directory, path) => {
      const holder = join(path, `gate.lock.shared.${randomUUID()}`);
      writeFileSync(holder, JSON.stringify({ pid: DEAD_PID, owner: "hidden" }));
      chmodSync(holder, 0);
      expect(liveSharedHoldersIn(directory, "gate.lock")).toBe(1);
      expect(existsSync(holder)).toBe(true);
    });
  });

  // An earlier build removes every entry under `<gate>.shared.` that it cannot
  // read as a record, and a staging owner file is empty for a moment after it
  // is created. A registration therefore stages its record outside that
  // prefix, so no build's sweep can take the file out from under its link.
  test("stages a holder's record outside the names any build sweeps", () => {
    withGateDirectory((directory) => {
      const created: string[] = [];
      const spy: LockDirectory = {
        readFile: (name, maxBytes) => directory.readFile(name, maxBytes),
        createExclusive: (name, content) => {
          created.push(name);
          return directory.createExclusive(name, content);
        },
        linkFile: (existing, name) => directory.linkFile(existing, name),
        removeFile: (name) => directory.removeFile(name),
        entryNames: () => directory.entryNames(),
        regularFileModifiedAt: (name) => directory.regularFileModifiedAt(name),
      };
      const hold = registerSharedHolderIn(spy, "gate.lock");
      expect(created.length).toBe(1);
      expect(created.filter((name) => name.startsWith("gate.lock.shared."))).toEqual([]);
      expect(sharedHoldersIn(directory, "gate.lock")).toEqual({ pids: [process.pid], unreadable: 0 });
      releaseSharedHolderIn(directory, hold);
    });
  });
});
