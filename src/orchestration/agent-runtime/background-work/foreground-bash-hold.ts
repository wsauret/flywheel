/** Why a held command moved to the background before it settled: the person
 *  selected Detach, or a planned replacement moved it so that the replacement's
 *  cut, which interrupts the turn, does not end it. */
export type ForegroundBashReleaseReason = "user_detach" | "replacement";

interface ForegroundBashHold {
  /** Resolves with the reason once the hold is released. */
  readonly released: Promise<ForegroundBashReleaseReason>;
  /** The held command's launch ran: a release from here on moves a running
   *  command, which reports through `cleanup()`. A launch that has not
   *  started has nothing to move. */
  running(): void;
  /** Ends the hold: the command settled in its tool call, or, after a
   *  release, the session registry tracks it. */
  cleanup(): void;
}

export interface ForegroundBashHoldController {
  register(toolUseId: string): ForegroundBashHold;
  release(toolUseId: string): boolean;
  /** A planned replacement's move of every held command to the background.
   *  Every hold registered after this call is released at once, because the
   *  replacement never ends. Resolves once each released command that runs
   *  is tracked by the session registry or has ended, so an interrupt after
   *  it cannot end a command that it moved. A released launch that has not
   *  started is not waited for: the interrupt cancels it before it runs. */
  transferForReplacement(): Promise<void>;
  awaitSettlement(): Promise<void>;
  dispose(): void;
}

interface LiveHold {
  readonly release: (reason: ForegroundBashReleaseReason) => void;
}

/** Owns the foreground Bash calls that the user can transfer by raw tool-call ID. */
export function createForegroundBashHoldController(
  onActiveIdsChange: (activeIds: readonly string[]) => void,
): ForegroundBashHoldController {
  const live = new Map<string, LiveHold>();
  // Released holds whose command runs and is not tracked by the session
  // registry yet.
  const transferring = new Set<Promise<void>>();
  const settlementWaiters = new Set<() => void>();
  let disposed = false;
  let replacing = false;
  const resolveSettlement = (): void => {
    if (live.size > 0) return;
    for (const resolve of settlementWaiters) resolve();
    settlementWaiters.clear();
  };
  const publish = (): void => onActiveIdsChange([...live.keys()]);

  return {
    register(toolUseId) {
      if (disposed) throw new Error("Foreground Bash hold controller is disposed");
      if (live.has(toolUseId)) throw new Error(`Foreground Bash hold already exists for tool call ID '${toolUseId}'`);

      const released = Promise.withResolvers<ForegroundBashReleaseReason>();
      const transferred = Promise.withResolvers<void>();
      let isReleased = false;
      let isRunning = false;
      let cleaned = false;
      // A move in progress: a released command that runs, until it reports.
      const transferIfMoving = (): void => {
        if (isReleased && isRunning && !cleaned) transferring.add(transferred.promise);
      };
      const hold: LiveHold = {
        release: (reason) => {
          isReleased = true;
          transferIfMoving();
          released.resolve(reason);
        },
      };
      if (replacing) hold.release("replacement");
      else {
        live.set(toolUseId, hold);
        publish();
      }

      return {
        released: released.promise,
        running() {
          isRunning = true;
          transferIfMoving();
        },
        cleanup() {
          if (cleaned) return;
          cleaned = true;
          transferring.delete(transferred.promise);
          transferred.resolve();
          if (live.get(toolUseId) !== hold) return;
          live.delete(toolUseId);
          publish();
          resolveSettlement();
        },
      };
    },
    release(toolUseId) {
      const hold = live.get(toolUseId);
      if (!hold) return false;
      live.delete(toolUseId);
      publish();
      hold.release("user_detach");
      resolveSettlement();
      return true;
    },
    transferForReplacement() {
      replacing = true;
      const held = [...live.values()];
      live.clear();
      if (held.length > 0) publish();
      for (const hold of held) hold.release("replacement");
      resolveSettlement();
      return Promise.all(transferring).then(() => {});
    },
    awaitSettlement() {
      if (live.size === 0) return Promise.resolve();
      return new Promise<void>((resolve) => { settlementWaiters.add(resolve); });
    },
    dispose() {
      if (disposed) return;
      if (live.size > 0) {
        throw new Error(`Cannot dispose foreground Bash hold controller with live registrations: ${[...live.keys()].join(", ")}`);
      }
      disposed = true;
    },
  };
}
