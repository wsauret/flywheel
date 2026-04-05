/**
 * Atomic file write utility.
 *
 * Extracted from `src/state/writer.ts` so the same write-fsync-rename kernel
 * can be reused by both the state writer and session persistence layer.
 */
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Generate a unique temporary file path with a `.__flywheel__` sentinel.
 *
 * Format: `${filePath}.__flywheel__.${pid}.${timestamp}.${randomHex}.tmp`
 */
export function makeTmpPath(filePath: string): string {
  const pid = process.pid;
  const timestamp = Date.now();
  const rand = crypto.randomBytes(4).toString("hex");
  return `${filePath}.__flywheel__.${pid}.${timestamp}.${rand}.tmp`;
}

/**
 * Write `content` to `filePath` atomically: write to .tmp → fsync → rename.
 *
 * Creates parent directories if they don't exist.
 */
export function writeFileAtomic(filePath: string, content: string): void {
  const tmpPath = makeTmpPath(filePath);

  // Ensure parent directory exists
  const dir = path.dirname(tmpPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  // Write → fsync → rename
  const fd = fs.openSync(tmpPath, "w");
  try {
    fs.writeFileSync(fd, content, "utf-8");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }

  fs.renameSync(tmpPath, filePath);
}
