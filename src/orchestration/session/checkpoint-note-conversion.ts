import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { AsyncEventReadSurface } from "../../infra/event-store-types.js";
import type { DurableOwner } from "../../infra/durable-owner.js";
import { emptyConversationCheckpoint, readConversationCheckpoint } from "./conversation-checkpoint.js";
import type { SessionFactWriter } from "./session-fact-writer.js";

/** Imports legacy Markdown bytes once, without applying the checkpoint write limit.
 * Remove this conversion after 2027-04-21. Legacy files remain untouched and are no longer an authority. */
export async function importLegacyCheckpointNotes(reader: AsyncEventReadSurface, writer: SessionFactWriter, owner: DurableOwner, conversationId: string, notesDirectory: string): Promise<void> {
  if (await readConversationCheckpoint(reader, owner, conversationId)) return;
  const notes: string[] = [];
  async function visit(directory: string, prefix: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries.toSorted((a, b) => a.name.localeCompare(b.name))) {
      const name = `${prefix}${entry.name}`;
      if (entry.isDirectory()) await visit(join(directory, entry.name), `${name}/`);
      else if (entry.isFile() && entry.name.endsWith(".md")) {
        const bytes = await readFile(join(directory, entry.name));
        const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
        notes.push(`## ${name}\n\n${text}`);
      }
    }
  }
  await visit(notesDirectory, "");
  if (notes.length === 0) return;
  const checkpoint = { ...emptyConversationCheckpoint(), workingNotes: notes.join("\n\n") };
  const stored = await writer.record({ type: "conversation.checkpoint.updated", version: 1, actor: "flywheel", payload: { conversationId, checkpoint } });
  if (!stored) throw new Error("Legacy notes were not imported because the checkpoint writer is unavailable.");
}
