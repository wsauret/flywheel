/**
 * Data batcher: buffers incoming data and flushes on time or size threshold.
 *
 * Coalesces rapid writes into batched flushes for efficiency. Uses Node's
 * `StringDecoder` for UTF-8 safety (partial multi-byte sequences are held
 * until complete).
 *
 * Usage:
 *   const batcher = new DataBatcher((chunk) => process(chunk), {
 *     flushMs: 16,
 *     maxBytes: 200_000,
 *   })
 *   batcher.push(data)
 *   // ... later ...
 *   batcher.dispose() // flush remaining and cancel timers
 *
 * NOTE: This module creates the utility only. It is NOT wired into
 * the step executor yet.
 */

import { StringDecoder } from "node:string_decoder"

export interface DataBatcherOptions {
  /** Time-based flush interval in milliseconds. Default: 16. */
  flushMs?: number
  /** Size-based flush threshold in bytes. Default: 200_000. */
  maxBytes?: number
}

export class DataBatcher {
  private readonly flushMs: number
  private readonly maxBytes: number
  private readonly onFlush: (data: string) => void
  private readonly decoder: StringDecoder

  private buffer = ""
  private bufferBytes = 0
  private timer: ReturnType<typeof setTimeout> | null = null
  private disposed = false

  constructor(onFlush: (data: string) => void, opts: DataBatcherOptions = {}) {
    this.onFlush = onFlush
    this.flushMs = opts.flushMs ?? 16
    this.maxBytes = opts.maxBytes ?? 200_000
    this.decoder = new StringDecoder("utf8")
  }

  /**
   * Add data to the buffer. May trigger an immediate flush if the
   * size threshold is exceeded.
   */
  push(data: string | Buffer): void {
    if (this.disposed) return

    const decoded = typeof data === "string" ? data : this.decoder.write(data)
    if (!decoded) return

    this.buffer += decoded
    this.bufferBytes += Buffer.byteLength(decoded, "utf8")

    // Size-based flush: flush immediately when threshold exceeded
    if (this.bufferBytes >= this.maxBytes) {
      this.flush()
      return
    }

    // Time-based flush: schedule if not already scheduled
    if (this.timer === null) {
      this.timer = setTimeout(() => {
        this.timer = null
        this.flush()
      }, this.flushMs)
    }
  }

  /**
   * Flush remaining data and cancel any pending timers.
   * After dispose, further `push()` calls are no-ops.
   */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true

    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }

    // Flush any remaining data from the decoder
    const remaining = this.decoder.end()
    if (remaining) {
      this.buffer += remaining
      this.bufferBytes += Buffer.byteLength(remaining, "utf8")
    }

    if (this.buffer.length > 0) {
      this.flush()
    }
  }

  /** Current buffered content size in bytes. */
  get pendingBytes(): number {
    return this.bufferBytes
  }

  private flush(): void {
    if (this.buffer.length === 0) return

    const data = this.buffer
    this.buffer = ""
    this.bufferBytes = 0

    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }

    this.onFlush(data)
  }
}
