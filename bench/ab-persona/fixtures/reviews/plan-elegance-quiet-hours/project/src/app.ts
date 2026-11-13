import { NotificationScheduler, type Sender } from "./notify/scheduler";
import type { Preferences } from "./preferences/parse";
import { PreferencesStore } from "./preferences/store";
import { SettingsForm } from "./ui/settings-form";

export function createApp(saved: unknown, persist: (preferences: Preferences) => Promise<void>, sender: Sender) {
  const store = new PreferencesStore(saved, persist);
  const scheduler = new NotificationScheduler(() => store.get(), sender);
  const form = new SettingsForm(store);
  return { store, scheduler, form };
}
