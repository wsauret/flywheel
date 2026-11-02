/**
 * The account-global update authority across a process boundary.
 *
 * Each test here spawns a second Bun process. A fenced cross-process lease is only proved by a second process: two handles in one process share nothing this authority relies on,
 * yet they also cannot show that the fence survives a process boundary. The
 * arrangement is the narrowest one that proves it - one tiny script, one
 * database file, no network and no installed binary. The in-process contract
 * lives in `tests/unit/infra/update/update-authority.test.ts`.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";
import { UPDATE_PROTOCOL_VERSION, createUpdateAuthority } from "../../../../src/infra/update/update-authority.js";
import { MINUTE_MS, createUpdateAuthorityHarness, thrownBy, winFence } from "../../../helpers/update-authority-harness.js";
import { storedAuthorityState } from "../../../helpers/update-authority-state.js";

const harness = createUpdateAuthorityHarness();
const { newDbFile, authorityFor } = harness;
afterAll(() => harness.dispose());

describe("two processes", () => {
  const CHILD_SCRIPT = path.join(harness.root, "claim-in-child.ts");
  const AUTHORITY_SOURCE = path.resolve(import.meta.dir, "../../../../src/infra/update/update-authority.ts");
  fs.writeFileSync(CHILD_SCRIPT, [
    `const { createUpdateAuthority } = await import(${JSON.stringify(AUTHORITY_SOURCE)});`,
    "const authority = createUpdateAuthority({ dbFile: process.argv[2] });",
    "process.stdout.write(JSON.stringify(authority.claim({ nowMs: Number(process.argv[3]), freshForMs: 0, leaseMs: 60_000 })));",
    "",
  ].join("\n"));

  const LOCK_DURING_OPEN_SCRIPT = path.join(harness.root, "lock-during-open.ts");
  fs.writeFileSync(LOCK_DURING_OPEN_SCRIPT, [
    'import { Database } from "bun:sqlite";',
    "const db = new Database(process.argv[2], { create: true });",
    'db.exec("PRAGMA journal_mode = WAL");',
    'db.exec("BEGIN IMMEDIATE");',
    'if (process.argv[3] === "foreign") db.exec("create table another_writer (value text)");',
    'if (process.argv[3] === "protocol") {',
    '  db.exec("create table update_authority (id integer primary key, protocol_version integer not null, incarnation text not null, checked_at integer not null, fence integer not null, lease_expires_at integer not null)");',
    '  db.exec("insert into update_authority values (0, 999, \'foreign\', 0, 0, 0)");',
    "}",
    'process.stdout.write("locked\\n");',
    "Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(process.argv[4]));",
    'db.exec("COMMIT");',
    "db.close();",
    "",
  ].join("\n"));

  /** A second Flywheel process claiming the same account authority. It does
   *  not dispose: a process that wins and then leaves holds its lease exactly
   *  as a crashed one would. */
  function claimInChild(dbFile: string, nowMs: number) {
    const child = Bun.spawnSync([process.execPath, CHILD_SCRIPT, dbFile, String(nowMs)], { windowsHide: true });
    if (!child.success) throw new Error(`child claim failed: ${child.stderr.toString()}`);
    return JSON.parse(child.stdout.toString());
  }

  async function claimInChildConcurrently(dbFile: string, nowMs: number) {
    const child = Bun.spawn([process.execPath, CHILD_SCRIPT, dbFile, String(nowMs)], { stdout: "pipe", stderr: "pipe", windowsHide: true });
    const [status, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    if (status !== 0) throw new Error(`child claim failed: ${err}`);
    return JSON.parse(out);
  }

  async function startLockedWriter(dbFile: string, kind: "empty" | "foreign" | "protocol", holdMs: number) {
    fs.mkdirSync(path.dirname(dbFile), { recursive: true, mode: 0o700 });
    fs.closeSync(fs.openSync(dbFile, "wx", 0o600));
    const child = Bun.spawn([process.execPath, LOCK_DURING_OPEN_SCRIPT, dbFile, kind, String(holdMs)], { stdout: "pipe", stderr: "pipe", windowsHide: true });
    const reader = child.stdout.getReader();
    const ready = await reader.read();
    reader.releaseLock();
    if (ready.done || new TextDecoder().decode(ready.value) !== "locked\n") throw new Error("locked writer did not become ready");
    return {
      child,
      async expectSuccess(): Promise<void> {
        const [status, error] = await Promise.all([child.exited, new Response(child.stderr).text()]);
        expect(error).toBe("");
        expect(status).toBe(0);
      },
    };
  }

  test("a lease one process holds blocks another process until the handle hands it back", () => {
    const dbFile = newDbFile();
    const local = authorityFor(dbFile);
    const fence = winFence(local, 1_000);

    expect(claimInChild(dbFile, 2_000)).toEqual({ kind: "busy", leaseExpiresAtMs: 1_000 + MINUTE_MS });

    // Disposal is the whole of handing a lease back: it is the end of the run
    // that won the lease, so a handle that keeps working keeps the lease.
    local.dispose();
    expect(claimInChild(dbFile, 3_000)).toEqual({ kind: "won", fence: 2, leaseExpiresAtMs: 3_000 + MINUTE_MS });
    // The superseded fence publishes nothing, whichever handle asks under it.
    expect(authorityFor(dbFile).commitCheck({ fence, checkedAtMs: 3_000 })).toBe(false);
  });

  test("two processes repeatedly creating one authority produce one authority and one winner", async () => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const dbFile = newDbFile();
      const nowMs = 4_000 + attempt;
      const claims = await Promise.all([claimInChildConcurrently(dbFile, nowMs), claimInChildConcurrently(dbFile, nowMs)]);

      expect(claims.filter((claim) => typeof claim === "object" && claim !== null && "kind" in claim && claim.kind === "won")).toEqual([{ kind: "won", fence: 1, leaseExpiresAtMs: nowMs + MINUTE_MS }]);
      expect(claims.filter((claim) => typeof claim === "object" && claim !== null && "kind" in claim && claim.kind === "busy")).toEqual([{ kind: "busy", leaseExpiresAtMs: nowMs + MINUTE_MS }]);
      expect(storedAuthorityState(dbFile)).toMatchObject({ fence: 1, checkedAtMs: 0 });
    }
  });

  test("cold open retries after a peer outlasts the SQLite busy wait", async () => {
    const dbFile = newDbFile();
    const writer = await startLockedWriter(dbFile, "empty", 400);

    authorityFor(dbFile);
    expect(storedAuthorityState(dbFile)).toMatchObject({ fence: 0, checkedAtMs: 0 });
    await writer.expectSuccess();
  });

  test("initialization refuses foreign objects committed after its preflight read", async () => {
    const dbFile = newDbFile();
    const writer = await startLockedWriter(dbFile, "foreign", 100);

    expect(thrownBy(() => createUpdateAuthority({ dbFile }))).toMatchObject({ _tag: "UpdateAuthorityProtocol", expected: UPDATE_PROTOCOL_VERSION, found: 0 });
    await writer.expectSuccess();
    const raw = new Database(dbFile);
    expect(raw.query<{ name: string }, []>("select name from sqlite_master order by name").all()).toEqual([{ name: "another_writer" }]);
    raw.close();
  });

  test("initialization refuses an incompatible protocol committed after its preflight read", async () => {
    const dbFile = newDbFile();
    const writer = await startLockedWriter(dbFile, "protocol", 100);

    expect(thrownBy(() => createUpdateAuthority({ dbFile }))).toMatchObject({ _tag: "UpdateAuthorityProtocol", expected: UPDATE_PROTOCOL_VERSION, found: 999 });
    await writer.expectSuccess();
    const raw = new Database(dbFile);
    expect(raw.query<{ protocol_version: number }, []>("select protocol_version from update_authority where id = 0").get()).toEqual({ protocol_version: 999 });
    raw.close();
  });
});
