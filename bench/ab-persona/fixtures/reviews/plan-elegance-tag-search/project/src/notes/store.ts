import { readdir } from "node:fs/promises";
import { join } from "node:path";

export interface Note {
  readonly path: string;
  readonly title: string;
  readonly tags: readonly string[];
  readonly body: string;
}

/** Front matter is a first line `tags: a, b`; the title is the first `# ` heading. */
export function parseNote(path: string, text: string): Note {
  const lines = text.split("\n");
  const tagLine = lines[0]?.startsWith("tags:") ? lines.shift() ?? "" : "";
  const tags = tagLine.slice("tags:".length).split(",").map((tag) => tag.trim().toLowerCase()).filter((tag) => tag.length > 0);
  const heading = lines.find((line) => line.startsWith("# "));
  return { path, title: heading?.slice(2).trim() ?? path, tags, body: lines.join("\n") };
}

/** Every Markdown note in the notes folder. The notes are the only source of truth; the index is derived from them. */
export async function listNotes(dir: string): Promise<Note[]> {
  const names = (await readdir(dir)).filter((name) => name.endsWith(".md")).sort();
  return Promise.all(names.map(async (name) => parseNote(name, await Bun.file(join(dir, name)).text())));
}
