/**
 * Output truncation for harness tool results.
 *
 * Keeps first + last portions so error traces at either end survive.
 * Full output is saved to a temp file the model can grep later.
 */

import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { errorMessage } from "../../../../../infra/error-message.js";
import { Log } from "../../../../../infra/log.js";

function harnessOutputDir(cwd: string, sessionId?: string): string {
  const base = join(cwd, ".flywheel", "harness-outputs");
  return sessionId ? join(base, sessionId) : base;
}

const log = Log.create({ service: "harness-truncation" });

const DEFAULT_MAX_BYTES = 30_000;
const PORTION_BYTES = 15_000;

export async function limitOutput(
  output: string,
  maxBytes: number = DEFAULT_MAX_BYTES,
  cwd: string = process.cwd(),
  sessionId?: string,
): Promise<{ text: string; truncated: boolean }> {
  const byteLen = Buffer.byteLength(output, "utf-8");
  if (byteLen <= maxBytes) {
    return { text: output, truncated: false };
  }

  const savedPath = await trySaveFullOutput(output, cwd, sessionId);

  const bytes = Buffer.from(output, "utf-8");
  const first = bytes.subarray(0, PORTION_BYTES).toString("utf-8");
  const last = bytes.subarray(-PORTION_BYTES).toString("utf-8");
  const omitted = byteLen - PORTION_BYTES * 2;

  let text = `${first}\n[truncated: ${omitted} bytes omitted]\n${last}`;
  if (savedPath) {
    text += `\n[Full output saved to ${savedPath} -- use grep/cat to search it]`;
  }

  return { text, truncated: true };
}

async function trySaveFullOutput(output: string, cwd: string, sessionId?: string): Promise<string | null> {
  try {
    const dir = harnessOutputDir(cwd, sessionId);
    mkdirSync(dir, { recursive: true });

    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const id = randomUUID().slice(0, 6);
    const filePath = `${dir}/output_${ts}_${id}.txt`;

    await Bun.write(filePath, output);
    return filePath;
  } catch (err) {
    log.warn("failed to save full output", { error: errorMessage(err) });
    return null;
  }
}

export function cleanupHarnessOutputs(cwd: string, sessionId: string): void {
  try {
    const dir = harnessOutputDir(cwd, sessionId);
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // Best effort
  }
}
