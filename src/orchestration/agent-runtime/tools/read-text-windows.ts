import { createHash } from "node:crypto";
import type { LineRange } from "./read-selectors.js";

/** Decode an AST snapshot and fingerprint its original bytes, including malformed UTF-8 and BOM bytes. */
export function decodeTextSnapshot(buffer: ArrayBuffer) {
  const bytes = new Uint8Array(buffer);
  const text = new TextDecoder().decode(bytes);
  const lines = text.split("\n");
  return {
    text,
    lines,
    totalLines: lines.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    binary: bytes.subarray(0, 8192).includes(0),
  };
}

/**
 * Scan the complete stream for its byte fingerprint and LF-delimited line count.
 * Retain only inclusive requested windows, in caller order. Open ends include EOF.
 * Decoder state spans chunks; an empty stream and a trailing LF both have an empty final line.
 * Stream errors and cancellation propagate without publishing coverage. Abort waits for source cancellation.
 */
export async function readTextWindows(stream: ReadableStream<Uint8Array>, ranges: readonly LineRange[], signal?: AbortSignal) {
  const windows = ranges.map(range => ({ ...range, lines: new Array<string>() }));
  const decoder = new TextDecoder();
  const hash = createHash("sha256");
  let byteCount = 0;
  let binary = false;
  let line = 1;
  let fragments: string[] = [];
  let selected = windows.filter(range => range.startLine <= line && line <= (range.endLine ?? Infinity));

  const finishLine = () => {
    if (selected.length > 0) {
      const text = fragments.join("");
      for (const window of selected) window.lines.push(text);
      fragments = [];
    }
  };
  const consume = (text: string) => {
    let start = 0;
    for (;;) {
      const end = text.indexOf("\n", start);
      if (selected.length > 0) {
        const fragment = text.slice(start, end < 0 ? text.length : end);
        if (fragment.length > 0) fragments.push(fragment);
      }
      if (end < 0) return;
      finishLine();
      line++;
      const nextLine = line;
      selected = windows.filter(range => range.startLine <= nextLine && nextLine <= (range.endLine ?? Infinity));
      start = end + 1;
    }
  };

  await stream.pipeTo(new WritableStream<Uint8Array>({
    write(bytes) {
      hash.update(bytes);
      if (byteCount < 8192 && bytes.subarray(0, 8192 - byteCount).includes(0)) binary = true;
      byteCount += bytes.length;
      consume(decoder.decode(bytes, { stream: true }));
    },
  }), { signal });
  consume(decoder.decode());
  finishLine();
  return { windows, totalLines: line, sha256: hash.digest("hex"), binary };
}
