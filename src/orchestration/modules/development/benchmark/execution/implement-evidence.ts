import { existsSync } from "node:fs";
import { cp, mkdir } from "node:fs/promises";
import { join } from "node:path";

/** The candidate's durable runtime events, one JSON object per line, under the sandbox's `.flywheel`. */
export const IMPLEMENT_TRANSCRIPT_FILE = "benchmark-transcript.jsonl";

async function retainEvidence(directory: string, write: () => Promise<void>): Promise<void> {
  try {
    await mkdir(directory, { recursive: true });
    await write();
  } catch {
    // Evidence is diagnostic only and must not replace the cell's outcome.
    try {
      await Bun.write(join(directory, "evidence-error.txt"), "Could not retain all implementation evidence.\n");
    } catch {
      // A full or inaccessible results volume can also prevent the error note.
    }
  }
}

/** Copy settled sandbox state when present. Retention failures never reject. */
export async function retainImplementStore(sandbox: string, directory: string): Promise<void> {
  const source = join(sandbox, ".flywheel");
  if (!existsSync(source)) return;
  await retainEvidence(directory, () => cp(source, join(directory, ".flywheel"), { recursive: true }));
}

/** Keep the captured patch that a failed native grade received. Retention failures never reject. */
export async function retainNativeGradeFailure(directory: string, diff: string): Promise<void> {
  await retainEvidence(directory, async () => { await Bun.write(join(directory, "captured.patch"), diff); });
}
