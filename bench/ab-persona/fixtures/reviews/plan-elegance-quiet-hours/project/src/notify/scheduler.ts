import type { Preferences } from "../preferences/parse";

export interface Notification {
  readonly id: string;
  readonly title: string;
}

export interface Sender {
  send(notification: Notification, preferences: Preferences): Promise<void>;
}

function minutes(time: string): number {
  const [hours, mins] = time.split(":").map(Number);
  return (hours ?? 0) * 60 + (mins ?? 0);
}

export function isQuiet(preferences: Preferences, now: Date): boolean {
  const current = now.getHours() * 60 + now.getMinutes();
  const start = minutes(preferences.quietHours.start);
  const end = minutes(preferences.quietHours.end);
  return start <= end ? current >= start && current < end : current >= start || current < end;
}

/** Sends a notification now, or holds it until quiet hours end. Reads the current preferences on every decision. */
export class NotificationScheduler {
  readonly #held: Notification[] = [];

  constructor(private readonly getPreferences: () => Preferences, private readonly sender: Sender) {}

  async notify(notification: Notification, now: Date): Promise<void> {
    const preferences = this.getPreferences();
    if (isQuiet(preferences, now)) {
      this.#held.push(notification);
      return;
    }
    await this.sender.send(notification, preferences);
  }

  /** Called by the app's minute timer. */
  async flush(now: Date): Promise<void> {
    const preferences = this.getPreferences();
    if (isQuiet(preferences, now)) return;
    for (const notification of this.#held.splice(0)) await this.sender.send(notification, preferences);
  }

  heldCount(): number {
    return this.#held.length;
  }
}
