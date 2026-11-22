import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";

/** The size and SHA-256 that an authority states for the bytes of one engine executable. */
export interface EngineDigest {
  readonly size: number;
  readonly sha256: string;
}

/** Refuses bytes whose size or SHA-256 is not the one that `authority` states. `label` names the engine and its
 *  target, such as "The Claude engine for darwin-arm64". */
export function requireDigestMatch(label: string, authority: string, expected: EngineDigest, bytes: Uint8Array): void {
  if (bytes.byteLength !== expected.size) throw new Error(`${label} is ${bytes.byteLength} bytes, and ${authority} states ${expected.size}`);
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== expected.sha256) throw new Error(`${label} has SHA-256 ${digest}, and ${authority} states ${expected.sha256}`);
}

/** Refuses an engine file without an executable bit. A Windows host's file system keeps no executable bit, and a
 *  Windows target needs none, so only a POSIX file for a POSIX target is checked. */
export async function requireExecutable(label: string, path: string, platformArch: string): Promise<void> {
  if (process.platform === "win32" || platformArch.startsWith("win32-")) return;
  if (((await stat(path)).mode & 0o111) === 0) throw new Error(`${label} is not executable`);
}
