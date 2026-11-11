export const WEEK_STARTS = ["monday", "sunday"] as const;
export type WeekStart = (typeof WEEK_STARTS)[number];

export interface Settings {
  weekStartsOn: WeekStart;
  /** IANA time zone name, for example "Europe/Lisbon". */
  timeZone: string;
}

export const DEFAULT_SETTINGS: Settings = { weekStartsOn: "monday", timeZone: "UTC" };
