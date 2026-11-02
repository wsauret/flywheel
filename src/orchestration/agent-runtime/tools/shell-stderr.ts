/**
 * Parent-side stderr diagnostics for shell executions.
 *
 * The shell script merges the payload's stderr into recorded stdout, so the
 * parent-side stderr channel carries the xtrace of a traced
 * command, a launch that died before the script ran, for which a short
 * retained tail is enough to say why. Supervisor diagnostics travel through
 * the separate control return channel.
 */

import { createHash } from "node:crypto";
import type { OwnedProcess } from "../../../infra/owned-subprocess.js";
import { createStreamingSanitizer } from "../../../infra/control-characters.js";
import { Log } from "../../../infra/log.js";

const log = Log.create({ service: "shell-runtime" });

/** How much parent-side stderr a shell execution retains. */
const STDERR_TAIL_CHARS = 2_048;

/** Retains the newest `STDERR_TAIL_CHARS` of parent-side stderr. */
export interface StderrTail {
  push(text: string): void;
  text(): string;
}

export function createStderrTail(): StderrTail {
  let tail = "";
  return {
    push(text) {
      tail = (tail + text).slice(-STDERR_TAIL_CHARS);
    },
    text: () => tail.trim(),
  };
}

/** The stderr note a failed execution carries when its recorded output is
 *  empty. Without it a launch that died before the script ran reports
 *  "(no output)" and nothing else, which is undiagnosable. */
export function silentFailureStderr(exitCode: number, recordedOutput: string, stderrTail: string): string | undefined {
  if (exitCode === 0 || recordedOutput.length > 0 || stderrTail.length === 0) return undefined;
  // The stderr itself is tool output and reaches the model's durable tool
  // result through the note below; the record carries only its size and hash.
  log.warn("shell command failed with no recorded output; parent-side stderr may explain the launch", {
    exitCode,
    stderrBytes: Buffer.byteLength(stderrTail),
    stderrSha256: createHash("sha256").update(stderrTail).digest("hex"),
  });
  return `[stderr] ${stderrTail}`;
}

/** Reads a command's stderr stream through the output sanitizer. Settlement
 *  waits for it only for the
 *  post-exit grace: a descendant that inherited the descriptor can keep it
 *  open past the exit, and the tail keeps whatever arrived by the time anyone
 *  reads it. */
export async function drainStderr(owned: Pick<OwnedProcess, "pid" | "stderr"> | undefined, push: (text: string) => void): Promise<void> {
  if (!owned?.stderr) return;
  const stderr = createStreamingSanitizer(push);
  const decoder = new TextDecoder();
  const reader = owned.stderr.getReader();
  try {
    for (;;) {
      const result = await reader.read();
      if (result.done) break;
      stderr.push(decoder.decode(result.value, { stream: true }));
    }
    stderr.push(decoder.decode());
    stderr.finish();
  } catch {
    // A cancelled or errored stream ends the drain with what already arrived.
  } finally {
    reader.releaseLock();
  }
}
