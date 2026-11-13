import type { PreferencesStore } from "../preferences/store";

export interface FormFields {
  readonly quietStart: string;
  readonly quietEnd: string;
}

/** The settings screen. It renders from the store and submits through store.update. */
export class SettingsForm {
  constructor(private readonly store: PreferencesStore) {}

  fields(): FormFields {
    const { quietHours } = this.store.get();
    return { quietStart: quietHours.start, quietEnd: quietHours.end };
  }

  async submit(fields: FormFields): Promise<void> {
    await this.store.update({ quietHours: { start: fields.quietStart, end: fields.quietEnd } });
  }
}
