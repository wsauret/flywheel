import type { Part, StorageApi } from "./api.ts";
import { runLimited } from "./limiter.ts";
import { withRetry } from "./retry.ts";

export interface FileSource {
  name: string;
  size: number;
  /** Bytes in [start, end). */
  slice(start: number, end: number): Uint8Array;
}

export interface UploadOptions {
  chunkSize: number;
  concurrency: number;
  sleep: (ms: number) => Promise<void>;
}

interface ByteRange {
  start: number;
  end: number;
}

export function chunkRanges(size: number, chunkSize: number): ByteRange[] {
  const ranges: ByteRange[] = [];
  for (let start = 0; start < size; start += chunkSize) {
    ranges.push({ start, end: Math.min(start + chunkSize, size) });
  }
  return ranges;
}

/** Upload a file as parallel parts, then ask the store to assemble them.
 *  Small files keep the single-request path. */
export async function uploadFile(api: StorageApi, file: FileSource, options: UploadOptions): Promise<string> {
  if (file.size <= options.chunkSize) return api.putObject(file.name, file.slice(0, file.size));
  const uploadId = await api.startUpload(file.name, file.size);
  const parts: Part[] = [];
  const tasks = chunkRanges(file.size, options.chunkSize).map((range, index) => async () => {
    const partNumber = index + 1;
    const etag = await withRetry(() => api.putPart(uploadId, partNumber, file.slice(range.start, range.end)), options.sleep);
    parts.push({ number: partNumber, etag });
  });
  await runLimited(tasks, options.concurrency);
  parts.sort((a, b) => a.number - b.number);
  return api.completeUpload(uploadId, parts);
}
