export interface FlagRule {
  name: string;
  enabled: boolean;
  /** Share of users, 0 to 100, that see the flag while it rolls out. */
  rolloutPercent: number;
}

/** Flag rules pushed by the config service. A user lands in a stable bucket,
 *  so a rollout percentage only ever adds users as it grows. */
export class FlagStore {
  private readonly rules = new Map<string, FlagRule>();

  load(rules: readonly FlagRule[]): void {
    this.rules.clear();
    for (const rule of rules) this.rules.set(rule.name, rule);
  }

  isEnabled(name: string, userId: string): boolean {
    const rule = this.rules.get(name);
    if (rule === undefined || !rule.enabled) return false;
    return bucketOf(userId) < rule.rolloutPercent;
  }
}

function bucketOf(userId: string): number {
  let hash = 0;
  for (const char of userId) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return hash % 100;
}
