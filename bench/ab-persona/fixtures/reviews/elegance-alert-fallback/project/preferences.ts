import type { Channel, Contact } from "./channels.ts";

const ALLOWED_CHANNELS: readonly Channel[] = ["email", "sms", "push"];

export interface AlertPreferences {
  userId: string;
  contact: Contact;
  /** Channels to try, in order, until one delivers. Never empty. */
  channels: readonly Channel[];
}

/** Parse the comma-separated channel order from the settings form, for
 *  example "push, email". Unknown names and repeats are rejected so the
 *  user sees the mistake instead of a silently shorter list. */
export function parseChannelOrder(input: string): Channel[] {
  const names = input.split(",").map((name) => name.trim().toLowerCase()).filter((name) => name !== "");
  if (names.length === 0) throw new Error("Choose at least one alert channel");
  const channels: Channel[] = [];
  for (const name of names) {
    const channel = ALLOWED_CHANNELS.find((candidate) => candidate === name);
    if (channel === undefined) throw new Error(`Unknown alert channel "${name}"`);
    if (channels.includes(channel)) throw new Error(`Alert channel "${name}" is listed twice`);
    channels.push(channel);
  }
  return channels;
}

export class PreferenceStore {
  private readonly byUser = new Map<string, AlertPreferences>();

  get(userId: string): AlertPreferences {
    const preferences = this.byUser.get(userId);
    if (preferences === undefined) throw new Error(`No alert preferences for ${userId}`);
    return preferences;
  }

  set(preferences: AlertPreferences): void {
    this.byUser.set(preferences.userId, preferences);
  }
}
