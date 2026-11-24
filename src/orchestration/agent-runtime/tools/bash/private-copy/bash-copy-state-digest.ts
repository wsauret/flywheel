import { createHash } from "node:crypto";

export interface StateDigest {
  readonly sha256: string;
  readonly count: number;
}

/** Hashes length-framed values in their canonical order without retaining their bytes in the record. */
export function digestStateEntries(entries: Iterable<Uint8Array>): StateDigest {
  const hash = createHash("sha256");
  let count = 0;
  for (const entry of entries) {
    hash.update(`${entry.byteLength}:`).update(entry);
    count++;
  }
  return { sha256: hash.digest("hex"), count };
}
