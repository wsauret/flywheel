import type { Contact } from "./channels.ts";
import { parseChannelOrder, type PreferenceStore } from "./preferences.ts";

/** Save the alert section of the settings form. `channelOrder` is the text the
 *  user typed, for example "push, email"; a bad entry throws before anything
 *  is stored, and the form shows the message. */
export function saveAlertSettings(store: PreferenceStore, userId: string, contact: Contact, channelOrder: string): void {
  store.set({ userId, contact, channels: parseChannelOrder(channelOrder) });
}
