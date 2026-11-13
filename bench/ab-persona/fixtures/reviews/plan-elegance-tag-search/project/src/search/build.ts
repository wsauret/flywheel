import type { Note } from "../notes/store";

export const INDEX_VERSION = 1;

export interface SearchIndex {
  readonly version: typeof INDEX_VERSION;
  /** A hash of the notes the index was built from; a different hash means the notes changed. */
  readonly fingerprint: string;
  /** word -> paths of the notes whose title or body contains it */
  readonly words: Record<string, string[]>;
}

export function tokenize(text: string): string[] {
  return text.toLowerCase().split(/[^a-z0-9]+/).filter((word) => word.length > 1);
}

export function fingerprintOf(notes: readonly Note[]): string {
  return String(Bun.hash(JSON.stringify(notes.map((note) => [note.path, note.title, note.tags, note.body]))));
}

export function buildIndex(notes: readonly Note[]): SearchIndex {
  const words: Record<string, string[]> = {};
  for (const note of notes) {
    for (const word of new Set(tokenize(`${note.title} ${note.body}`))) {
      (words[word] ??= []).push(note.path);
    }
  }
  return { version: INDEX_VERSION, fingerprint: fingerprintOf(notes), words };
}
