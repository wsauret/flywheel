import { errnoCode, errorDetail, errorMessage } from "../../infra/error-message.js";
import { Log } from "../../infra/log.js";
import { ownerPidRelativePath, resolveOwnerPidPath } from "../../infra/paths.js";
import { decodeHolderText, encodeHolderText, processHolders } from "../../infra/process-holder.js";
import { readFileUnder, removeFileUnder, writeFileUnder } from "../../infra/write-file-under.js";

const log = Log.create({ service: "session-pid-lock" });

/** Earlier builds read at most 64 bytes of `owner.pid`, and a version 1
 *  record is at most 63, so every build reads every record this build writes.
 *  A larger file is no record any build wrote. */
const MAX_PID_BYTES = 64;

/** The owner records whose answer was unknown, each warned about once in this
 *  process: the answer repeats at every recovery read until it changes. */
const warnedUnknown = new Set<string>();

/** Record this process as the owner of a session. `owner.pid` holds the
 *  process's holder identity in its text encoding, `<pid> <v> <start>[ <boot>]`
 *  (src/infra/process-holder.ts), with no newline, so an earlier build that
 *  takes the leading pid still reads the owner. A process that cannot read its
 *  own identity writes its pid alone, which a recovery reads as a live owner
 *  while that pid runs; the next write asks for the identity again.
 *
 *  Every operation on the record walks the session tree component by component
 *  below the project root and follows no link, so a replaced `sessions`,
 *  session-id, or `owner.pid` entry cannot move this write, read, or removal out
 *  of the project. The absolute path is only ever a diagnostic. */
export function writeOwnerPid(sessionId: string, projectRoot: string, scope: "session" | "workflow" = "session"): void {
  writeFileUnder(projectRoot, ownerPidRelativePath(sessionId, scope), encodeHolderText(process.pid, processHolders.own()));
}

export function removeOwnerPid(sessionId: string, projectRoot: string, scope: "session" | "workflow" = "session"): void {
  try {
    removeFileUnder(projectRoot, ownerPidRelativePath(sessionId, scope));
  } catch (err) {
    const pidPath = resolveOwnerPidPath(sessionId, projectRoot, scope);
    log.debug("owner pid lock removal skipped", { sessionId, pidPath, error: errorMessage(err), errorDetail: errorDetail(err) });
  }
}

/** Whether the process that owned a session is proven gone. It is the one
 *  answer that lets a recovery act on the session: pause it, finish its
 *  in-flight cells, or record the turn it left unfinished.
 *
 *  A missing record is gone, because a closed session has none. Content that
 *  names no pid is gone, because no build writes it. Otherwise the answer is
 *  the holder's: it is gone only when its pid holds no process, holds a
 *  process with another start stamp, or the record names another boot. A
 *  record that cannot be read, a pid the kernel does not answer for, and an
 *  identity version this build does not know keep the session as it is, and
 *  the next read asks again. Acting under a live owner would record its
 *  in-flight turn twice. A bare pid that an earlier build wrote is kept while
 *  that pid runs, unless the project's replacement claim fenced that
 *  predecessor and handed its recovery to this service. */
export function isSessionOwnerGone(sessionId: string, projectRoot: string, scope: "session" | "workflow" = "session", predecessorPids: readonly number[] = []): boolean {
  const pidPath = resolveOwnerPidPath(sessionId, projectRoot, scope);
  let bytes: Buffer | undefined;
  try {
    bytes = readFileUnder(projectRoot, ownerPidRelativePath(sessionId, scope), { maxBytes: MAX_PID_BYTES });
  } catch (err) {
    warnUnknownOnce({ sessionId, pidPath, code: errnoCode(err), reason: errorMessage(err) });
    return false;
  }
  if (bytes === undefined) return true;
  const content = bytes.toString("utf-8");
  const holder = decodeHolderText(content);
  if (holder === undefined) {
    log.info("owner pid lock contains invalid pid", { sessionId, pidPath, bytes: bytes.length });
    return true;
  }
  // The caller proves these predecessors released the project, or is recovering
  // this pid's previous image before the new image admits session work.
  if (predecessorPids.includes(holder.pid)) return true;
  const state = processHolders.state(holder);
  if (state.kind === "unknown") warnUnknownOnce({ sessionId, pidPath, pid: holder.pid, reason: state.reason });
  return state.kind === "gone";
}

/** An owner record whose holder is neither proven alive nor proven gone. */
interface UnknownOwner {
  readonly sessionId: string;
  readonly pidPath: string;
  readonly reason: string;
  /** The read error's code, when the record could not be read. */
  readonly code?: string;
  /** The pid the record names, when it could be read. */
  readonly pid?: number;
}

function warnUnknownOnce(owner: UnknownOwner): void {
  if (warnedUnknown.has(owner.pidPath)) return;
  warnedUnknown.add(owner.pidPath);
  log.warn("session owner could not be proven gone, so recovery leaves the session as it is", { ...owner });
}
