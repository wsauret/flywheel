import { randomUUID } from "node:crypto";
import { Deferred, Effect } from "effect";
import type { HostEnvironment } from "../../agent-runtime/llm/claude-reminders.js";
import { cliRewritesImage } from "./cli-images.js";
import { identityDifference, sameCliValue, type CliMessage, type CliView, type PlacedReminder, type QueryIdentity } from "./cli-view.js";
import { inPlaceSystemPrompt, type CliFrame, type LaunchedQuery } from "./query-launcher.js";
import type { StartPlan } from "./request-plan.js";
import type { StepGate } from "./step-gate.js";
import { cliAssistantMessage, cliKeyOrder } from "./transcript.js";

// In-place rotation. A running CLI takes a new conversation state without a new process:
// `set_model` with the query's own model and a `system_prompt` replaces the prompt, `rewind_conversation` cuts the
// conversation before one user row, and replay frames add rows without a model request. A user frame with
// `shouldQuery: false` joins the conversation when the CLI takes it from its queue, and the CLI answers it with a turn
// result that names the frame. An assistant frame joins at once. The bridge therefore writes one user frame, waits
// for its answer, and only then writes the next frame, so that no assistant row overtakes its user row.
//
// The CLI states a reminder only as its own attachment row, which it writes after the user row that starts a turn and
// which no frame adds. A conversation's opening row holds the opening reminders: the environment, the model, and the
// date. A reload that cuts at that row and replays it with `shouldQuery: false` therefore leaves the CLI with no
// reminder, and the CLI states all of them again at the next pushed message, in the wrong place. So the bridge writes
// a replayed opening row as a turn start instead. The CLI then writes the row and its own opening reminders, as it did
// for the conversation's first request and as a rotation transcript writes them, and the step gate refuses the turn's
// model step (`replayed-turn-start`), so the turn sends nothing and ends with a result that names the row.
//
// The CLI states those opening reminders from its own process, where a rotation transcript states them from canonical
// history. A transcript states the canonical environment with the engine's shell (`engineShell`), and the engine reads
// the same facts and names the same shell, so equal canonical facts give equal engine statements on every platform. A
// reload therefore replays an opening row only when the date is today's, the model is the bridge's one model, and the
// canonical environment of the directory now (`environmentFacts`) equals the row's. A git state that changed during
// the step, or a shell that differs, starts a new process instead, whose transcript states the canonical reminders.

/** The rotation triggers that a reload can serve. Every other trigger has no live CLI, a turn in flight, or a launch
 *  value that the CLI fixes at start. */
const RELOADABLE: ReadonlySet<StartPlan["trigger"]["kind"]> = new Set(["history", "tail", "result-ids", "results-with-input", "undeliverable-result", "poisoned", "identity"]);

/** What a live query holds, as the reload planner reads it. */
export interface HeldConversation {
  readonly identity: QueryIdentity;
  readonly messages: readonly CliMessage[];
  /** The CLI row id of each message, by index, that the bridge wrote as a user row: a push, a replay frame, or a
   *  transcript row. A row that the CLI wrote itself, such as a delivered tool result, has none. */
  readonly rows: ReadonlyMap<number, string>;
  /** The CLI holds exactly `messages`: the query is idle and no refused step added anything. */
  readonly exact: boolean;
}

/** Why a rotation starts a new process instead of a reload. */
type ColdReason =
  | "trigger"
  /** A launch value other than the system prompt changed. */
  | "identity"
  /** The new system prompt is not one text that the CLI keeps as one block: `inPlaceSystemPrompt`. */
  | "system-tiers"
  /** The tail must be the last transcript row (an image that the CLI would rewrite). */
  | "row-delivery"
  /** No user row that the bridge wrote starts a turn at or before the first change. */
  | "no-row"
  /** A row to replay holds a reminder that the CLI would not state itself at a replayed opening turn: a reminder of a
   *  later message, a partial opening set, a date other than today's, or an environment other than the canonical
   *  environment now, which the engine would state in its place. */
  | "replayed-reminder"
  /** A user row to replay holds an image that the CLI would rewrite. */
  | "replayed-image";

export type ReloadDecision =
  | {
    readonly kind: "reload";
    /** The text that replaces the system prompt, when it changed. */
    readonly systemPrompt: string | undefined;
    /** The user row before which the CLI cuts its conversation, and the newest user row that the bridge wrote. A
     *  reload that only appends rows to an exact copy cuts nothing. */
    readonly cut: { readonly row: string; readonly lastSeen: string } | undefined;
    /** The index in the request of the first replayed message. */
    readonly from: number;
    readonly replay: readonly CliMessage[];
    /** The first replayed row is the conversation's opening row with its opening reminders, which the bridge writes
     *  as a turn start so that the CLI states them itself. */
    readonly opening: boolean;
  }
  | { readonly kind: "cold"; readonly reason: ColdReason };

/** What the CLI states at an opening turn now: the local date, and the canonical environment of a working directory
 *  (`environmentFacts`), which the engine states with its own shell exactly as a transcript does. */
export interface OpeningStatement {
  readonly today: string;
  environment(cwd: string): HostEnvironment;
}

/**
 * Decides whether a rotation that `planRequest` started can reload the live CLI instead (rule 13). The request after
 * a reload must equal the request after a cold rotation, so the planner reloads only when frames can give the CLI
 * the same rows as a transcript: the cut is at a user row that starts a turn (the CLI refuses a cut inside a tool
 * call), no replayed row holds an image that the CLI rewrites, and only the system prompt of the launch values
 * changed, to one untiered text. A replayed reminder is allowed only where the CLI states it itself: the opening
 * reminders of a replayed opening row, when they are what the CLI states now (`OpeningStatement`). An idle copy that the
 * request extends takes the new rows after it, and every other copy is cut at the last turn start before the first
 * change, which also removes what an interrupt or a refused step added. The conversation of an agent of a workflow has no turn
 * start but its opening row, so each of its rotations cuts there.
 */
export function planReload(held: HeldConversation, view: CliView, start: StartPlan, statement: OpeningStatement): ReloadDecision {
  const cold = (reason: ColdReason): ReloadDecision => ({ kind: "cold", reason });
  if (start.delivery === "row") return cold("row-delivery");
  if (!RELOADABLE.has(start.trigger.kind)) return cold("trigger");
  if (identityDifference({ ...held.identity, systemPrompt: view.identity.systemPrompt }, view.identity) !== undefined) return cold("identity");
  let systemPrompt: string | undefined;
  if (!sameCliValue(held.identity.systemPrompt, view.identity.systemPrompt)) {
    systemPrompt = inPlaceSystemPrompt(view.identity.systemPrompt);
    if (systemPrompt === undefined) return cold("system-tiers");
  }
  let common = 0;
  while (common < held.messages.length && common < start.history.length && sameCliValue(held.messages[common], start.history[common])) common += 1;
  const cut = held.exact && common === held.messages.length ? undefined : turnStart(held, common);
  if (cut === null) return cold("no-row");
  const from = cut?.index ?? common;
  const replayed = start.reminders.filter(({ message }) => message >= from);
  const opening = replayed.length > 0;
  if (opening && !(from === 0 && openingReminders(replayed, statement, view.identity.cwd))) return cold("replayed-reminder");
  const replay = start.history.slice(from);
  if (replay.some((message) => message.role === "user" && message.content.some((block) => block.type === "image" && cliRewritesImage(block.source)))) {
    return cold("replayed-image");
  }
  return { kind: "reload", systemPrompt, cut: cut === undefined ? undefined : { row: cut.row, lastSeen: cut.lastSeen }, from, replay, opening };
}

/**
 * Whether `reminders` are what the CLI states now at the opening turn of a conversation in `cwd` that it holds nothing
 * of: one environment, one model, and one first date reminder, all on message 0. The date must be today's, and the
 * environment must equal the canonical environment now. A bridge serves one model, so its reminder cannot differ.
 */
function openingReminders(reminders: readonly PlacedReminder[], statement: OpeningStatement, cwd: string): boolean {
  const kinds = reminders.map(({ reminder }) => reminder.kind).toSorted();
  if (!sameCliValue(kinds, ["date", "environment", "model"]) || reminders.some(({ message }) => message !== 0)) return false;
  const environment = statement.environment(cwd);
  return reminders.every(({ reminder }) => reminder.kind === "date" ? reminder.date === statement.today && !reminder.changed
    // A reminder for an agent without the shell states no shell; the engine names its own shell all the same.
    : reminder.kind !== "environment" || sameCliValue({ shell: environment.shell, ...reminder }, environment));
}

/** The last message at or before `index` that is a user row the bridge wrote and that holds no tool result, with the
 *  newest user row that the bridge wrote; null when no such row exists. */
function turnStart(held: HeldConversation, index: number) {
  const lastSeen = held.rows.get(Math.max(-1, ...held.rows.keys()));
  for (let at = Math.min(index, held.messages.length - 1); at >= 0; at -= 1) {
    const row = held.rows.get(at);
    const message = held.messages[at];
    if (row !== undefined && lastSeen !== undefined && message?.role === "user" && !message.content.some((block) => block.type === "tool_result")) {
      return { index: at, row, lastSeen };
    }
  }
  return null;
}

/** The replay frames of a reload, in order, with the id of each user row. Each block keeps the key order of a
 *  transcript row, and a thinking-only answer gets the transcript's carrier, so the CLI holds what a resume holds. The
 *  opening row of an opening reload is a turn start; every other user row joins without a turn. */
export function replayFrames(decision: Extract<ReloadDecision, { kind: "reload" }>, model: string, newUuid: () => string = randomUUID): readonly CliFrame[] {
  return decision.replay.map((message, offset): CliFrame => {
    const uuid = newUuid();
    if (message.role === "assistant") {
      return { type: "assistant", uuid, session_id: "", parent_tool_use_id: null, message: cliAssistantMessage(message, decision.from + offset, model) };
    }
    const content = message.content.map(cliKeyOrder);
    if (decision.opening && offset === 0) return { type: "user", uuid, parent_tool_use_id: null, message: { role: "user", content } };
    return { type: "user", uuid, shouldQuery: false, parent_tool_use_id: null, message: { role: "user", content } };
  });
}

/** The turn results that answer replayed user rows. The bridge's SDK reader hands each result here first, and a
 *  result that answers a replayed row never reaches the bridge's turn accounting. */
export interface ReplayAcks {
  /** Registers the row `uuid` before its frame is written, and returns the wait for its answer. */
  expect(uuid: string): Effect.Effect<void, Error>;
  /** Takes the turn result that names `uuid`, when it answers a replayed row. */
  settle(uuid: string | undefined): boolean;
  /** Fails every wait, because the CLI's message stream ended. */
  end(): void;
}

export function createReplayAcks(): ReplayAcks {
  const waiting = new Map<string, Deferred.Deferred<void, Error>>();
  return {
    expect(uuid) {
      const answered = Deferred.makeUnsafe<void, Error>();
      waiting.set(uuid, answered);
      return Deferred.await(answered);
    },
    settle(uuid) {
      const answered = uuid === undefined ? undefined : waiting.get(uuid);
      if (uuid === undefined || answered === undefined) return false;
      waiting.delete(uuid);
      Deferred.doneUnsafe(answered, Effect.void);
      return true;
    },
    end() {
      for (const answered of waiting.values()) Deferred.doneUnsafe(answered, Effect.fail(new Error("The Claude CLI ended before it took a replayed row")));
      waiting.clear();
    },
  };
}

/** The step of a reload that failed. The bridge then rotates cold and records the step. */
export class ReloadFailure extends Error {
  constructor(readonly step: "interrupt" | "system-prompt" | "rewind" | "replay", readonly reason: string) {
    super(`The in-place rotation failed at ${step}: ${reason}`);
  }
}

/**
 * Runs a reload on a CLI that runs no turn of Flywheel's: the prompt change, the cut, then the replay. A cut waits
 * while the CLI still ends the turn that the bridge already ended. The step gate refuses the model step of a replayed
 * opening turn. The caller pushes the request's tail afterwards.
 */
export function runReload(launched: LaunchedQuery, acks: ReplayAcks, stepGate: Pick<StepGate, "arm">, write: (frame: CliFrame) => void, decision: Extract<ReloadDecision, { kind: "reload" }>, frames: readonly CliFrame[]) {
  return Effect.gen(function* () {
    if (decision.systemPrompt !== undefined) {
      yield* launched.setSystemPrompt(decision.systemPrompt).pipe(Effect.mapError((error) => new ReloadFailure("system-prompt", error.name)));
    }
    if (decision.cut !== undefined) {
      const outcome = yield* launched.rewind(decision.cut.row, decision.cut.lastSeen).pipe(Effect.mapError((error) => new ReloadFailure("rewind", error.name)));
      if (!outcome.rewound) return yield* Effect.fail(new ReloadFailure("rewind", outcome.reason));
    }
    for (const frame of frames) {
      if (frame.type === "assistant") {
        write(frame);
        continue;
      }
      const answered = acks.expect(frame.uuid);
      if (frame.shouldQuery !== false) stepGate.arm("replayed-turn-start");
      write(frame);
      yield* answered.pipe(Effect.mapError((error) => new ReloadFailure("replay", error.name)));
    }
  });
}
