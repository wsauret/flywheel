import { readSync } from "node:fs";

/** Read exactly `buffer.length` bytes from `position` into `buffer`.
 *
 *  `readSync` may return fewer bytes than it was asked for: a signal, a slow or
 *  networked filesystem, and a file truncated under the reader all produce a
 *  short count. A caller that accepts one publishes a prefix of a file as if it
 *  were the file, which for a procedure or a byte-paged window is a different
 *  document, never a shorter one. This loops until the buffer is full and
 *  refuses at end of file instead.
 *
 *  `subject` names what is being read in the failure message, so a caller that
 *  must not show a local path can name the file some other way. Throws when the
 *  file ends before the buffer is full. */
export function readFullSync(fd: number, buffer: Buffer, position: number, subject: string): void {
  let filled = 0;
  while (filled < buffer.length) {
    const read = readSync(fd, buffer, filled, buffer.length - filled, position + filled);
    if (read <= 0) {
      throw new Error(`${subject} ended after ${filled} of ${buffer.length} bytes; it was truncated while it was being read`);
    }
    filled += read;
  }
}
