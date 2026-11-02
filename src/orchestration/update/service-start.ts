/** What one start of the installed account service does with the account's
 *  start record, and the rollback that record triggers (ARCH-RUNTIME-042, ARCH-DISTRIBUTION-024).
 *
 *  A start counts itself at the entry, before command composition loads,
 *  because a build can fail anywhere on its way to the listener, including in
 *  that import, and a failed start leaves no other evidence. A start that finds
 *  that the last three starts of its build ended before they listened moves
 *  `current` back to the last build proved here, one of whose project
 *  executors reported ready on this account, and exits so that the service
 *  manager starts that build.
 *
 *  A counted start that ends without failing takes its count back: a start
 *  that parks behind another owner or a registration handoff, a start that
 *  another process's port keeps from listening, a start that the start lock
 *  or an address probe that proves nothing refuses, and a start that a
 *  signal stops before it listens. Only the start this process counted is ever taken
 *  back or confirmed, so one process holds at most one counted start.
 *
 *  A start that ends with a cause it can state, before it listens or on its
 *  probation, adds that failure to the lane's failing streak: the serve
 *  command's refusal does, and so does the entry's fatal path, which every
 *  thrown and uncaught failure reaches. Probation is the start's first minute
 *  after it listens. A start that serves that minute, or ends by its own exit
 *  path during it, ends the streak and any park. A failure on probation
 *  joins the streak with its count already confirmed at the listen, so it
 *  never counts toward the rollback of its build. A streak that persists
 *  parks the lane. The start that parks exits with the code its manager does
 *  not restart, so the loop stops with its cause recorded. A parked lane stays
 *  parked until a start serves: a client's start request runs one start, and
 *  when that start fails for a cause that can park, it parks again at once, so
 *  the manager stops again, and a client whose start failed before its listen
 *  reads the cause without waiting out its deadline. Only a streak that has not parked ends at a gap:
 *  a start that begins more than a minute after its latest failure begins a
 *  new streak, so failures far apart never add up to a park. A cause that
 *  clears with no person's action never parks, and it does not end a park
 *  either. A thrown failure of a build that the rollback can still replace
 *  never parks, because that rollback comes first. While the lane is parked, a
 *  start that repeats the condition of the latest failure writes its records
 *  at DEBUG and the record counts it; the start that serves after the park
 *  reports that count once.
 *
 *  A start that listens while its lane's streak holds more than one stop on
 *  probation reports a crash loop to every client of the service, with the
 *  latest cause, until it serves its own minute (PI-INTERACTION-047). One stop that
 *  recovers reports nothing. */

import { Log } from "../../infra/log.js";
import { shutdownSignals, type ShutdownSignal } from "../../infra/shutdown-signals.js";
import type { BuildRef } from "../../infra/update/build-identity.js";
import { ownBuild } from "../../infra/update/live-builds.js";
import { countServiceStart, recordServiceListened, recordServiceServed, recordServiceStartFailure, type StartCauseKind, uncountServiceStart } from "../../infra/update/service-start-record.js";
import type { RuntimeServiceState } from "../../protocol/app-service-types.js";
import { decodeServeStartRefusal, type ServeStartRefusal } from "../../protocol/serve-handshake.js";

const log = Log.create({ service: "service-start-record" });

/** How many starts of one build in a row may end before they listen. The
 *  next start rolls back. */
const FAILED_STARTS_BEFORE_ROLLBACK = 3;
/** A start that begins longer than this after the latest failure of a
 *  streak that has not parked begins a new streak, so unrelated failures far
 *  apart never add up to a park. The managers restart a failed start within
 *  5 seconds: launchd after 1, systemd after 5. */
const STREAK_GAP_MS = 60_000;
/** How long, and over how many starts, a streak fails before a start parks.
 *  The time is longer than the account's drain bound plus the managers'
 *  restart spacing, so a predecessor that still drains on the hub's port
 *  never parks its successor. */
const PARK_AFTER_MS = 120_000;
const PARK_AFTER_STARTS = 3;
const PARKS_AGAIN = "the account service start parks again: its lane stays parked until a start serves";
/** How long a start serves after it listens before it has proved that it
 *  keeps serving. A fatal failure before then is an early stop, which joins
 *  the lane's failing streak like a failed start. */
const SERVED_PROOF_MS = 60_000;
/** One stop on probation that recovers is invisible; a second one in the
 *  same streak is a crash loop, which the start that listens next reports to
 *  its clients. The project executor's notice follows the same rule. */
const REPORT_AFTER_STOPS = 2;

/** The signal listeners that hold a start's count until it listens. */
type CountHold = readonly (readonly [ShutdownSignal, () => void])[];

/** Runs `served` once `delayMs` has passed, and answers the cancel of that
 *  wait. */
export type ProbationSchedule = (served: () => void, delayMs: number) => () => void;

const probationTimer: ProbationSchedule = (fire, delayMs) => {
  const timer = setTimeout(fire, delayMs);
  // The wait never keeps alive a process that has nothing else to do.
  timer.unref?.();
  return () => clearTimeout(timer);
};

/** Whether this process's account service has listened, from its listen
 *  until the process ends, of any lane and whether or not its start counted.
 *  It stays true after the start serves, because a later failure is still a
 *  failure of a service that started. */
let listenedHere = false;

/** This process's start of the installed account service, from its
 *  admission until it serves or fails. */
let start: {
  readonly userDataRoot: string;
  readonly build: BuildRef;
  readonly beganAtMs: number;
  /** The start reached the limit of failed starts, and the account could
   *  not be rolled back. */
  readonly rollbackRefused: boolean;
  /** Present while this start's count stands: the signal listeners that
   *  take it back. A start whose count could not be written has none. */
  counted: CountHold | undefined;
  /** Present from the listen until the start serves or fails. */
  probation: {
    readonly cancel: () => void;
    /** Present when the listen reported a crash loop, which the served step
     *  ends. */
    readonly reported: ((state: RuntimeServiceState) => void) | undefined;
  } | undefined;
} | undefined;

/** Count this start of the installed account service, or roll the account
 *  back when the earlier starts of its build never listened. `rolled-back`
 *  means `current` now names another build, so this process must exit for the
 *  service manager to start that one. A process that runs no installed build
 *  counts nothing. */
export async function admitServiceStart(admission: { readonly userDataRoot: string; readonly nowMs: number; readonly execPath?: string }): Promise<"serve" | "rolled-back"> {
  const { userDataRoot, nowMs } = admission;
  forget();
  listenedHere = false;
  const build = ownBuild(userDataRoot, admission.execPath);
  if (build === undefined) return "serve";
  const failedStarts = countServiceStart(userDataRoot, build);
  if (failedStarts === undefined) {
    start = { userDataRoot, build, beganAtMs: nowMs, rollbackRefused: false, counted: undefined, probation: undefined };
    return "serve";
  }
  const atLimit = failedStarts >= FAILED_STARTS_BEFORE_ROLLBACK;
  if (atLimit) {
    // Loaded only here: a start that has nothing to roll back never loads
    // the install engine.
    const { rollBackActivation } = await import("./install-engine.js");
    const outcome = rollBackActivation({
      userDataRoot,
      failed: build,
      reason: `its account service stopped before it listened ${failedStarts} times in a row`,
      nowMs,
    });
    if (outcome.kind === "rolled-back") {
      log.warn("the current build's account service stopped before it listened too many times in a row; the account was rolled back to the last proved build", { from: outcome.from, to: outcome.to, failedStarts, ...(outcome.unrecorded === undefined ? {} : { unrecorded: outcome.unrecorded }) });
      return "rolled-back";
    }
    // Said once, when the limit is first reached; the starts after it keep
    // asking in silence, because each one may find the lease free.
    if (failedStarts === FAILED_STARTS_BEFORE_ROLLBACK) {
      log.warn("the current build's account service stopped before it listened too many times in a row, and the account cannot be rolled back", { buildId: build.buildId, failedStarts, reason: outcome.reason });
    }
  }
  // A start at the limit that serves was not rolled back.
  start = { userDataRoot, build, beganAtMs: nowMs, rollbackRefused: atLimit, counted: hold(), probation: undefined };
  return "serve";
}

/** This counted start fails for a cause that is not its build's, such as a
 *  refusal by another holder or a port that another process holds, so its
 *  count is taken back. The start stays this process's, so its failure still
 *  joins the lane's streak. */
export function withdrawServiceStart(): void {
  if (start?.counted === undefined) return;
  release(start.counted);
  start.counted = undefined;
  uncountServiceStart(start.userDataRoot, start.build.buildId);
}

/** This start ends here without failing. Before it listens, it parks behind
 *  another owner or a registration handoff, exits to be asked again, or a
 *  signal stops it: its count is taken back. On probation, it ends by its own
 *  exit path, such as a retirement, a signal, or no longer being held: it has
 *  served, so the lane's streak ends. Nothing later in this process answers
 *  for it. */
export function endServiceStart(nowMs = Date.now()): void {
  if (start?.probation !== undefined) {
    served(nowMs);
    return;
  }
  withdrawServiceStart();
  forget();
}

/** This start listened: its count is confirmed, and its probation begins.
 *  The listen proves nothing about the build: only a project executor that
 *  reports ready does (`build-fallback.ts`). The lane's failing streak stays
 *  until the start serves `SERVED_PROOF_MS`, which `schedule` times, or ends
 *  by its own exit path. When the streak holds more than one stop on
 *  probation, `report` is told of the crash loop now and of its end when the
 *  start serves. Runs after the service listens, off the attach
 *  path. */
export function confirmServiceStart(options: { readonly nowMs?: number; readonly schedule?: ProbationSchedule | undefined; readonly report?: (state: RuntimeServiceState) => void } = {}): void {
  listenedHere = true;
  const listened = start;
  if (listened === undefined || listened.probation !== undefined) return;
  const listenedAtMs = options.nowMs ?? Date.now();
  if (listened.counted !== undefined) release(listened.counted);
  listened.counted = undefined;
  const streak = recordServiceListened(listened.userDataRoot);
  const crashLoop = streak !== undefined && continues(streak, listened.beganAtMs) && (streak.stopsAfterListen ?? 0) >= REPORT_AFTER_STOPS;
  if (crashLoop) {
    // A parked lane's repeated starts are counted in its park, so only the
    // loop's first report before a park is written at full level.
    const evidence = { starts: streak.starts, stopsAfterListen: streak.stopsAfterListen, causeKind: streak.causeKind };
    if (streak.parked === undefined) log.info("the account service reports a crash loop to its clients", evidence);
    else log.debug("the account service reports a crash loop to its clients", evidence);
    options.report?.({ kind: "crash_loop", cause: streak.cause });
  }
  // The served step reads the time the proof completes, which is when the
  // start served.
  const cancel = (options.schedule ?? probationTimer)(() => { served(listenedAtMs + SERVED_PROOF_MS); }, SERVED_PROOF_MS);
  listened.probation = { cancel, reported: crashLoop ? options.report : undefined };
}

/** Whether this process's account service has listened. */
export function serviceListened(): boolean {
  return listenedHere;
}

/** This start ended with a cause it can state, before it listened or on its
 *  probation. The failure joins the lane's failing streak, and the answer says
 *  whether the process parks, which exits with the code its manager does not
 *  restart, or exits to be restarted. The start parks when the streak has
 *  parked before, or when it has failed for PARK_AFTER_MS over
 *  PARK_AFTER_STARTS starts, unless the cause clears with no person's action
 *  or the rollback can still replace this start's build. A process with no
 *  start of the installed service, such as a source run, adds nothing to a
 *  streak, and neither does a start that has served or whose record cannot be
 *  written.
 *
 *  `recordCause` writes the caller's own record of the cause, once, before the
 *  record of the park. While the lane is parked, each client's start request
 *  runs a start, so a start that repeats the cause kind and refusal kind of
 *  the latest failure is a repeat of one condition: `repeat` is true, both of
 *  its records are DEBUG, and the record's park counts it. The start that
 *  serves reports the count. A start whose condition changed records as a
 *  first occurrence does. */
export function failServiceStart(failure: { readonly cause: string; readonly causeKind: StartCauseKind; readonly refusal?: ServeStartRefusal | undefined }, recordCause: (repeat: boolean) => void, nowMs = Date.now()): "park" | "restart" {
  const failed = start;
  if (failed === undefined) {
    recordCause(false);
    return "restart";
  }
  // The count of a thrown failure stands, for the rollback of its build. A
  // start on probation confirmed its count at the listen.
  const counted = failed.counted !== undefined;
  const afterListen = failed.probation !== undefined;
  forget();
  let parks = false;
  let parkedBefore = false;
  let repeat = false;
  const streak = recordServiceStartFailure(failed.userDataRoot, (record) => {
    const previous = record?.failing;
    parkedBefore = previous?.parked !== undefined;
    repeat = previous?.parked !== undefined && previous.causeKind === failure.causeKind && decodeServeStartRefusal(previous.refusal)?.kind === failure.refusal?.kind;
    const joins = previous !== undefined && continues(previous, failed.beganAtMs);
    const since = joins ? previous.since : nowMs;
    const starts = joins ? previous.starts + 1 : 1;
    const stopsAfterListen = (joins ? previous.stopsAfterListen ?? 0 : 0) + (afterListen ? 1 : 0);
    const persisted = parkedBefore || (nowMs - since >= PARK_AFTER_MS && starts >= PARK_AFTER_STARTS);
    const rollbackFirst = counted && record?.proved !== undefined && record.proved.buildId !== failed.build.buildId && !failed.rollbackRefused;
    parks = failure.causeKind !== "clears-itself" && persisted && !rollbackFirst;
    const parked = previous?.parked === undefined
      ? (parks ? { since: nowMs, lastAt: nowMs, starts: 1 } : undefined)
      : { since: previous.parked.since, lastAt: parks ? nowMs : previous.parked.lastAt, starts: previous.parked.starts + 1 };
    return { since, lastAt: nowMs, starts, cause: failure.cause, causeKind: failure.causeKind, ...(failure.refusal === undefined ? {} : { refusal: failure.refusal }), ...(stopsAfterListen === 0 ? {} : { stopsAfterListen }), ...(parked === undefined ? {} : { parked }) };
  });
  // A record that cannot be written counts nothing, so its failure records in
  // full.
  const counts = streak !== undefined && repeat;
  recordCause(counts);
  if (!parks || streak?.parked === undefined) return "restart";
  if (!parkedBefore) log.warn("the account service start parks: the starts of its lane have failed too long", { starts: streak.starts, failingMs: streak.lastAt - streak.since, ...(failure.refusal === undefined ? {} : { refusal: failure.refusal.kind }) });
  else if (counts) log.debug(PARKS_AGAIN, parkedEvidence(streak.parked, streak, nowMs));
  else log.warn(PARKS_AGAIN, parkedEvidence(streak.parked, streak, nowMs));
  return "park";
}

/** Whether a start that began at `beganAtMs` continues the streak: a parked
 *  streak lasts until a start serves, however long after the park the start
 *  that a client requested begins, and any other streak ends at a gap longer
 *  than STREAK_GAP_MS. */
function continues(streak: { readonly lastAt: number; readonly parked?: unknown }, beganAtMs: number): boolean {
  return streak.parked !== undefined || beganAtMs - streak.lastAt <= STREAK_GAP_MS;
}

/** The start served: it ran its first minute after the listen, or it ended by
 *  its own exit path before that. The lane's failing streak ends, a park that
 *  it ends is reported once, and a crash loop that the listen reported ends. */
function served(nowMs: number): void {
  const ended = forget();
  if (ended?.probation === undefined) return;
  const streak = recordServiceServed(ended.userDataRoot);
  if (streak?.parked !== undefined) log.info("the account service serves after its lane parked", parkedEvidence(streak.parked, streak, nowMs));
  else if (ended.probation.reported !== undefined) log.info("the account service serves after its crash loop", { starts: streak?.starts, stopsAfterListen: streak?.stopsAfterListen });
  ended.probation.reported?.({ kind: "serving" });
}

/** The evidence of a parked lane's records, with no content: the failed
 *  starts from its first park on, the time since that park, and the kinds of
 *  the latest failure. */
function parkedEvidence(parked: { readonly since: number; readonly starts: number }, latest: { readonly causeKind: StartCauseKind; readonly refusal?: unknown }, nowMs: number) {
  const refusal = decodeServeStartRefusal(latest.refusal)?.kind;
  return { parkedStarts: parked.starts, parkedForMs: nowMs - parked.since, causeKind: latest.causeKind, ...(refusal === undefined ? {} : { refusal }) };
}

/** Until this start listens, a signal that stops it is not the build's
 *  failure. Each listener takes the count back and raises the signal again,
 *  so the process ends exactly as it would have without this listener. */
function hold(): CountHold {
  return shutdownSignals(process.platform).map((signal) => {
    const listener = (): void => {
      endServiceStart();
      process.kill(process.pid, signal);
    };
    process.once(signal, listener);
    return [signal, listener] as const;
  });
}

function release(listeners: CountHold): void {
  for (const [signal, listener] of listeners) process.off(signal, listener);
}

/** Ends this process's hold on its start and its probation, and answers the
 *  start. */
function forget(): typeof start {
  const ended = start;
  start = undefined;
  if (ended?.counted) release(ended.counted);
  ended?.probation?.cancel();
  return ended;
}
