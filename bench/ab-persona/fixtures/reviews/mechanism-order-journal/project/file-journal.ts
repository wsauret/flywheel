import { open, readFile, type FileHandle } from "node:fs/promises";
import type { JournalFile } from "./types.ts";

/** A JournalFile backed by one append-mode file handle. */
export async function openJournalFile(path: string): Promise<JournalFile> {
  const handle: FileHandle = await open(path, "a+");
  return {
    async write(text) {
      await handle.appendFile(text, "utf8");
    },
    async sync() {
      await handle.datasync();
    },
    async readAll() {
      return readFile(path, "utf8");
    },
  };
}
