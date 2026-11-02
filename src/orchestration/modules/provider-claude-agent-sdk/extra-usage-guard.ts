import { createHash } from "node:crypto";
import { Clock, Deferred, Effect, Exit, Option } from "effect";
import { DebugLog } from "../../../infra/debug-log.js";
import type { AccessProviderCandidate } from "../../../infra/llm/access-provider.js";
import type { NotificationOccurrence } from "../../../infra/notification-episode.js";
import { QuotaExhaustedError } from "../../agent-runtime/llm/errors.js";
import { SAFE_RECHECK_MS } from "../../agent-runtime/llm/provider-availability.js";
import type { UsageWindows } from "./account-usage.js";
import { accountLimitResetAtMs, quotaFailure, type QuotaMark, type SdkInput } from "./sdk-events.js";

/** Whether an account may serve requests from Claude extra usage. */
export type ExtraUsage = "refuse" | "allow";

/** The included mode refuses extra usage. Paid rollover modes require consent; a usage-only account's metered
 *  route uses its normal billing. Both allow the engine's paid usage reports. */
export function extraUsageOf(spendMode: AccessProviderCandidate["spendMode"]): ExtraUsage {
  return spendMode === "included" ? "refuse" : "allow";
}

/** The evidence on which the guard stopped an account. */
export type ExtraUsageEvidence =
  /** The CLI reported that the account served a response from extra usage. */
  | "extra-usage"
  /** The CLI's report did not show that included usage served the response: it named no usage window, or the login's
   *  reports never state extra usage. */
  | "unconfirmed"
  /** The CLI sent no report for its first complete response before its turn ended or the bridge waited for it. A
   *  login that is not a Claude subscription, such as a Console login that bills the API, gets no report. */
  | "unreported";

/** One stop of the guard, for the person's notice. */
export interface ExtraUsageStop {
  readonly evidence: ExtraUsageEvidence;
  /** When the account's hold ends, in epoch ms, or undefined when the account's row did not take the hold. */
  readonly heldUntilMs: number | undefined;
}

/** The guard's decision to stop the account: its evidence, its hold, and the error that ends the query and fails the
 *  requests that the hold refuses. */
export interface GuardStop extends ExtraUsageStop {
  readonly error: Error;
}

/** The CLI's usage report after a response. */
type UsageReport = Extract<SdkInput, { readonly kind: "rate-limit" }>;

/** How long a query that owes the usage report of its first complete response waits for it before it goes on or
 *  stops. The CLI emits the report within milliseconds of the response's end. */
const REPORT_WAIT_MS = 2_000;

/**
 * The usage reports of one query (bridge rule 14), the one reader of the CLI's rate-limit events. Each report that
 * names the account's plan windows becomes the account's latest usage reading. The CLI reads the service's usage
 * headers when a response ends, after the stream that the adapter read, and emits a rate-limit event after the first
 * complete response of its process and then only when its reading changes (CLI 2.1.295). A response that a cut ended
 * gets no report. So the guard cannot stop the response that first shows extra usage: that response is complete and
 * billed when the report arrives, and the adapter keeps it. With extra usage refused, the guard stops the account at
 * once on any evidence that a response was not served from included usage: it marks the account's quota row, which
 * every process reads before it dispatches a request on the account, tells the person, and returns the stop that
 * ends the query. A query that owes the report of its first complete response neither goes on nor stops until
 * `settle` waited for that report and read it.
 */
export interface UsageReports {
  /** When the account's whole allowance that the last report rejected resets, for the error map. */
  readonly limitResetAtMs: number | undefined;
  /** Called by the reader of the query's stream as each SDK input arrives, before the actor reads it, and with
   *  undefined once the stream ended, so that `settle` sees the first report while the actor waits. */
  arrived(input: SdkInput | undefined): void;
  /** Reads one SDK input of the query. */
  read(input: SdkInput): GuardStop | undefined;
  /** A response of the query ended complete (bridge rule 1). */
  served(): void;
  /** Decides a report that the query owes before it goes on or stops: it waits up to `REPORT_WAIT_MS` for the first
   *  report and reads it, or stops the account when none came. `read` then skips that report's copy on the stream.
   *  Concurrent calls share one decision, and once the guard stopped, every call returns that one stop. */
  settle(): Effect.Effect<GuardStop | undefined>;
}

export interface UsageReportsConfig {
  readonly extraUsage: ExtraUsage;
  /** Whether the CLI's reports of the login state extra usage (`CliLogin`). */
  readonly reportsExtraUsage: boolean;
  readonly sessionId: string;
  readonly markQuotaExhausted: QuotaMark;
  /** Tells the person about a stop. It returns at once and never fails. */
  readonly onStop: (stop: ExtraUsageStop) => void;
  /** Records the account's plan windows that a report names (`UsageReadings`). It returns at once and never fails. */
  readonly recordUsage: (windows: UsageWindows) => void;
}

/** The stop that holds an account in one bridge (bridge rule 14): until it ends on the bridge's clock, every request
 *  fails at once with the stop's error and starts no CLI, even when the account's row did not take the mark. A stop
 *  that names no end holds the account as long as an unconfirmed quota mark does. */
export interface AccountHold {
  hold(stop: GuardStop): Effect.Effect<void>;
  /** The error of the hold in force, or undefined when none holds the account. */
  refusal(): Effect.Effect<Error | undefined>;
}

export function accountHold(): AccountHold {
  let held: { readonly untilMs: number; readonly error: Error } | undefined;
  return {
    hold: (stop) => Effect.gen(function* () { held = { untilMs: stop.heldUntilMs ?? (yield* Clock.currentTimeMillis) + SAFE_RECHECK_MS, error: stop.error }; }),
    refusal: () => Effect.gen(function* () { return held !== undefined && (yield* Clock.currentTimeMillis) < held.untilMs ? held.error : undefined; }),
  };
}

const STOP_TEXT = {
  "extra-usage": "The Claude account served a request from extra usage, and paid use is off for this account",
  unconfirmed: "The Claude CLI's usage report did not show that included usage served the request, and paid use is off for this account",
  unreported: "The Claude CLI sent no usage report for the request, so it may have been billed outside included usage, and paid use is off for this account",
} as const satisfies { readonly [Evidence in ExtraUsageEvidence]: string };

export function usageReports(config: UsageReportsConfig): UsageReports {
  let limitResetAtMs: number | undefined;
  let served = false;
  let reported = false;
  /** The guard's one stop: the account is marked and the person told once, and every later decision returns it. */
  let stopped: GuardStop | undefined;
  /** The first report on the query's stream that states usage, or undefined once the stream ended without one. */
  const first = Deferred.makeUnsafe<UsageReport | undefined>();
  /** The report that `settle` read, whose copy on the query's stream arrives later. */
  let settled: UsageReport | undefined;
  const guarded = config.extraUsage === "refuse";

  const stop = (evidence: ExtraUsageEvidence, resetsAtMs: number | undefined): GuardStop => {
    if (stopped !== undefined) return stopped;
    const error = quotaFailure(STOP_TEXT[evidence], () => config.markQuotaExhausted(resetsAtMs));
    const heldUntilMs = error instanceof QuotaExhaustedError ? error.quotaObservation?.exhaustion.resetsAtMs : undefined;
    stopped = { evidence, heldUntilMs, error };
    config.onStop({ evidence, heldUntilMs });
    return stopped;
  };
  /** The query's first complete response still waits for its report while extra usage is refused. */
  const owed = (): boolean => guarded && served && !reported && stopped === undefined;

  const readReport = (input: UsageReport): GuardStop | undefined => {
    limitResetAtMs = accountLimitResetAtMs(input.info);
    if (input.windows !== undefined) config.recordUsage(input.windows);
    // The CLI omits the extra-usage state from the reports of a usage-based login, so none of them confirms included usage.
    const billing = input.billing === "included" && !config.reportsExtraUsage ? "unconfirmed" : input.billing;
    DebugLog.record({ type: "provider.claude_sdk.rate_limit", notable: input.info.status !== "allowed" || billing !== "included", payload: {
      sessionId: config.sessionId, ...input.info, billing, usageWindows: Object.keys(input.windows ?? {}).length,
    } });
    // The report of a request that the service refused without its usage headers states no usage: the request spent
    // none, and the request fails as the service's own answer, as on native. It is not the report that a served
    // response owes.
    if (billing === "refused") return undefined;
    reported = true;
    if (!guarded || stopped !== undefined || billing === "included") return undefined;
    // A report of extra usage holds the account until its included usage resets, the window that the report names.
    return stop(billing, billing === "extra-usage" && input.info.resetsAt !== undefined ? input.info.resetsAt * 1000 : undefined);
  };

  return {
    get limitResetAtMs() { return limitResetAtMs; },
    read(input) {
      if (input.kind === "rate-limit") return input === settled ? undefined : readReport(input);
      // The report precedes the turn result on the CLI's stream.
      if (input.kind === "turn-result" && !input.result.isError && owed()) return stop("unreported", undefined);
      return undefined;
    },
    arrived(input) {
      if (input === undefined || (input.kind === "rate-limit" && input.billing !== "refused")) Deferred.doneUnsafe(first, Exit.succeed(input));
    },
    served() { served = true; },
    settle: () => Effect.gen(function* () {
      if (!owed()) return stopped;
      const report = Option.getOrUndefined(yield* Deferred.await(first).pipe(Effect.timeoutOption(REPORT_WAIT_MS)));
      // Concurrent callers wait for the same report, and the first to wake decides it: the stream's own reader, or an
      // earlier waiter, that already decided leaves every later one the same answer.
      if (!owed()) return stopped;
      if (report === undefined) return stop("unreported", undefined);
      settled = report;
      return readReport(report);
    }),
  };
}

/** The login that a notice names: its provider, its instance, the config directory that holds it in one profile, and
 *  the name that the person knows it by. */
export interface NoticeAccount {
  readonly providerId: string;
  readonly instanceId: string;
  readonly configDir: string;
  readonly name: string;
}

const ALLOW_TEXT = "To allow extra usage, turn on paid use for this account in Provider Settings.";

/**
 * The person's notice of one stop. The Claude CLI says "You're now using extra usage" when an account starts to use
 * it; this notice uses the same term and also says what Flywheel did and where the person allows it. One login has
 * one notice: raising it while it is active changes nothing, so repeated stops do not repeat it. The login of the
 * same account in another profile is another login with its own notice, as each profile has its own paid-use
 * decision. Its source id is a
 * digest, so it holds no account data.
 */
export function extraUsageNotice(stop: ExtraUsageStop, account: NoticeAccount): NotificationOccurrence {
  const digest = createHash("sha256").update(`${account.providerId}\0${account.instanceId}\0${account.configDir}`).digest("hex");
  const message = stop.evidence === "extra-usage"
    ? `${account.name} served a Claude request from extra usage. Paid use is off for this account, so Flywheel stopped using it until its included usage resets. ${ALLOW_TEXT}`
    : `The Claude engine did not show that ${account.name} served a request from included usage, so the request can have used extra usage. `
      + `Paid use is off for this account, so Flywheel stopped using it for a few minutes. ${ALLOW_TEXT}`;
  return { sourceId: `claude-extra-usage:${digest}`, title: "Claude extra usage stopped", message, severity: "alert", action: { kind: "open-auth-provider", providerId: account.providerId } };
}
