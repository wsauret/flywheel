import type { Note } from "../notes/store";
import { buildIndex, fingerprintOf, INDEX_VERSION, type SearchIndex } from "./build";

/**
 * The index is a cache derived from the notes, kept at `.notes-index.json` in the notes folder.
 * A missing or unreadable file, a file of another version, or a file built from other notes
 * is replaced with a fresh build; there is nothing in it that the notes do not hold.
 */
export async function loadIndex(path: string, notes: readonly Note[]): Promise<SearchIndex> {
  const file = Bun.file(path);
  const cached: unknown = (await file.exists()) ? await file.json().catch(() => undefined) : undefined;
  if (
    typeof cached === "object" && cached !== null &&
    "version" in cached && cached.version === INDEX_VERSION &&
    "fingerprint" in cached && cached.fingerprint === fingerprintOf(notes)
  ) {
    return cached as SearchIndex; // boundary: version and fingerprint match a file this code wrote
  }
  const index = buildIndex(notes);
  await Bun.write(path, JSON.stringify(index));
  return index;
}
