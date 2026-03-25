import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { LOCK_DIR } from "../config/paths";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface LockContent {
  pid: number;
  timestamp: number;
  hostname: string;
}

export interface WriteLock {
  /** Release the lock (unlinks the lock file). Safe to call multiple times. */
  release(): void;
  /** Path to the lock file */
  lockPath: string;
}

export interface AcquireOptions {
  /** Maximum age in ms before a lock is considered stale. Default: 300_000 (5 min) */
  staleThresholdMs?: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_STALE_THRESHOLD_MS = 300_000; // 5 minutes

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Derive the lock file path from a plan name.
 * Lock path: `.flywheel/<plan-name>.write.lock`
 */
export function lockPathFor(planName: string, baseDir: string): string {
  return path.join(baseDir, LOCK_DIR, `${planName}.write.lock`);
}

/**
 * Acquire an exclusive write lock for a state file.
 *
 * Uses `O_EXCL` to atomically create the lock file. If the file already exists,
 * checks if the lock is stale (PID dead + timestamp old + hostname matches)
 * and cleans it up if so.
 *
 * Registers cleanup handlers for SIGTERM, uncaughtException, and
 * unhandledRejection to release the lock on abnormal exit.
 *
 * @throws Error if lock cannot be acquired (another process holds it)
 */
export function acquireLock(
  planName: string,
  baseDir: string,
  options?: AcquireOptions,
): WriteLock {
  const lockPath_ = lockPathFor(planName, baseDir);
  const staleThreshold =
    options?.staleThresholdMs ?? DEFAULT_STALE_THRESHOLD_MS;

  // Ensure .flywheel directory exists
  const lockDir = path.dirname(lockPath_);
  if (!fs.existsSync(lockDir)) {
    fs.mkdirSync(lockDir, { recursive: true });
  }

  const content: LockContent = {
    pid: process.pid,
    timestamp: Date.now(),
    hostname: os.hostname(),
  };

  try {
    // O_EXCL: fail if file exists
    const fd = fs.openSync(lockPath_, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL);
    fs.writeFileSync(fd, JSON.stringify(content, null, 2));
    fs.closeSync(fd);
  } catch (err: unknown) {
    if (isErrnoException(err) && err.code === "EEXIST") {
      // Lock file exists — check if stale
      if (isLockStale(lockPath_, staleThreshold)) {
        // Remove stale lock and retry
        safeUnlink(lockPath_);
        return acquireLock(planName, baseDir, options);
      }
      throw new Error(
        `Write lock held by another process: ${lockPath_}. ` +
          "Cannot acquire lock. Is another flywheel CLI or skill running on this plan?",
      );
    }
    throw err;
  }

  let released = false;

  const release = () => {
    if (released) return;
    released = true;
    safeUnlink(lockPath_);
    removeCleanupHandlers();
  };

  // Register cleanup handlers
  const onSignal = () => {
    release();
    process.exit(1);
  };
  const onError = (_err: unknown) => {
    release();
  };

  process.on("SIGTERM", onSignal);
  process.on("uncaughtException", onError);
  process.on("unhandledRejection", onError);

  function removeCleanupHandlers() {
    process.removeListener("SIGTERM", onSignal);
    process.removeListener("uncaughtException", onError);
    process.removeListener("unhandledRejection", onError);
  }

  return { release, lockPath: lockPath_ };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Check if a lock file is stale. All three conditions must be met:
 * 1. PID is not alive
 * 2. Timestamp is older than staleThreshold
 * 3. Hostname matches current host (lock from same machine)
 */
function isLockStale(lockPath_: string, staleThresholdMs: number): boolean {
  try {
    const raw = fs.readFileSync(lockPath_, "utf-8");
    const lock: LockContent = JSON.parse(raw);

    const pidDead = !isPidAlive(lock.pid);
    const isOld = Date.now() - lock.timestamp > staleThresholdMs;
    const sameHost = lock.hostname === os.hostname();

    return pidDead && isOld && sameHost;
  } catch {
    // Can't parse lock — treat as stale
    return true;
  }
}

function isPidAlive(pid: number): boolean {
  try {
    // Signal 0 doesn't send a signal but checks if the process exists
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function safeUnlink(filePath: string): void {
  try {
    fs.unlinkSync(filePath);
  } catch {
    // Ignore
  }
}

function isErrnoException(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && "code" in err;
}
