import { fnv1a32 } from "./hash.ts";
import type { FetchFlags, FlagSet } from "./types.ts";

/** A user's stable position, 0 to 99, in one flag's rollout. */
export function bucketOf(flagKey: string, userId: string): number {
  return fnv1a32(`${flagKey}:${userId}`) % 100;
}

export class FlagClient {
  private snapshot: FlagSet = { revision: 0, flags: {} };

  constructor(
    private readonly fetchFlags: FetchFlags,
    private readonly onError: (error: unknown) => void,
  ) {}

  /** Whether `flagKey` is on for `userId`. Unknown flags return `fallback`. */
  evaluate(flagKey: string, userId: string, fallback: boolean): boolean {
    const flag = Object.hasOwn(this.snapshot.flags, flagKey) ? this.snapshot.flags[flagKey] : undefined;
    if (flag === undefined) return fallback;
    if (!flag.enabled) return false;
    return bucketOf(flagKey, userId) < flag.rolloutPercent;
  }

  /** Fetch the latest flag set. Returns true when it replaced the snapshot.
   *  Called on a timer and when the service pushes a change notice, so two
   *  calls can overlap. */
  async refresh(): Promise<boolean> {
    let next: FlagSet;
    try {
      next = await this.fetchFlags();
    } catch (error) {
      this.onError(error);
      return false;
    }
    if (next.revision <= this.snapshot.revision) return false;
    this.snapshot = next;
    return true;
  }
}
