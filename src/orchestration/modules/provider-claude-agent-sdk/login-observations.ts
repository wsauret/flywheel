import { RouteUnavailableError } from "../../agent-runtime/llm/errors.js";
import { classifyProviderFailure } from "../../agent-runtime/llm/provider-failure.js";
import type { ExternalAccount, ExternalLoginQuestion, LoginWaitAnswer } from "../../../infra/llm/access-provider.js";
import { DebugLog } from "../../../infra/debug-log.js";

/** One Claude login: the config directory that holds it and the account it holds there. */
export interface LoginKey {
  readonly configDir: string;
  readonly accountId: string;
}

/** How the last request of a login ended, as far as the login and its CLI are concerned. */
export type RequestOutcome = "served" | "login-rejected" | "program-exited" | "program-cannot-start";

/** The failure of a login's last request that the person must know about. */
export type LoginFailure = Exclude<RequestOutcome, "served">;

/**
 * What this process observed about the Claude logins that no file of the engine shows: how each login's last request
 * ended, and the plan that the engine named for each login. The auth view reads it with no launch, and `observe` tells it when an answer changed. It holds no token and no content.
 */
export interface LoginObservations {
  recordRequest(login: LoginKey, outcome: RequestOutcome): void;
  /** A new login of the account: its last request no longer states anything about it. */
  clearRequest(login: LoginKey): void;
  recordPlan(login: LoginKey, plan: string): void;
  /** The login ended: its waiting requests end declined, and its question, last request, and plan are gone. Unlike
   *  `clearRequest`, nothing renews; unlike a declined answer, nothing of the login stays. */
  forget(login: LoginKey): void;
  /** How the login's last request in this process ended, or undefined when none ended since the process or the
   *  login started. */
  outcome(login: LoginKey): RequestOutcome | undefined;
  failure(login: LoginKey): LoginFailure | undefined;
  plan(login: LoginKey): string | undefined;
  /** Calls `listener` after an answer changed. Returns the unsubscribe. */
  observe(listener: () => void): () => void;
  awaitLogin(authDir: string, account: ExternalAccount, signal: AbortSignal): Promise<LoginWaitAnswer>;
  loginQuestions(): readonly ExternalLoginQuestion[];
  answerLogin(questionId: string, answer: LoginWaitAnswer): ExternalLoginQuestion | undefined;
  settleLogin(questionId: string, answer: LoginWaitAnswer): void;
}

interface LoginEpisode {
  readonly id: string;
  readonly authDir: string;
  readonly account: ExternalAccount;
  phase: "asking" | "logging-in" | "declined";
  readonly waiters: Set<(answer: LoginWaitAnswer) => void>;
}

/** What the account row, its notice, and the request that met it say about an engine that cannot start. It names no
 *  account, because a notice must hold no account subject data (ARCH-BOUNDARIES-015). */
export const ENGINE_CANNOT_START = "The Claude engine that ships with Flywheel cannot start on this machine. The engine is missing, is not executable, "
  + "or is built for another C library. Reinstall Flywheel, or run bun install in a source checkout.";

/** The failure of a request whose engine could not start. Another start fails the same way, so the request goes to
 *  the next route at once, as for a route that is down. */
export class EngineCannotStartError extends RouteUnavailableError {
  constructor() {
    super(ENGINE_CANNOT_START);
  }
}

/** The login failure that one stopped query states: an engine that could not start, a refused login when its error
 *  is the provider's refusal of the credential (a 401 or 403, or the CLI's `authentication_failed`), else an exit of
 *  the CLI while a request was open. */
export function loginFailure(error: Error | undefined, exitedDuringRequest: boolean): LoginFailure | undefined {
  if (error instanceof EngineCannotStartError) return "program-cannot-start";
  if (error !== undefined && classifyProviderFailure(error)._tag === "AuthFailure") return "login-rejected";
  return exitedDuringRequest ? "program-exited" : undefined;
}

function keyOf({ configDir, accountId }: LoginKey): string {
  return `${configDir}\0${accountId}`;
}

function failureOf(outcome: RequestOutcome | undefined): LoginFailure | undefined {
  return outcome === "served" ? undefined : outcome;
}

export function createLoginObservations(): LoginObservations {
  const outcomes = new Map<string, RequestOutcome>();
  const plans = new Map<string, string>();
  const listeners = new Set<() => void>();
  const episodes = new Map<string, LoginEpisode>();
  const changed = (): void => {
    for (const listener of listeners) listener();
  };
  const record = (episode: LoginEpisode, decision: "asking" | "logging-in" | "forgotten" | LoginWaitAnswer): void => {
    DebugLog.record({ type: "provider.claude_sdk.login.condition", payload: { questionId: episode.id, decision, waiters: episode.waiters.size } });
  };
  const settle = (episode: LoginEpisode, answer: LoginWaitAnswer, outcome?: RequestOutcome): void => {
    record(episode, answer);
    if (answer === "renewed") {
      episodes.delete(keyOf(episode.account));
      if (outcome === undefined) outcomes.delete(keyOf(episode.account));
      else outcomes.set(keyOf(episode.account), outcome);
    } else episode.phase = "declined";
    for (const waiter of episode.waiters) waiter(answer);
    changed();
  };
  const descriptor = (episode: LoginEpisode): ExternalLoginQuestion | undefined => episode.phase === "declined" ? undefined
    : { id: episode.id, authDir: episode.authDir, account: episode.account, phase: episode.phase };
  const find = (id: string): LoginEpisode | undefined => [...episodes.values()].find((episode) => episode.id === id);
  // Only a change of the failure changes what the auth view shows, so a served request after another tells no one.
  const setOutcome = (key: string, outcome: RequestOutcome | undefined): void => {
    const episode = episodes.get(key);
    if (episode !== undefined && (outcome === "served" || outcome === undefined)) {
      settle(episode, "renewed", outcome);
      return;
    }
    const before = failureOf(outcomes.get(key));
    if (outcome === undefined) outcomes.delete(key);
    else outcomes.set(key, outcome);
    if (episode === undefined && failureOf(outcome) !== before) changed();
  };
  return {
    recordRequest: (login, outcome) => { setOutcome(keyOf(login), outcome); },
    clearRequest: (login) => { setOutcome(keyOf(login), undefined); },
    recordPlan: (login, plan) => {
      const key = keyOf(login);
      if (plans.get(key) === plan) return;
      plans.set(key, plan);
      changed();
    },
    forget: (login) => {
      const key = keyOf(login);
      const episode = episodes.get(key);
      const held = [episodes.delete(key), outcomes.delete(key), plans.delete(key)].includes(true);
      if (episode !== undefined) {
        record(episode, "forgotten");
        for (const waiter of episode.waiters) waiter("declined");
      }
      if (held) changed();
    },
    outcome: (login) => outcomes.get(keyOf(login)),
    failure: (login) => episodes.has(keyOf(login)) ? "login-rejected" : failureOf(outcomes.get(keyOf(login))),
    plan: (login) => plans.get(keyOf(login)),
    observe: (listener) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    awaitLogin: async (authDir, account, signal) => {
      signal.throwIfAborted();
      const key = keyOf(account);
      let episode = episodes.get(key);
      const created = episode === undefined;
      if (episode === undefined) {
        if (outcomes.get(key) !== "login-rejected") return "renewed";
        episode = { id: crypto.randomUUID(), authDir, account, phase: "asking", waiters: new Set() };
        episodes.set(key, episode);
        record(episode, "asking");
      }
      if (episode.phase === "declined") return "declined";
      const current = episode;
      const pending = new Promise<LoginWaitAnswer>((resolve, reject) => {
        const clean = (): void => {
          signal.removeEventListener("abort", abort);
          current.waiters.delete(finish);
        };
        const finish = (answer: LoginWaitAnswer): void => { clean(); resolve(answer); };
        const abort = (): void => { clean(); reject(signal.reason); };
        current.waiters.add(finish);
        signal.addEventListener("abort", abort, { once: true });
      });
      if (created) changed();
      return await pending;
    },
    loginQuestions: () => [...episodes.values()].flatMap((episode) => {
      const question = descriptor(episode);
      return question === undefined ? [] : [question];
    }),
    answerLogin: (id, answer) => {
      const episode = find(id);
      if (episode?.phase !== "asking") return undefined;
      if (answer === "declined") {
        const question = descriptor(episode);
        settle(episode, answer);
        return question;
      }
      episode.phase = "logging-in";
      record(episode, "logging-in");
      changed();
      return descriptor(episode);
    },
    settleLogin: (id, answer) => {
      const episode = find(id);
      if (episode?.phase === "logging-in") settle(episode, answer);
    },
  };
}

/** The observations of this process, which every bridge, listing, usage check, and auth view of the process shares. */
export const processLoginObservations = createLoginObservations();
