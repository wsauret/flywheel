/** Output past this bound is discarded while the stream continues to drain. */
export const MAX_OUTPUT_BYTES = 1_000_000

/** Retains at most maxBytes from a stream's head or tail, and drains it to EOF.
 * The bound applies to retained allocations, including oversized chunks. */
export async function readBounded(
  stream: ReadableStream<Uint8Array> | undefined,
  maxBytes: number,
  retention: "head" | "tail",
): Promise<{ bytes: Uint8Array; truncated: boolean }> {
  if (!stream) return { bytes: new Uint8Array(), truncated: false }
  if (retention === "tail") return readTail(stream, maxBytes)
  const kept: Uint8Array[] = []
  let size = 0
  let truncated = false
  for await (const chunk of stream) {
    const capacity = maxBytes - size
    if (chunk.length > capacity) truncated = true
    if (capacity <= 0) continue
    // Copy the retained window so a slice cannot keep an oversized backing buffer.
    const take = new Uint8Array(chunk.subarray(0, capacity))
    kept.push(take)
    size += take.length
  }
  const joined = new Uint8Array(size)
  let offset = 0
  for (const chunk of kept) {
    joined.set(chunk, offset)
    offset += chunk.length
  }
  return { bytes: joined, truncated }
}

async function readTail(
  stream: ReadableStream<Uint8Array>,
  maxBytes: number,
): Promise<{ bytes: Uint8Array; truncated: boolean }> {
  const kept = new Uint8Array(maxBytes)
  let size = 0
  let writeOffset = 0
  let truncated = false
  for await (const chunk of stream) {
    if (size + chunk.length > maxBytes) truncated = true
    if (maxBytes === 0) continue
    if (chunk.length >= maxBytes) {
      kept.set(chunk.subarray(chunk.length - maxBytes))
      size = maxBytes
      writeOffset = 0
      continue
    }
    const firstLength = Math.min(chunk.length, maxBytes - writeOffset)
    kept.set(chunk.subarray(0, firstLength), writeOffset)
    kept.set(chunk.subarray(firstLength), 0)
    size = Math.min(maxBytes, size + chunk.length)
    writeOffset = (writeOffset + chunk.length) % maxBytes
  }
  if (size < maxBytes) return { bytes: kept.subarray(0, size), truncated }
  if (writeOffset === 0) return { bytes: kept, truncated }
  const ordered = new Uint8Array(size)
  ordered.set(kept.subarray(writeOffset))
  ordered.set(kept.subarray(0, writeOffset), maxBytes - writeOffset)
  return { bytes: ordered, truncated }
}
