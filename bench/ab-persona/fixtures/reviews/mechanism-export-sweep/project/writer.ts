import { open, rename, rm } from "node:fs/promises";
import { join } from "node:path";

export const EXPORT_SUFFIX = ".csv";
const PARTIAL_SUFFIX = ".partial";

function csvLine(cells: readonly string[]): string {
  return `${cells.map((cell) => (/[",\n]/.test(cell) ? `"${cell.replaceAll('"', '""')}"` : cell)).join(",")}\n`;
}

/** Write an export under a temporary name and publish it under its final
 *  name only when every byte is on disk. Returns the final path. A failed
 *  write removes its temporary file. */
export async function writeExport(directory: string, exportId: string, rows: AsyncIterable<readonly string[]>): Promise<string> {
  const finalPath = join(directory, `${exportId}${EXPORT_SUFFIX}`);
  const partialPath = `${finalPath}${PARTIAL_SUFFIX}`;
  const handle = await open(partialPath, "w");
  try {
    for await (const row of rows) await handle.write(csvLine(row));
    await handle.sync();
  } catch (error) {
    await handle.close();
    await rm(partialPath, { force: true });
    throw error;
  }
  await handle.close();
  await rename(partialPath, finalPath);
  return finalPath;
}
