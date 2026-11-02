/**
 * This executor's claims on processor admission (ARCH-TOOLS-051,
 * ARCH-RUNTIME-046).
 *
 * The account's governor measures and holds containers, but only the executor
 * knows which containers it owns, which chat turn started each one, and which
 * tool call each one serves. So every shell container this executor launches
 * or adopts is claimed here until its owned exit or its handover to the next
 * build, and the account's held set comes back here: a held command shows as
 * held in its session's status, and its explicit deadline does not count the
 * time it was held (ARCH-TOOLS-033).
 */

import type { OwnedProcess } from "../../../infra/owned-subprocess.js";

/** One claimed container as the account's governor reads it. `order` is the
 *  launch time in epoch milliseconds, so a container a later build adopts
 *  keeps its place in the queue. */
interface ProcessorClaimView {
  readonly token: string;
  readonly pid: number;
  readonly order: number;
  readonly exempt: boolean;
}

/** A hold in progress: how many heavy containers, of every project, wait
 *  before this one. */
interface ProcessorHold {
  readonly ahead: number;
}

/** The hold time of one claimed container. */
export interface HeldTime {
  /** The milliseconds this container was held since this executor claimed
   *  it, a hold in progress included. */
  heldMs(): number;
  /** The hold in progress, or nothing while the container runs. */
  hold(): ProcessorHold | undefined;
  /** Resolves once the hold in progress ends, or at once when there is none. */
  released(): Promise<void>;
}

/** What one claim states besides its container. */
interface ProcessorClaimInput {
  readonly order: number;
  /** A chat's own turn started the command, so the governor never holds it. */
  readonly exempt: boolean;
  /** The session and tool call whose status shows the hold. */
  readonly sessionId?: string;
  readonly toolUseId?: string;
}

export interface ProcessorClaims {
  /** Claims `owned` until its owned exit or its handover to the next build,
   *  and answers the container to use in its place, whose handover ends the
   *  claim. A container claimed again, when a host takes a command from the
   *  executor's keeper, keeps its place and its hold, and takes the new
   *  claim's exemption, session, and tool call. */
  claim(owned: OwnedProcess, claim: ProcessorClaimInput): OwnedProcess;
  /** The hold time of the container whose ownership token is `token`. A
   *  container this executor does not claim is never held. */
  heldTime(token: string): HeldTime;
  /** Every claimed container, oldest first. */
  claims(): readonly ProcessorClaimView[];
  /** Told each time the claimed set or an exemption changes. */
  onClaimsChanged(listener: () => void): () => void;
  /** Takes the account's complete held set for this executor. A token this
   *  executor no longer claims is ignored. */
  applyHolds(held: readonly { readonly token: string; readonly ahead: number }[]): void;
  /** The tool calls of the session's held commands, oldest first. */
  heldToolCallIds(sessionId: string): readonly string[];
  /** Told the session whose held commands changed. */
  onHoldsChanged(listener: (sessionId: string) => void): () => void;
}

interface Claim extends ProcessorClaimInput, HeldTime {
  readonly token: string;
  readonly pid: number;
  /** Set while the account holds the container. */
  current: { readonly ahead: number; readonly sinceMs: number; readonly released: PromiseWithResolvers<void> } | undefined;
  /** Hold time of the holds that ended. */
  endedMs: number;
  exempt: boolean;
  sessionId?: string;
  toolUseId?: string;
}

/** The hold time of a container that processor admission never holds. */
export const NEVER_HELD: HeldTime = { heldMs: () => 0, hold: () => undefined, released: () => Promise.resolve() };

export function createProcessorClaims(now: () => number = Date.now): ProcessorClaims {
  const claims = new Map<string, Claim>();
  // Each status reads one session's held commands, so they are indexed by
  // session rather than found by a scan over every claim.
  const heldBySession = new Map<string, Set<Claim>>();
  const indexHeld = (claim: Claim, held: boolean): void => {
    if (claim.sessionId === undefined) return;
    const session = heldBySession.get(claim.sessionId) ?? new Set<Claim>();
    if (held) session.add(claim);
    else session.delete(claim);
    if (session.size === 0) heldBySession.delete(claim.sessionId);
    else heldBySession.set(claim.sessionId, session);
  };
  const claimListeners = new Set<() => void>();
  const holdListeners = new Set<(sessionId: string) => void>();
  const claimsChanged = (): void => { for (const listener of claimListeners) listener(); };
  const holdsChanged = (sessionIds: Iterable<string | undefined>): void => {
    for (const sessionId of new Set(sessionIds)) {
      if (sessionId === undefined) continue;
      for (const listener of holdListeners) listener(sessionId);
    }
  };
  const endHold = (claim: Claim): void => {
    const hold = claim.current;
    if (hold === undefined) return;
    indexHeld(claim, false);
    claim.current = undefined;
    claim.endedMs += now() - hold.sinceMs;
    hold.released.resolve();
  };
  const unclaim = (token: string): void => {
    const claim = claims.get(token);
    if (claim === undefined) return;
    claims.delete(token);
    const wasHeld = claim.current !== undefined;
    endHold(claim);
    claimsChanged();
    if (wasHeld) holdsChanged([claim.sessionId]);
  };
  const assign = (claim: Claim, input: ProcessorClaimInput): void => {
    claim.exempt = input.exempt;
    if (input.sessionId === undefined) delete claim.sessionId;
    else claim.sessionId = input.sessionId;
    if (input.toolUseId === undefined) delete claim.toolUseId;
    else claim.toolUseId = input.toolUseId;
  };
  return {
    claim(owned, input) {
      const existing = claims.get(owned.token);
      if (existing) {
        const sessionBefore = existing.sessionId;
        const held = existing.current !== undefined;
        if (held) indexHeld(existing, false);
        assign(existing, input);
        if (held) indexHeld(existing, true);
        claimsChanged();
        if (existing.current !== undefined) holdsChanged([sessionBefore, existing.sessionId]);
      } else {
        const claim: Claim = {
          token: owned.token,
          pid: owned.pid,
          order: input.order,
          exempt: input.exempt,
          current: undefined,
          endedMs: 0,
          heldMs: () => claim.endedMs + (claim.current === undefined ? 0 : now() - claim.current.sinceMs),
          hold: () => claim.current === undefined ? undefined : { ahead: claim.current.ahead },
          released: () => claim.current?.released.promise ?? Promise.resolve(),
        };
        assign(claim, input);
        claims.set(owned.token, claim);
        claimsChanged();
      }
      const release = (): void => { unclaim(owned.token); };
      void owned.exited.then(release, release);
      const handOver = owned.handOver;
      if (handOver === undefined) return owned;
      return {
        ...owned,
        handOver: async (request) => {
          const answer = await handOver(request);
          // The next build claims the command again when it adopts it.
          if (answer.kind === "handed_over") release();
          return answer;
        },
      };
    },
    heldTime: (token) => claims.get(token) ?? NEVER_HELD,
    claims: () => [...claims.values()]
      .sort((a, b) => a.order - b.order)
      .map(({ token, pid, order, exempt }) => ({ token, pid, order, exempt })),
    onClaimsChanged(listener) {
      claimListeners.add(listener);
      return () => { claimListeners.delete(listener); };
    },
    applyHolds(held) {
      const ahead = new Map(held.map((entry) => [entry.token, entry.ahead]));
      const changed: (string | undefined)[] = [];
      for (const claim of claims.values()) {
        const next = ahead.get(claim.token);
        if (next === undefined) {
          if (claim.current === undefined) continue;
          endHold(claim);
          changed.push(claim.sessionId);
        } else if (claim.current === undefined) {
          claim.current = { ahead: next, sinceMs: now(), released: Promise.withResolvers() };
          indexHeld(claim, true);
          changed.push(claim.sessionId);
        } else if (claim.current.ahead !== next) {
          // The place in the queue is read when the command reaches its
          // foreground cap; no status shows it, so nothing is told.
          claim.current = { ...claim.current, ahead: next };
        }
      }
      holdsChanged(changed);
    },
    heldToolCallIds: (sessionId) => [...heldBySession.get(sessionId) ?? []]
      .sort((a, b) => a.order - b.order)
      .flatMap((claim) => claim.toolUseId ?? []),
    onHoldsChanged(listener) {
      holdListeners.add(listener);
      return () => { holdListeners.delete(listener); };
    },
  };
}

let shared: ProcessorClaims | undefined;

/** One project executor hosts one project runtime per process, so every shell
 *  owner of the process claims through this one registry, which its
 *  lifecycle channel reports to the account. */
export function sharedProcessorClaims(): ProcessorClaims {
  shared ??= createProcessorClaims();
  return shared;
}

/** Calls `expire` once the time `held` was not held reaches `deadlineAtMs`:
 *  the deadline moves later by every hold, at the release of that hold
 *  (ARCH-TOOLS-033). Answers the cancel. */
export function armUnheldDeadline(deadlineAtMs: number, held: HeldTime, expire: () => void): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancelled = false;
  const arm = (): void => {
    timer = undefined;
    if (cancelled) return;
    if (held.hold() !== undefined) {
      void held.released().then(arm);
      return;
    }
    const remainingMs = deadlineAtMs + held.heldMs() - Date.now();
    if (remainingMs <= 0) expire();
    else timer = setTimeout(arm, remainingMs);
  };
  arm();
  return () => {
    cancelled = true;
    if (timer !== undefined) clearTimeout(timer);
  };
}
