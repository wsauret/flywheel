import type { TimeEntry } from "../entries";

/** The minutes of an entry that are billed: all of them for a billable entry, none otherwise. */
export function billableMinutes(entry: TimeEntry): number {
  return entry.billable ? entry.minutes : 0;
}
