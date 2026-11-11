import type { FlagStore } from "./flags.ts";

/** The question pages ask about features. Pages depend on this instead of
 *  the flag store so they stay independent of how flags are delivered. */
export class FeatureGate {
  constructor(private readonly flags: FlagStore) {}

  isOn(feature: string, userId: string): boolean {
    return this.flags.isEnabled(feature, userId);
  }
}
