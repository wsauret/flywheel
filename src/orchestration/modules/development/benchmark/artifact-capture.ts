import { createHash } from "node:crypto";
import { open } from "node:fs/promises";
import { errorMessage } from "../../../../infra/error-message.js";
import type { HeadlessBenchmarkExecution } from "./headless-execution-contract.js";

/** Drain raw bytes into a new private artifact before consuming them. Existing files are refused. */
export async function captureBenchmarkPipe(
  stream: ReadableStream<Uint8Array> | undefined,
  path: string,
  consume?: (chunk: Uint8Array) => Promise<void>,
  onFailure?: () => void,
): Promise<HeadlessBenchmarkExecution["artifacts"][string]> {
  let file: Awaited<ReturnType<typeof open>> | undefined;
  const hash = createHash("sha256");
  let bytes = 0;
  try {
    file = await open(path, "wx", 0o600);
    if (stream) {
      for await (const chunk of stream) {
        let offset = 0;
        while (offset < chunk.length) {
          const written = await file.write(chunk, offset, chunk.length - offset);
          offset += written.bytesWritten;
        }
        hash.update(chunk);
        bytes += chunk.length;
        await consume?.(chunk);
      }
    }
    return { path, bytes, sha256: hash.digest("hex") };
  } catch (error) {
    onFailure?.();
    throw new Error(`artifact pipe failed: ${errorMessage(error)}`, { cause: error });
  } finally {
    await file?.close();
  }
}
