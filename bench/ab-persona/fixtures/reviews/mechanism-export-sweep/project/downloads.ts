import { open } from "node:fs/promises";
import { join } from "node:path";
import { EXPORT_SUFFIX } from "./writer.ts";

export interface DownloadResponse {
  status: 200 | 400 | 404;
  body?: Uint8Array;
}

const EXPORT_ID = /^[a-z0-9-]{8,64}$/;

/** Answer a download link. Opening the file is the existence check, so there
 *  is no gap between checking for the file and reading it. */
export async function serveDownload(directory: string, exportId: string): Promise<DownloadResponse> {
  if (!EXPORT_ID.test(exportId)) return { status: 400 };
  let handle;
  try {
    handle = await open(join(directory, `${exportId}${EXPORT_SUFFIX}`), "r");
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return { status: 404 };
    throw error;
  }
  try {
    return { status: 200, body: await handle.readFile() };
  } finally {
    await handle.close();
  }
}
