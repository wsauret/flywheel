import { parsePreferences, type Preferences } from "./parse";

export type PreferencesListener = (preferences: Preferences) => void;

/** The owner of the user's preferences. Every change goes through update, which re-parses the merged value. */
export class PreferencesStore {
  #current: Preferences;
  readonly #listeners = new Set<PreferencesListener>();

  constructor(saved: unknown, private readonly persist: (preferences: Preferences) => Promise<void>) {
    this.#current = parsePreferences(saved);
  }

  get(): Preferences {
    return this.#current;
  }

  async update(patch: Partial<Preferences>): Promise<void> {
    this.#current = parsePreferences({ ...this.#current, ...patch });
    await this.persist(this.#current);
    for (const listener of this.#listeners) listener(this.#current);
  }

  subscribe(listener: PreferencesListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
}
