/**
 * Prompt prefix hold: sibling requests that send the same cached prompt prefix
 * share one provider cache write.
 *
 * A provider writes a prompt prefix to its cache while it reads the first
 * request that sends the prefix. A second request that starts before that
 * write lands finds no entry and writes the same prefix again. The ready agents
 * of a workflow all start at once, so the agents of one phase send equal
 * prefixes within milliseconds of each other, and without a hold each one pays
 * the full cache write. This hold staggers the first request that the agent
 * runtime admits for an attempt of an agent of a workflow:
 *
 * - The first request with a cold prefix key is the leader. It runs at once.
 * - A request with the same key while the leader warms the cache is a
 *   follower. It waits until the leader's first response event, or for at
 *   most `PREFIX_HOLD_CAP_MS`, whichever comes first, and then runs.
 * - The leader's first response marks the key warm for `PREFIX_WARM_MS`. A
 *   request with a warm key runs at once.
 * - A leader whose request ends without a response releases its followers,
 *   which then run at once.
 *
 * A request with a different key never waits. A request whose prompt caching
 * is disabled never enters the hold.
 */

import { abortableSleep } from "../../infra/abort.js"
import { DebugLog } from "../../infra/debug-log.js"
import type { PreparedServingRequest, ProviderStreamEvent, ServingAttempt } from "./llm/types.js"

/** The longest time a follower waits for its leader's first response. A
 *  first response usually arrives well inside it, and a follower that waits
 *  longer loses more time than the cache write it saves. */
export const PREFIX_HOLD_CAP_MS = 5_000
/** How long a key stays warm after its leader's first response. It is shorter
 *  than the shortest provider cache lifetime (five minutes), so a warm key
 *  always names a prefix that the provider still holds. */
export const PREFIX_WARM_MS = 270_000

export interface PrefixHoldClock {
  now(): number
  /** Resolves after `ms`; rejects when `signal` aborts first. */
  sleep(ms: number, signal: AbortSignal): Promise<void>
}

const SYSTEM_CLOCK: PrefixHoldClock = { now: () => performance.now(), sleep: abortableSleep }

/** One request's place in the hold. */
export interface PrefixHoldTicket {
  readonly leader: boolean
  /** How long this request waited before it ran. */
  readonly waitedMs: number
  /** The provider sent the first response event of this request. */
  responded(): void
  /** This request ended. A leader without a response releases its followers. */
  done(): void
}

type FollowerOutcome = "response" | "cap" | "abort" | "leader_ended"

/** How many followers of one episode each outcome released. */
interface FollowerCounts {
  response: number
  cap: number
  abort: number
  leader_ended: number
}

/** The leader and followers of one warming episode of a key, counted for the
 *  one diagnostic record the episode writes when it settles. */
interface HoldGroup {
  readonly prefix: string
  readonly startedAt: number
  releasedBy?: "response" | "leader_ended"
  leaderResponseMs?: number
  waiting: number
  readonly followers: FollowerCounts
  totalWaitMs: number
  maxWaitMs: number
}

type Entry =
  | { readonly state: "warming"; readonly group: HoldGroup; readonly released: Promise<void>; release(by: "response" | "leader_ended"): void }
  | { readonly state: "warm"; readonly until: number }

export class PromptPrefixHold {
  private readonly entries = new Map<string, Entry>()

  constructor(private readonly clock: PrefixHoldClock = SYSTEM_CLOCK) {}

  async enter(key: string, signal?: AbortSignal): Promise<PrefixHoldTicket> {
    const now = this.clock.now()
    for (const [entryKey, entry] of this.entries) if (entry.state === "warm" && entry.until <= now) this.entries.delete(entryKey)
    const existing = this.entries.get(key)
    if (existing === undefined) return this.lead(key, now)
    if (existing.state === "warm") return this.follow(key, 0)
    const group = existing.group
    group.waiting += 1
    const outcome = await this.waitForRelease(existing, signal)
    const waitedMs = Math.max(0, this.clock.now() - now)
    group.waiting -= 1
    group.followers[outcome] += 1
    group.totalWaitMs += waitedMs
    group.maxWaitMs = Math.max(group.maxWaitMs, waitedMs)
    this.settle(group)
    return this.follow(key, waitedMs)
  }

  /** A follower's response warms the key too: a follower
   *  that the cap released can answer before its leader. */
  private follow(key: string, waitedMs: number): PrefixHoldTicket {
    let responded = false
    return {
      leader: false,
      waitedMs,
      responded: () => {
        if (responded) return
        responded = true
        this.markWarm(key)
      },
      done: () => {},
    }
  }

  private lead(key: string, now: number): PrefixHoldTicket {
    let release!: (by: "response" | "leader_ended") => void
    const group: HoldGroup = {
      prefix: key.slice(0, 12), startedAt: now, waiting: 0,
      followers: { response: 0, cap: 0, abort: 0, leader_ended: 0 }, totalWaitMs: 0, maxWaitMs: 0,
    }
    const released = new Promise<void>((resolve) => {
      release = (by) => {
        if (group.releasedBy !== undefined) return
        group.releasedBy = by
        resolve()
        this.settle(group)
      }
    })
    const entry: Entry = { state: "warming", group, released, release }
    this.entries.set(key, entry)
    let responded = false
    return {
      leader: true,
      waitedMs: 0,
      responded: () => {
        if (responded) return
        responded = true
        group.leaderResponseMs = Math.max(0, this.clock.now() - group.startedAt)
        this.markWarm(key)
      },
      done: () => {
        if (responded || this.entries.get(key) !== entry) return
        this.entries.delete(key)
        entry.release("leader_ended")
      },
    }
  }

  private async waitForRelease(entry: Extract<Entry, { state: "warming" }>, signal: AbortSignal | undefined): Promise<FollowerOutcome> {
    if (signal?.aborted) return "abort"
    const stop = new AbortController()
    const abort = (): void => { stop.abort() }
    signal?.addEventListener("abort", abort, { once: true })
    try {
      return await Promise.race([
        entry.released.then(() => entry.group.releasedBy ?? "response"),
        this.clock.sleep(PREFIX_HOLD_CAP_MS, stop.signal).then(() => "cap" as const, () => "abort" as const),
      ])
    } finally {
      stop.abort()
      signal?.removeEventListener("abort", abort)
    }
  }

  private markWarm(key: string): void {
    const previous = this.entries.get(key)
    this.entries.set(key, { state: "warm", until: this.clock.now() + PREFIX_WARM_MS })
    if (previous?.state === "warming") previous.release("response")
  }

  /** One INFO record per episode that held a follower, once the leader has
   *  responded or ended and no follower still waits. A leader alone made no
   *  hold decision and records nothing. */
  private settle(group: HoldGroup): void {
    if (group.releasedBy === undefined || group.waiting > 0) return
    const { response, cap, abort, leader_ended: leaderEnded } = group.followers
    const followers = response + cap + abort + leaderEnded
    if (followers === 0) return
    DebugLog.record({
      type: "model.prefix_hold.settled",
      payload: {
        prefix: group.prefix,
        releasedBy: group.releasedBy,
        leaderResponseMs: group.leaderResponseMs === undefined ? null : Math.round(group.leaderResponseMs),
        followers,
        releasedByResponse: response,
        releasedByCap: cap,
        releasedByLeaderEnd: leaderEnded,
        aborted: abort,
        maxWaitMs: Math.round(group.maxWaitMs),
        totalWaitMs: Math.round(group.totalWaitMs),
      },
    })
  }
}

/** The process's one hold, used only for the requests of agents of a workflow. A
 *  chat or a direct subagent starts alone, so it has no sibling to share a write with. */
export const workflowPromptPrefixHold = new PromptPrefixHold()

/** The provider-visible identity of the prefix that a request's route can
 *  share with a sibling conversation: the serving route and account, the model,
 *  the tools in order, and the system tiers before the conversation tier. The
 *  conversation tier, the messages, and per-request options stay out. The
 *  route states where its shared prefix ends (`ServingAttempt.sharedPromptPrefix`):
 *  a route that caches the session tier together with the conversation tier
 *  shares only the stable tier, and a route whose cache routing reads the
 *  request's prompt-cache key shares a prefix only within that key. */
export function promptPrefixKey(
  candidate: Readonly<{ attempt: ServingAttempt; prepared: PreparedServingRequest }>,
  promptCacheKey: string | undefined,
): string {
  const { attempt, prepared } = candidate
  const sharing = attempt.sharedPromptPrefix
  const hasher = new Bun.CryptoHasher("sha256")
  const parts = [
    attempt.accessProvider,
    JSON.stringify(attempt.accessProviderCandidate ?? null),
    attempt.model,
    attempt.toolPresentation.format,
    JSON.stringify(prepared.tools),
    prepared.systemPrompt.stable,
    sharing === "stable" ? "" : prepared.systemPrompt.session,
    sharing === "cache-key" ? promptCacheKey ?? "" : "",
  ]
  for (const part of parts) {
    hasher.update(part)
    hasher.update("\u0000")
  }
  return hasher.digest("hex")
}

/** Whether a provider event proves that the provider answered the request and
 *  so has read its prompt: its model stream's start or its first assistant
 *  message. An attempt start, a retry, a status line, a
 *  notice, and a transport record arrive before the request goes out or in
 *  place of an answer. The record names every kind, so a new kind must state
 *  its answer. */
const ANSWERS = {
  provider_response_started: true,
  text_delta: true,
  text_terminal: true,
  thinking_delta: true,
  thinking_complete: true,
  text_complete: true,
  tool_input_start: true,
  tool_input_delta: true,
  tool_use: true,
  reasoning: true,
  usage: true,
  context_update: true,
  done: true,
  provider_status: false,
  transport_context: false,
  stream_attempt_start: false,
  stream_retry: false,
} as const satisfies { readonly [Kind in ProviderStreamEvent["kind"]]: boolean }

export function isProviderResponseEvent(event: ProviderStreamEvent): boolean {
  return ANSWERS[event.kind]
}
