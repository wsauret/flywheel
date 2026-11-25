/**
 * The events of a watch (ARCH-TOOLS-059, PI-AGENT-136): the complete lines of
 * a command's log, read from a byte position, batched, cut, and rate limited.
 * The stream owns no timer and no file: its owner feeds it the log's bytes and
 * ticks it with the time, so a test drives it with a clock of its own.
 */
import { sanitizeExternalText } from "../../../../../infra/substrate/output/control-characters.js";

/** The limits of one watch, as the approved design states them. */
export const WATCH_LIMITS = {
  /** Lines that arrive within this time of the first line of a batch form one event. */
  batchMs: 200,
  /** A line longer than this is cut, with a marker. */
  lineChars: 500,
  /** An event longer than this is cut, with a marker. */
  eventChars: 3_000,
  /** The burst of events that pass at once. */
  burst: 10,
  /** After the burst, one event passes this often. */
  refillMs: 2_000,
  /** A source that stays over the limit longer than this is stopped. */
  stopAfterMs: 30_000,
} as const;

/** The deadline of a watch whose agent gives none, in seconds. */
export const WATCH_DEFAULT_DEADLINE_SEC = 300;

const TRUNCATED = "...(truncated)";
const NEWLINE = 0x0a;
/** The bytes of an unfinished line that the stream keeps: enough for the
 *  first `lineChars` characters of any UTF-8 text, so a line with no end
 *  cannot grow without a bound. */
const PARTIAL_LINE_BYTES = WATCH_LIMITS.lineChars * 4;

/** One event that passed the rate limit. `position` is the byte offset of the
 *  log where its last line ends, which is the event's key. `dropped` counts the
 *  events that the limit dropped since the last delivered one. */
export interface WatchEvent {
  readonly text: string;
  readonly position: number;
  readonly dropped: number;
}

/** What the stream reports when a source stays over the limit too long:
 *  every event it dropped since it went over the limit, and for how long. */
export interface WatchOverLimit {
  readonly dropped: number;
  readonly overLimitMs: number;
}

/** The rate limit of a watch as a successor takes it over at a handover, so
 *  a handover neither grants a new burst nor forgets the drops it owes the
 *  agent or the time the source has been over the limit. Times are epoch
 *  milliseconds, the clock the owner ticks the stream with. */
export interface WatchLimiterState {
  readonly tokens: number;
  readonly refilledAtMs?: number;
  /** Dropped events that no delivered event has counted yet. */
  readonly pendingDropped: number;
  readonly overLimitSinceMs?: number;
  readonly droppedSinceOverLimit: number;
  readonly lastDropAtMs?: number;
}

/** How a push groups lines. `live`: lines that arrive within `batchMs` form
 *  one event, cut at `eventChars`. `backlog`: lines that waited in the log,
 *  read at once after a hold or a handover, form events of at most
 *  `eventChars` each, so none is cut away. */
export type WatchPushMode = "live" | "backlog";

export interface WatchStreamInput {
  /** The byte offset of the log where the stream starts: 0 for a new watch,
   *  the last settled position for a successor after a handover. */
  readonly position: number;
  /** The rate limit a predecessor handed over. Absent: a full burst. */
  readonly limiter?: WatchLimiterState;
  /** Delivers one event. False when the owner refused it: then the stream
   *  keeps the event's lines and its position, and counts nothing. */
  readonly deliver: (event: WatchEvent) => boolean;
  /** Called once, when the source stays over the limit longer than `stopAfterMs`. */
  readonly overLimit: (evidence: WatchOverLimit) => void;
}

/** Cuts `text` at `max` UTF-16 units, never inside a surrogate pair. */
function cutAt(text: string, max: number): string {
  if (text.length <= max) return text;
  const code = text.charCodeAt(max - 1);
  return text.slice(0, code >= 0xd800 && code <= 0xdbff ? max - 1 : max);
}

function cutLine(line: string): string {
  return line.length > WATCH_LIMITS.lineChars ? `${cutAt(line, WATCH_LIMITS.lineChars)}${TRUNCATED}` : line;
}

/** A line as the event shows it: the text after its last carriage return, as
 *  a terminal shows a progress line, with control characters removed and its
 *  spaces kept, cut at `lineChars`. */
function cleanLine(bytes: Uint8Array): string {
  const text = new TextDecoder().decode(bytes).replace(/\r$/, "");
  return cutLine(sanitizeExternalText(text.slice(text.lastIndexOf("\r") + 1)));
}

interface Batch {
  readonly lines: string[];
  /** The length of the lines joined with newlines. */
  chars: number;
  end: number;
  readonly startedAt: number;
  /** A line was left out because the event was full. */
  overflow: boolean;
}

function eventText(batch: Batch): string {
  const text = batch.lines.join("\n");
  return text.length > WATCH_LIMITS.eventChars || batch.overflow ? `${cutAt(text, WATCH_LIMITS.eventChars)}\n${TRUNCATED}` : text;
}

export function createWatchStream(input: WatchStreamInput) {
  /** Where the bytes fed so far end. */
  let readPosition = input.position;
  /** Where the unfinished line starts. */
  let lineStart = input.position;
  /** Where the last event that passed or was dropped ends. */
  let settledPosition = input.position;
  let partial: Uint8Array[] = [];
  let partialBytes = 0;
  let batch: Batch | undefined;
  const limiter = input.limiter;
  let tokens = limiter?.tokens ?? WATCH_LIMITS.burst;
  let refilledAt = limiter?.refilledAtMs;
  let dropped = limiter?.pendingDropped ?? 0;
  let droppedSinceOverLimit = limiter?.droppedSinceOverLimit ?? 0;
  let overLimitSince = limiter?.overLimitSinceMs;
  let lastDropAt = limiter?.lastDropAtMs;
  let stopped = false;
  let delivered = 0;

  const refill = (now: number): void => {
    refilledAt ??= now;
    const earned = Math.floor((now - refilledAt) / WATCH_LIMITS.refillMs);
    if (earned <= 0) return;
    tokens = Math.min(WATCH_LIMITS.burst, tokens + earned);
    refilledAt += earned * WATCH_LIMITS.refillMs;
  };

  /** Sends or drops the open batch. False only when the owner refused it,
   *  which leaves the batch open. */
  const close = (now: number): boolean => {
    const open = batch;
    if (open === undefined) return true;
    if (!stopped) {
      refill(now);
      if (tokens > 0) {
        if (!input.deliver({ text: eventText(open), position: open.end, dropped })) return false;
        tokens -= 1;
        delivered += 1;
        dropped = 0;
        if (lastDropAt !== undefined && now - lastDropAt > WATCH_LIMITS.refillMs * 3) overLimitSince = undefined;
      } else {
        dropped += 1;
        lastDropAt = now;
        if (overLimitSince === undefined) {
          overLimitSince = now;
          droppedSinceOverLimit = 0;
        }
        droppedSinceOverLimit += 1;
        if (now - overLimitSince > WATCH_LIMITS.stopAfterMs) {
          stopped = true;
          input.overLimit({ dropped: droppedSinceOverLimit, overLimitMs: now - overLimitSince });
        }
      }
    }
    batch = undefined;
    settledPosition = open.end;
    return true;
  };

  /** Adds one complete line. False when a batch it had to close was refused. */
  const addLine = (bytes: Uint8Array, end: number, now: number, mode: WatchPushMode): boolean => {
    if (batch !== undefined && mode === "live" && now - batch.startedAt >= WATCH_LIMITS.batchMs && !close(now)) return false;
    // A stopped stream delivers nothing, so it only moves its position.
    if (stopped) {
      settledPosition = end;
      return true;
    }
    if (batch !== undefined && mode === "live" && batch.chars >= WATCH_LIMITS.eventChars) {
      // The event is full: the line adds only its position and the marker,
      // and is never decoded.
      batch.end = end;
      batch.overflow = true;
      return true;
    }
    const line = cleanLine(bytes);
    if (batch !== undefined && mode === "backlog" && batch.lines.length > 0 && batch.chars + 1 + line.length > WATCH_LIMITS.eventChars && !close(now)) return false;
    batch ??= { lines: [], chars: 0, end, startedAt: now, overflow: false };
    batch.chars += (batch.lines.length > 0 ? 1 : 0) + line.length;
    batch.lines.push(line);
    batch.end = end;
    return true;
  };

  return {
    /** Feeds the bytes of the log that follow the bytes fed before. When the
     *  owner refuses an event on the way, the stream stops at the start of
     *  the line it could not add, and its read position goes back there, so
     *  the owner reads those bytes again later. */
    push(bytes: Uint8Array, now: number, mode: WatchPushMode = "live"): void {
      let start = 0;
      for (let index = bytes.indexOf(NEWLINE); index >= 0; index = bytes.indexOf(NEWLINE, start)) {
        const head = bytes.subarray(start, index);
        const line = partialBytes > 0 ? Buffer.concat([...partial, head.subarray(0, Math.max(0, PARTIAL_LINE_BYTES - partialBytes))]) : head;
        const end = readPosition + index + 1;
        partial = [];
        partialBytes = 0;
        if (!addLine(line, end, now, mode)) {
          readPosition = lineStart;
          return;
        }
        lineStart = end;
        start = index + 1;
      }
      const rest = bytes.subarray(start);
      if (partialBytes < PARTIAL_LINE_BYTES && rest.length > 0) {
        const kept = rest.subarray(0, PARTIAL_LINE_BYTES - partialBytes);
        partial.push(kept.slice());
        partialBytes += kept.length;
      }
      readPosition += bytes.length;
    },
    /** Sends the batch whose window has passed. */
    tick(now: number): void {
      if (batch !== undefined && now - batch.startedAt >= WATCH_LIMITS.batchMs) close(now);
    },
    /** Sends or drops the open batch now, whatever its window, as the watch
     *  ends. False when the owner refused it. */
    finish: (now: number): boolean => close(now),
    /** The byte offset where the next unread byte starts. */
    readPosition: () => readPosition,
    /** Whether complete lines wait in a batch that was neither sent nor
     *  dropped, so they end after `settledPosition`. */
    hasOpenBatch: () => batch !== undefined,
    /** The offset where the last event that passed or was dropped ends: the
     *  place a successor continues from. */
    settledPosition: () => settledPosition,
    delivered: () => delivered,
    /** Dropped events that no delivered event counted yet. */
    pendingDropped: () => dropped,
    limiter: (): WatchLimiterState => ({
      tokens,
      pendingDropped: dropped,
      droppedSinceOverLimit,
      ...(refilledAt === undefined ? {} : { refilledAtMs: refilledAt }),
      ...(overLimitSince === undefined ? {} : { overLimitSinceMs: overLimitSince }),
      ...(lastDropAt === undefined ? {} : { lastDropAtMs: lastDropAt }),
    }),
    /** The unfinished last line, cut, for the notice that ends the watch. */
    unfinished: (): string => partialBytes > 0 ? cleanLine(Buffer.concat(partial)) : "",
  };
}
