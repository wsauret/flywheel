import { createHash } from "node:crypto";
import { closeSync, createReadStream, openSync, readSync } from "node:fs";

/** SHA-256 of a file's bytes, streamed so a hundred-megabyte archive never
 *  becomes a hundred-megabyte buffer. The digest states integrity and
 *  publication consistency; it authenticates no publisher (ARCH-DISTRIBUTION-007). */
export async function sha256File(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

/** SHA-256 of a file's bytes, read in bounded chunks and never buffered whole.
 *  This is the digest a caller takes while it holds a lock: an account-global
 *  lock window admits no `await`, so the streaming form above cannot be used
 *  there. */
export function sha256FileSync(filePath: string): string {
  const hash = createHash("sha256");
  const chunk = Buffer.allocUnsafe(1024 * 1024);
  const fd = openSync(filePath, "r");
  try {
    for (;;) {
      const read = readSync(fd, chunk, 0, chunk.byteLength, null);
      if (read === 0) break;
      hash.update(chunk.subarray(0, read));
    }
  } finally {
    closeSync(fd);
  }
  return hash.digest("hex");
}
