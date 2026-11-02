/** What the update authority file states, read straight from the row.
 *
 *  The authority itself publishes no projection of its state, because no
 *  production path needs one: every decision it makes is a fenced write whose
 *  whole answer is a boolean, and a claim answers with the claim. So a test
 *  that asserts on the stored facts reads the stored facts, which is also the
 *  honest thing for a test to do - it observes the durable row rather than a
 *  method the production interface would carry only for it. */

import { Database } from "bun:sqlite";

export interface StoredAuthorityState {
  readonly checkedAtMs: number;
  readonly fence: number;
  readonly leaseExpiresAtMs: number;
}

export function storedAuthorityState(dbFile: string): StoredAuthorityState {
  // Opened read-write on purpose: a read-only connection to a WAL database
  // cannot create the shared-memory sidecar it needs, so it fails on exactly
  // the databases these tests produce.
  const db = new Database(dbFile);
  try {
    const row = db.query<{ checked_at: number; fence: number; lease_expires_at: number }, []>(
      `select checked_at, fence, lease_expires_at from update_authority where id = 0`,
    ).get();
    if (!row) throw new Error(`${dbFile} holds no update authority state row`);
    return { checkedAtMs: row.checked_at, fence: row.fence, leaseExpiresAtMs: row.lease_expires_at };
  } finally {
    db.close();
  }
}
