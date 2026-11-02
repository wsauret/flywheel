/**
 * The process-wide availability owner: one singleton per process, acquired in
 * the composition lifecycle and read by every client build. The owner itself
 * is `provider-availability.ts`; this module owns only its process lifetime
 * and the durable authority it opens.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { Log } from "../../../infra/log.js";
import {
  AVAILABILITY_PROTOCOL_VERSION,
  createAvailabilityAuthority,
} from "../../../infra/llm/availability-store.js";
import { availabilityAuthorityDbFile } from "../../../infra/paths.js";
import { createProviderAvailability } from "./provider-availability.js";
import type { ProviderAvailabilityOwner } from "./provider-availability-types.js";

const log = Log.create({ service: "provider-availability" });

let shared: ProviderAvailabilityOwner | undefined;

/** A sibling authority written within this window belongs to a process that
 *  still runs another binary version. An older file is a leftover of an
 *  upgrade that finished, which partitions nothing. */
const FOREIGN_AUTHORITY_ACTIVE_MS = 60 * 60_000;

/** When `file` or its write-ahead log was last written, or 0 if neither reads. */
function lastWrite(dir: string, file: string): number {
  let latest = 0;
  for (const candidate of [file, `${file}-wal`]) {
    try {
      latest = Math.max(latest, fs.statSync(path.join(dir, candidate)).mtimeMs);
    } catch {
      // An absent write-ahead log is the common case.
    }
  }
  return latest;
}

/** Names the sibling authority files of other protocol versions that a live
 *  process still writes. The file name carries the protocol version, so a
 *  mixed-version fleet (an old binary still running through an upgrade)
 *  coordinates on different files and silently stops seeing each other's
 *  suppressions. That partition is self-healing and safe, but it is exactly
 *  the coordination this authority exists to provide, so acquisition says
 *  it happened. A file no process has written lately is only a leftover, and
 *  warning about it at every executor start repeated one unchanged
 *  condition forever. */
function warnOnProtocolPartition(dbFile: string): void {
  const name = path.basename(dbFile);
  const dir = path.dirname(dbFile);
  let siblings: string[];
  try {
    siblings = fs.readdirSync(dir);
  } catch {
    // An unreadable directory is the acquisition failure's to report.
    return;
  }
  const foreign = siblings
    .filter((file) => /^availability-authority-v\d+\.sqlite$/.test(file) && file !== name)
    .sort();
  const activeSince = Date.now() - FOREIGN_AUTHORITY_ACTIVE_MS;
  const active = foreign.filter((file) => lastWrite(dir, file) >= activeSince);
  if (active.length === 0) {
    if (foreign.length > 0) log.debug("availability authority files of other protocol versions are leftovers", { thisProcess: name, others: foreign.join(", ") });
    return;
  }
  log.warn("availability authority files of other protocol versions are in use; processes on those binary versions coordinate quota separately from this one", {
    thisProcess: name,
    others: active.join(", "),
  });
}

/** Acquires the process-wide availability owner and, with it, the durable
 *  authority under the startup-selected `userDataRoot`: the file is opened,
 *  the protocol it states is inspected, and an absent one is created here, in
 *  the composition lifecycle, before this process accepts a request.
 *  Idempotent.
 *
 *  This is the only place that may do that work. A client build reads what
 *  this acquired, so no request pays for an open, a schema creation, or
 *  another process finishing either. */
export function acquireSharedProviderAvailability(userDataRoot: string, providerIds: readonly string[]): ProviderAvailabilityOwner {
  if (!shared) {
    const dbFile = availabilityAuthorityDbFile(userDataRoot, AVAILABILITY_PROTOCOL_VERSION);
    warnOnProtocolPartition(dbFile);
    shared = createProviderAvailability({ authority: createAvailabilityAuthority({ dbFile, providerIds }) });
  }
  return shared;
}

/** The owner this process acquired, held in the module cache because a
 *  fresh-per-turn client must not own account-level state. Every composition that builds provider
 *  clients (the runtime composition and the headless run) acquires it first,
 *  so a client build here reads what that acquisition opened.
 *
 *  A process that acquired none coordinates with nobody: its observations stay
 *  in memory rather than a client build opening the authority on the request
 *  path. That is a test's process, so the fallback says so once, when it
 *  builds the unowned owner. */
export function getSharedProviderAvailability(): ProviderAvailabilityOwner {
  if (!shared) {
    log.warn("no availability authority was acquired; this process coordinates account quota with nobody");
    shared = createProviderAvailability();
  }
  return shared;
}

/** The owner this process acquired, or undefined when it acquired none. For
 *  an observer that feeds the owner evidence rather than building a client:
 *  it must never create the unowned fallback, because that fallback would then
 *  stand in for the authority the composition acquires a moment later. */
export function peekSharedProviderAvailability(): ProviderAvailabilityOwner | undefined {
  return shared;
}

/** Disposes the process-wide owner and clears the singleton, so a later
 *  request builds a fresh one. Idempotent, and disposal before anything asked
 *  for the owner does nothing. */
export async function disposeSharedProviderAvailability(): Promise<void> {
  const owner = shared;
  shared = undefined;
  await owner?.dispose();
}
