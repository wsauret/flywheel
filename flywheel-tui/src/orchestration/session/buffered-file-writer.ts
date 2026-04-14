import * as fs from "node:fs";
import { createDebouncedWriter } from "../../workflows/shared/debounced-writer.js";

export const DEFAULT_DEBOUNCE_MS = 100;

interface BufferedFileWriterOpts<T> {
  /** Absolute path to the file to append to (opened with "a" flag). */
  filePath: string;
  /** Serialize buffered items into a string for writing. */
  serialize: (items: T[]) => string;
  /** Debounce interval in ms. Default: 100ms */
  debounceMs?: number;
}

interface BufferedFileWriter<T> {
  /** Append an item to the buffer (debounced write). */
  push(item: T): void;
  /** Force-write all buffered items to disk and cancel pending timer. */
  flush(): void;
  /** Flush + close fd. Safe to call multiple times. */
  dispose(): void;
}

export function createBufferedFileWriter<T>(opts: BufferedFileWriterOpts<T>): BufferedFileWriter<T> {
  const { filePath, serialize, debounceMs = DEFAULT_DEBOUNCE_MS } = opts;

  const fd = fs.openSync(filePath, "a");
  let buffer: T[] = [];
  let disposed = false;

  function drainBuffer(): void {
    if (buffer.length === 0) return;
    const items = buffer;
    buffer = [];

    try {
      fs.writeSync(fd, serialize(items));
    } catch {
      // Best-effort — don't crash on write failure (SubprocessLogger precedent)
    }
  }

  const debouncer = createDebouncedWriter<undefined>(async () => {
    drainBuffer();
  }, { intervalMs: debounceMs });

  function push(item: T): void {
    if (disposed) return;
    buffer.push(item);
    debouncer.schedule(undefined);
  }

  function flush(): void {
    debouncer.dispose();
    drainBuffer();
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;

    flush();

    try {
      fs.closeSync(fd);
    } catch {
      // Ignore close errors
    }
  }

  return { push, flush, dispose };
}
