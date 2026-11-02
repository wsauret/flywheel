/** Account homes, database paths, and claim shapes for update authority tests.
 *
 *  The in-process cases and the cross-process cases open authorities the same
 *  way, so they share one harness. Each harness owns one temporary directory
 *  and every handle it opens; `dispose` closes the handles before it removes
 *  the directory, because an open database holds its own file open and Windows
 *  refuses to remove a file anything still holds. */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { updateAuthorityDbFile } from "../../src/infra/paths.js";
import { UPDATE_PROTOCOL_VERSION, createUpdateAuthority, type UpdateAuthority } from "../../src/infra/update/update-authority.js";

export const MINUTE_MS = 60_000;
export const HOUR_MS = 60 * MINUTE_MS;

export interface UpdateAuthorityHarness {
  readonly root: string;
  /** One account data root path nothing has created yet. Its parent is the
   *  account home this authority opens it from. */
  accountRootPath(): string;
  /** One account data root nobody else writes to. */
  newUserDataRoot(): string;
  /** A directory outside the account, for a planted link to point at. A
   *  refused link leaves it empty; a followed one would not. */
  newDecoy(): string;
  newDbFile(): string;
  authorityFor(dbFile: string): UpdateAuthority;
  dispose(): void;
}

export function createUpdateAuthorityHarness(): UpdateAuthorityHarness {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flywheel-update-authority-"));
  const handles: UpdateAuthority[] = [];
  let accounts = 0;
  let decoys = 0;

  const accountRootPath = (): string => path.join(root, `account-${++accounts}`);
  const newUserDataRoot = (): string => {
    const dir = accountRootPath();
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  };

  return {
    root,
    accountRootPath,
    newUserDataRoot,
    newDecoy: () => {
      const dir = path.join(root, `outside-${++decoys}`);
      fs.mkdirSync(dir, { recursive: true });
      return dir;
    },
    newDbFile: () => updateAuthorityDbFile(newUserDataRoot(), UPDATE_PROTOCOL_VERSION),
    authorityFor: (dbFile) => {
      const authority = createUpdateAuthority({ dbFile });
      handles.push(authority);
      return authority;
    },
    dispose: () => {
      for (const authority of handles) authority.dispose();
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

/** The one claim shape these tests vary: a one-hour freshness window and a
 *  one-minute lease unless the case is about one of them. */
export function claimAt(authority: UpdateAuthority, nowMs: number, overrides: { freshForMs?: number; leaseMs?: number } = {}) {
  return authority.claim({ nowMs, freshForMs: overrides.freshForMs ?? HOUR_MS, leaseMs: overrides.leaseMs ?? MINUTE_MS });
}

/** Wins a fence, the way every caller starts. */
export function winFence(authority: UpdateAuthority, nowMs: number, leaseMs = MINUTE_MS): number {
  const claim = claimAt(authority, nowMs, { leaseMs });
  if (claim.kind !== "won") throw new Error(`expected a winning claim, got ${claim.kind}`);
  return claim.fence;
}

export function thrownBy(run: () => void): Error {
  try {
    run();
  } catch (error) {
    if (error instanceof Error) return error;
    throw new Error("expected operation to throw an Error", { cause: error });
  }
  throw new Error("expected operation to throw");
}
