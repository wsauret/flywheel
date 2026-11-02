/** The build a rollback took out of activation on this account (ARCH-DISTRIBUTION-024).
 *
 *  A rollback moves `current` away from a build that could not start here, or
 *  could not open any project here, and leaves that build installed. The same release would only
 *  fail and roll back again, so an update check must not activate it, or any
 *  release that is not newer, until a newer release appears. This record
 *  carries that one fact, with the reason.
 *
 *  Only a rollback writes it, inside its fenced activation under the account
 *  update lease, so two writers never race. The record lives beside the update
 *  authority, private and descriptor-contained like every other file there. */

import { randomBytes } from "node:crypto";
import * as path from "node:path";
import { Schema } from "effect";
import { ContainedDirectory } from "../../infra/descriptor-directory.js";
import { errorMessage } from "../../infra/error-message.js";
import { Log } from "../../infra/log.js";
import { type BuildRef, BuildRefSchema } from "../../infra/update/build-identity.js";

const log = Log.create({ service: "refused-build" });

const RECORD_NAME = "refused-build.json";
const UPDATE_DIR = "update";
const RECORD_MAX_BYTES = 8 * 1024;

const RefusedBuildRecordSchema = Schema.Struct({
  version: Schema.Literal(1),
  /** The build a rollback left installed but not current. */
  refused: BuildRefSchema,
  /** Why the build was judged unable to work on this account. */
  reason: Schema.String,
});
type RefusedBuildRecord = typeof RefusedBuildRecordSchema.Type;
const decodeRecord = Schema.decodeUnknownSync(RefusedBuildRecordSchema);

/** The stored contents already reported as a shape this build does not know.
 *  The coordinator reads the record on every run, and one report for each
 *  distinct content is enough. */
const reportedUnknown = new Set<string>();

/** The build a rollback refused, whose version an update check does not
 *  install again until a newer release is published. A record this build
 *  cannot read names no refused build: it is reported once for each content,
 *  and never repaired here, because it can hold what a newer build wrote. */
export function refusedBuild(userDataRoot: string): BuildRef | undefined {
  let raw: Buffer | undefined;
  try {
    const directory = ContainedDirectory.openExisting(path.dirname(userDataRoot), [path.basename(userDataRoot), UPDATE_DIR]);
    if (!directory) return undefined;
    try {
      raw = directory.readFile(RECORD_NAME, RECORD_MAX_BYTES);
    } finally {
      directory.close();
    }
  } catch (error) {
    log.warn("the refused-build record could not be read; no refused build is known", { error: errorMessage(error) });
    return undefined;
  }
  if (raw === undefined) return undefined;
  const decoded = decodeStored(raw);
  if (decoded.kind === "known") return decoded.record.refused;
  const content = raw.toString("utf8");
  if (!reportedUnknown.has(content)) {
    reportedUnknown.add(content);
    log.warn("the refused-build record has a shape this build does not know; no refused build is known", { error: decoded.reason });
  }
  return undefined;
}

/** Replace the record through the held account root. Called only inside a
 *  rollback's fenced activation. A stored record of a shape this build does
 *  not know is reported before it is replaced. */
export function writeRefusedBuild(accountRoot: ContainedDirectory, record: RefusedBuildRecord): void {
  const updateDir = accountRoot.openChild(UPDATE_DIR, { privateDirectories: true });
  try {
    const stored = updateDir.readFile(RECORD_NAME, RECORD_MAX_BYTES);
    const decoded = stored === undefined ? undefined : decodeStored(stored);
    if (decoded?.kind === "unknown") log.warn("a refused-build record of a shape this build does not know is replaced by this rollback", { error: decoded.reason });
    const failure = updateDir.publishFileThrough(`.${RECORD_NAME}.${process.pid}.${randomBytes(8).toString("hex")}`, RECORD_NAME, `${JSON.stringify(record)}\n`, 0o600);
    if (failure) throw failure;
  } finally {
    updateDir.close();
  }
}

function decodeStored(raw: Buffer): { readonly kind: "known"; readonly record: RefusedBuildRecord } | { readonly kind: "unknown"; readonly reason: string } {
  try {
    return { kind: "known", record: decodeRecord(JSON.parse(raw.toString("utf8"))) };
  } catch (error) {
    return { kind: "unknown", reason: errorMessage(error) };
  }
}
