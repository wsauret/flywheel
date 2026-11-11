import type { Settings } from "./settings.ts";

const DAY_NAMES: readonly string[] = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** Column headings of the month grid, in the order the user's week runs. */
export function weekdayHeadings(settings: Settings): string[] {
  return settings.weekStartsOn === "sunday" ? [...DAY_NAMES] : [...DAY_NAMES.slice(1), ...DAY_NAMES.slice(0, 1)];
}

export function formatEventTime(epochMs: number, settings: Settings): string {
  return new Intl.DateTimeFormat("en-GB", { timeZone: settings.timeZone, hour: "2-digit", minute: "2-digit" }).format(epochMs);
}
