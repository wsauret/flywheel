export interface FlagDefinition {
  enabled: boolean;
  /** Share of users, 0 to 100, who see the flag on while it is enabled. */
  rolloutPercent: number;
}

export interface FlagSet {
  /** Increases by one on every change the flag service publishes. */
  revision: number;
  flags: Record<string, FlagDefinition>;
}

export type FetchFlags = () => Promise<FlagSet>;
