export type Channel = "push" | "email";

/** A daily window, as HH:MM in the user's local time. `start` may be later than `end` (an overnight window). */
export interface QuietHours {
  readonly start: string;
  readonly end: string;
}

export interface Preferences {
  readonly channels: readonly Channel[];
  readonly quietHours: QuietHours;
}

export const DEFAULT_PREFERENCES: Preferences = {
  channels: ["push"],
  quietHours: { start: "22:00", end: "07:00" },
};

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? { ...value } : {};
}

/**
 * The one boundary for preference input: the saved file and the settings form both pass through here.
 * A missing or invalid field takes its default, so a Preferences value always holds valid quiet hours.
 */
export function parsePreferences(raw: unknown): Preferences {
  const input = record(raw);
  const channels = Array.isArray(input.channels)
    ? input.channels.filter((channel): channel is Channel => channel === "push" || channel === "email")
    : [];
  const quiet = record(input.quietHours);
  const start = typeof quiet.start === "string" && TIME.test(quiet.start) ? quiet.start : DEFAULT_PREFERENCES.quietHours.start;
  const end = typeof quiet.end === "string" && TIME.test(quiet.end) ? quiet.end : DEFAULT_PREFERENCES.quietHours.end;
  return {
    channels: channels.length > 0 ? channels : DEFAULT_PREFERENCES.channels,
    quietHours: { start, end },
  };
}
