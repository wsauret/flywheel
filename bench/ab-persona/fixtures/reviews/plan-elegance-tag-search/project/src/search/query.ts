import { tokenize, type SearchIndex } from "./build";

/** Paths of the notes that contain every word of the query, sorted. */
export function search(index: SearchIndex, query: string): string[] {
  const words = tokenize(query);
  if (words.length === 0) return [];
  const [first, ...rest] = words.map((word) => new Set(index.words[word] ?? []));
  const hits = [...(first ?? [])].filter((path) => rest.every((set) => set.has(path)));
  return hits.sort();
}
