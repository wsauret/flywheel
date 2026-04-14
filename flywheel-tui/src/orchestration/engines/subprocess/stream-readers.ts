type MinimalReader = {
  read(): Promise<{ done: boolean; value?: Uint8Array }>;
  cancel(): Promise<void>;
};

export interface StreamReaderSet {
  stdout: MinimalReader | null;
  stderr: MinimalReader | null;
  cancelAll(): void;
}

export function createStreamReaderSet(signal: AbortSignal): StreamReaderSet {
  const set: StreamReaderSet = {
    stdout: null,
    stderr: null,
    cancelAll() {
      for (const key of ["stdout", "stderr"] as const) {
        const reader = set[key];
        if (reader) {
          try { reader.cancel().catch(() => {}); } catch { /* reader may already be released */ }
          set[key] = null;
        }
      }
    },
  };

  if (!signal.aborted) {
    signal.addEventListener("abort", () => set.cancelAll(), { once: true });
  }

  return set;
}

export async function readStream(
  reader: MinimalReader,
  chunks: string[],
  onChunk?: (text: string) => void,
): Promise<void> {
  const decoder = new TextDecoder("utf-8", { fatal: false });
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const text = decoder.decode(value, { stream: true });
      chunks.push(text);
      onChunk?.(text);
    }
    const remaining = decoder.decode(undefined, { stream: false });
    if (remaining) {
      chunks.push(remaining);
      onChunk?.(remaining);
    }
  } catch {
    // Stream may be closed due to process kill or reader cancellation
  }
}
