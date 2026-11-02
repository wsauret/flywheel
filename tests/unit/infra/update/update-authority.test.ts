/**
 * The account-global update authority, exercised in one process: check
 * freshness, the fenced lease, the activation commit, contained storage, and
 * fail-closed refusal. The cross-process fence lives in
 * `tests/integration/infra/update/update-authority.test.ts`.
 *
 * The containment tests plant the links a hostile account home would hold: at
 * the account data root before its first use, at the `update` directory, and
 * at the database and its sidecars. Each one names a decoy directory, and a
 * decoy that stays empty is the proof that the link was refused rather than
 * followed.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";
import { updateAuthorityDbFile } from "../../../../src/infra/paths.js";
import { UPDATE_PROTOCOL_VERSION, createUpdateAuthority } from "../../../../src/infra/update/update-authority.js";
import { HOUR_MS, MINUTE_MS, claimAt, createUpdateAuthorityHarness, thrownBy, winFence } from "../../../helpers/update-authority-harness.js";
import { storedAuthorityState } from "../../../helpers/update-authority-state.js";
import { POSIX_FILE_MODES } from "../../../helpers/posix-modes.js";

const harness = createUpdateAuthorityHarness();
const { accountRootPath, newUserDataRoot, newDecoy, newDbFile, authorityFor } = harness;
afterAll(() => harness.dispose());

/** Writes past the CHECK constraints, as only a broken writer could. */
function force(dbFile: string, columns: string): void {
  const raw = new Database(dbFile);
  raw.exec("PRAGMA ignore_check_constraints = ON");
  raw.query(`update update_authority set ${columns} where id = 0`).run();
  raw.close();
}

describe("check freshness", () => {
  test("a check inside the freshness window suppresses every later claimant", () => {
    const authority = authorityFor(newDbFile());
    const fence = winFence(authority, 1_000);
    expect(authority.commitCheck({ fence, checkedAtMs: 1_000 })).toBe(true);

    expect(claimAt(authority, 1_000 + HOUR_MS - 1)).toEqual({ kind: "fresh", checkedAtMs: 1_000 });
    expect(claimAt(authority, 1_000 + HOUR_MS).kind).toBe("won");
  });

  test("an authority that has never recorded a check is not fresh", () => {
    expect(claimAt(authorityFor(newDbFile()), 1_000, { freshForMs: Number.MAX_SAFE_INTEGER }).kind).toBe("won");
  });

  test("a check stamped in the future is stale, not fresh forever", () => {
    const dbFile = newDbFile();
    const authority = authorityFor(dbFile);
    const fence = winFence(authority, 10 * HOUR_MS);
    authority.commitCheck({ fence, checkedAtMs: 10 * HOUR_MS });

    expect(claimAt(authority, HOUR_MS).kind).toBe("won");
  });
});

describe("fenced lease", () => {
  test("one claimant wins and every other claimant is told who holds it", () => {
    const dbFile = newDbFile();
    const winner = authorityFor(dbFile);
    const loser = authorityFor(dbFile);

    expect(claimAt(winner, 1_000)).toEqual({ kind: "won", fence: 1, leaseExpiresAtMs: 1_000 + MINUTE_MS });
    expect(claimAt(loser, 2_000)).toEqual({ kind: "busy", leaseExpiresAtMs: 1_000 + MINUTE_MS });
  });

  test("a renewal holds the lease while the work makes progress", () => {
    const dbFile = newDbFile();
    const winner = authorityFor(dbFile);
    const other = authorityFor(dbFile);
    const fence = winFence(winner, 1_000);

    expect(winner.renew({ fence, nowMs: 1_000 + MINUTE_MS, leaseMs: MINUTE_MS })).toBe("held");
    expect(claimAt(other, 1_000 + MINUTE_MS + 1)).toEqual({ kind: "busy", leaseExpiresAtMs: 1_000 + 2 * MINUTE_MS });
  });

  test("an activation another handle committed under the fence concludes the lease rather than superseding it", () => {
    const dbFile = newDbFile();
    const coordinator = authorityFor(dbFile);
    const installer = authorityFor(dbFile);
    const fence = winFence(coordinator, 1_000);

    expect(installer.commitActivation({ fence, checkedAtMs: 2_000, activate: () => {} })).toBe(true);
    // The work the lease was won for is done under this fence, and nobody took
    // it over, so the coordinator has nothing to renew and nothing to abandon.
    expect(coordinator.renew({ fence, nowMs: 2_100, leaseMs: MINUTE_MS })).toBe("concluded");
  });

  test("a lease nobody renews expires and the next claimant advances the fence", () => {
    const dbFile = newDbFile();
    const crashed = authorityFor(dbFile);
    const next = authorityFor(dbFile);
    expect(winFence(crashed, 1_000)).toBe(1);

    expect(claimAt(next, 1_000 + MINUTE_MS)).toEqual({ kind: "won", fence: 2, leaseExpiresAtMs: 1_000 + 2 * MINUTE_MS });
  });

  test("a lease handed back is available at once and cannot be renewed back", () => {
    const dbFile = newDbFile();
    const first = authorityFor(dbFile);
    const second = authorityFor(dbFile);
    const fence = winFence(first, 1_000);

    first.dispose();
    // The fence the ended run held is stale for every handle, not only for the
    // one that let it go, so nothing renews it back or publishes under it.
    const third = authorityFor(dbFile);
    expect(third.renew({ fence, nowMs: 1_100, leaseMs: MINUTE_MS })).toBe("concluded");
    let activated = false;
    expect(third.commitActivation({ fence, checkedAtMs: 2_000, activate: () => { activated = true; } })).toBe(false);
    expect(activated).toBe(false);
    expect(claimAt(second, 1_100)).toEqual({ kind: "won", fence: 2, leaseExpiresAtMs: 1_100 + MINUTE_MS });
  });

  test("a superseded claimant can neither renew, commit a check, nor activate", () => {
    const dbFile = newDbFile();
    const stale = authorityFor(dbFile);
    const winner = authorityFor(dbFile);
    const staleFence = winFence(stale, 1_000);
    winFence(winner, 1_000 + MINUTE_MS);

    let renamed = false;
    expect(stale.renew({ fence: staleFence, nowMs: 1_000 + MINUTE_MS, leaseMs: MINUTE_MS })).toBe("superseded");
    expect(stale.commitCheck({ fence: staleFence, checkedAtMs: 2_000 })).toBe(false);
    expect(stale.commitActivation({ fence: staleFence, checkedAtMs: 2_000, activate: () => { renamed = true; } })).toBe(false);
    expect(renamed).toBe(false);
    expect(storedAuthorityState(dbFile).checkedAtMs).toBe(0);
  });
});

describe("activation commit", () => {
  test("activation runs under the fence and commits the check with it", () => {
    const dbFile = newDbFile();
    const authority = authorityFor(dbFile);
    const fence = winFence(authority, 1_000);

    const order: string[] = [];
    expect(authority.commitActivation({ fence, checkedAtMs: 5_000, activate: () => order.push("renamed") })).toBe(true);
    expect(authority.commitActivation({ fence, checkedAtMs: 6_000, activate: () => order.push("renamed-again") })).toBe(false);
    order.push("committed");

    expect(order).toEqual(["renamed", "committed"]);
    expect(storedAuthorityState(dbFile)).toEqual({ checkedAtMs: 5_000, fence: 1, leaseExpiresAtMs: 0 });
  });

  test("a failed rename commits nothing, so the next claimant still sees no check", () => {
    const dbFile = newDbFile();
    const authority = authorityFor(dbFile);
    const fence = winFence(authority, 1_000);

    expect(() => authority.commitActivation({
      fence,
      checkedAtMs: 5_000,
      activate: () => { throw new Error("rename failed"); },
    })).toThrow("rename failed");

    expect(storedAuthorityState(dbFile).checkedAtMs).toBe(0);
    expect(claimAt(authority, 1_100).kind).toBe("busy");
  });

  test("a crash between the rename and the commit is repaired by a check commit alone", () => {
    const dbFile = newDbFile();
    const repairing = authorityFor(dbFile);
    const fence = winFence(repairing, 1_000 + MINUTE_MS);

    expect(repairing.commitCheck({ fence, checkedAtMs: 9_000 })).toBe(true);
    expect(storedAuthorityState(dbFile)).toMatchObject({ checkedAtMs: 9_000, leaseExpiresAtMs: 0 });
  });
});

describe("contained storage", () => {
  // A mode is what this case measures, and Windows keeps none: `stat` reports
  // the same bits there whatever a write asked for. Privacy on Windows is the
  // owner-only ACL, which windows-private-directory-acl.test.ts covers.
  test.skipIf(!POSIX_FILE_MODES)("the authority, its sidecars, and its directory stay owner-only under a permissive umask, and the account root keeps its own mode", () => {
    const previous = process.umask(0o000);
    try {
      const dbFile = newDbFile();
      const authority = authorityFor(dbFile);
      authority.commitCheck({ fence: winFence(authority, 1_000), checkedAtMs: 1_000 });

      expect(fs.statSync(path.dirname(dbFile)).mode & 0o777).toBe(0o700);
      // The account data root is not this module's to tighten: it holds every
      // other account-global directory too.
      expect(fs.statSync(path.dirname(path.dirname(dbFile))).mode & 0o777).toBe(0o777);
      for (const file of [dbFile, `${dbFile}-wal`, `${dbFile}-shm`]) {
        if (!fs.existsSync(file)) continue;
        expect(fs.statSync(file).mode & 0o777).toBe(0o600);
      }
    } finally {
      process.umask(previous);
    }
  });

  test("a link at the database or at a sidecar is refused instead of followed", () => {
    for (const suffix of ["", "-wal", "-shm"]) {
      const dbFile = newDbFile();
      const outside = newDecoy();
      fs.mkdirSync(path.dirname(dbFile), { recursive: true });
      fs.symlinkSync(path.join(outside, "taken.sqlite"), `${dbFile}${suffix}`);

      expect(() => createUpdateAuthority({ dbFile })).toThrow(/symlink/);
      expect(fs.readdirSync(outside)).toEqual([]);
    }
  });

  test("a link in place of the authority directory is refused instead of followed", () => {
    const userDataRoot = newUserDataRoot();
    const dbFile = updateAuthorityDbFile(userDataRoot, UPDATE_PROTOCOL_VERSION);
    const outside = newDecoy();
    fs.symlinkSync(outside, path.dirname(dbFile));

    expect(() => createUpdateAuthority({ dbFile })).toThrow();
    expect(fs.readdirSync(outside)).toEqual([]);
  });

  test("a link planted at the account data root before its first use is refused instead of followed", () => {
    const userDataRoot = accountRootPath();
    const outside = newDecoy();
    fs.symlinkSync(outside, userDataRoot);

    expect(() => createUpdateAuthority({ dbFile: updateAuthorityDbFile(userDataRoot, UPDATE_PROTOCOL_VERSION) })).toThrow();
    expect(fs.readdirSync(outside)).toEqual([]);
  });

  // The replacement this case stages is a POSIX one: Windows refuses to rename
  // a directory that holds an open file, so an account root cannot be moved out
  // from under a live authority there at all.
  test.skipIf(process.platform === "win32")("an account data root replaced after the handle opened moves nothing the handle touches", () => {
    const userDataRoot = newUserDataRoot();
    const dbFile = updateAuthorityDbFile(userDataRoot, UPDATE_PROTOCOL_VERSION);
    const authority = authorityFor(dbFile);
    const fence = winFence(authority, 1_000);

    const outside = newDecoy();
    fs.renameSync(userDataRoot, `${userDataRoot}-moved`);
    fs.symlinkSync(outside, userDataRoot);

    expect(authority.commitCheck({ fence, checkedAtMs: 2_000 })).toBe(true);
    // Read through the directory the account was moved to, not through the
    // planted link: the commit landing there is the proof it was refused.
    expect(storedAuthorityState(updateAuthorityDbFile(`${userDataRoot}-moved`, UPDATE_PROTOCOL_VERSION)).checkedAtMs).toBe(2_000);
    expect(fs.readdirSync(outside)).toEqual([]);
    // A handle opened after the replacement refuses the planted link rather
    // than coordinating in a directory the account does not own.
    expect(() => createUpdateAuthority({ dbFile })).toThrow();
  });
});

describe("fail closed", () => {
  test("a file another protocol wrote is refused instead of coordinated with", () => {
    const dbFile = newDbFile();
    authorityFor(dbFile).dispose();
    force(dbFile, `protocol_version = ${UPDATE_PROTOCOL_VERSION + 1}`);

    expect(thrownBy(() => createUpdateAuthority({ dbFile }))).toMatchObject({ _tag: "UpdateAuthorityProtocol", expected: UPDATE_PROTOCOL_VERSION, found: UPDATE_PROTOCOL_VERSION + 1 });
  });

  test("a file holding another writer's objects is refused instead of extended", () => {
    const dbFile = newDbFile();
    fs.mkdirSync(path.dirname(dbFile), { recursive: true });
    const raw = new Database(dbFile, { create: true });
    raw.exec("create table someone_elses (id integer primary key)");
    raw.close();

    expect(thrownBy(() => createUpdateAuthority({ dbFile }))).toMatchObject({ _tag: "UpdateAuthorityProtocol", expected: UPDATE_PROTOCOL_VERSION, found: 0 });
  });

  test("a lookalike table without the protocol constraints is refused", () => {
    const dbFile = newDbFile();
    fs.mkdirSync(path.dirname(dbFile), { recursive: true });
    const raw = new Database(dbFile, { create: true });
    raw.exec(`create table update_authority (id integer, protocol_version integer, incarnation text, checked_at integer, fence integer, lease_expires_at integer)`);
    raw.exec(`insert into update_authority values (0, ${UPDATE_PROTOCOL_VERSION}, 'one', 0, 0, 0), (0, ${UPDATE_PROTOCOL_VERSION}, 'two', 0, 0, 0)`);
    raw.close();

    expect(thrownBy(() => createUpdateAuthority({ dbFile }))).toMatchObject({ _tag: "UpdateAuthorityCorrupt", reason: "column contract mismatch" });
  });

  test("a disposed handle refuses every operation instead of speaking for the account again", () => {
    const authority = createUpdateAuthority({ dbFile: newDbFile() });
    authority.dispose();
    authority.dispose();

    expect(thrownBy(() => claimAt(authority, 1_000))).toMatchObject({ _tag: "UpdateAuthorityTransient", at: "using a disposed update authority", reason: "disposed" });
    expect(thrownBy(() => authority.commitCheck({ fence: 1, checkedAtMs: 1_000 }))).toMatchObject({ _tag: "UpdateAuthorityTransient", at: "using a disposed update authority", reason: "disposed" });
  });

  test("state that cannot mean anything is refused, and every later operation reports it", () => {
    const dbFile = newDbFile();
    authorityFor(dbFile).dispose();
    force(dbFile, "lease_expires_at = 5, fence = 0");

    const authority = authorityFor(dbFile);
    expect(thrownBy(() => claimAt(authority, 1_000))).toMatchObject({ _tag: "UpdateAuthorityCorrupt" });
    // The handle latched, so every later operation reports the same reason
    // rather than reading state nobody can trust.
    expect(thrownBy(() => authority.renew({ fence: 1, nowMs: 1_000, leaseMs: MINUTE_MS }))).toMatchObject({ _tag: "UpdateAuthorityCorrupt" });
  });
});
