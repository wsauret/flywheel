/** The service's own small state, kept across restarts. The production adapter is a SQLite table. */
export interface Settings {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string): Promise<void>;
}
