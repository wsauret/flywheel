import * as fs from "node:fs";
import * as path from "node:path";
import { parseStateFile } from "./reader";

/**
 * Glob pattern for flywheel temp files.
 * The `.__flywheel__.` sentinel ensures we only match engine-created files.
 */
const TMP_GLOB_SUFFIX = ".__flywheel__.*.tmp";

/** Maximum number of .tmp files to consider for recovery. */
const MAX_TMP_FILES = 10;

export interface RecoveryResult {
  /** Whether a .tmp was promoted to the state file */
  promoted: boolean;
  /** Path of the promoted .tmp file (if any) */
  promotedFrom?: string;
  /** Paths of discarded .tmp files */
  discarded: string[];
  /** Warning messages for skipped files */
  warnings: string[];
}

/**
 * Recover stale `.tmp` files for a given state file path.
 *
 * Scans for `<statePath>.__flywheel__.*.tmp` files, parses them, and promotes
 * the one with the newest `last_written_at` if it is newer than the current
 * state file. All other .tmp files are discarded (deleted).
 *
 * Caps at 10 most-recent files by mtime; warns and skips older ones.
 */
export function recoverStaleTmpFiles(statePath: string): RecoveryResult {
  const result: RecoveryResult = {
    promoted: false,
    discarded: [],
    warnings: [],
  };

  const dir = path.dirname(statePath);
  const basename = path.basename(statePath);

  // Find matching .tmp files
  let tmpFiles: string[];
  try {
    const entries = fs.readdirSync(dir);
    tmpFiles = entries
      .filter((e) => e.startsWith(basename + ".__flywheel__.") && e.endsWith(".tmp"))
      .map((e) => path.join(dir, e));
  } catch {
    // Directory doesn't exist or can't be read
    return result;
  }

  if (tmpFiles.length === 0) return result;

  // Sort by mtime descending, cap at MAX_TMP_FILES
  const withMtime = tmpFiles
    .map((f) => {
      try {
        const stat = fs.statSync(f);
        return { path: f, mtime: stat.mtimeMs };
      } catch {
        return null;
      }
    })
    .filter((x): x is { path: string; mtime: number } => x !== null)
    .sort((a, b) => b.mtime - a.mtime);

  if (withMtime.length > MAX_TMP_FILES) {
    const skipped = withMtime.slice(MAX_TMP_FILES);
    for (const s of skipped) {
      result.warnings.push(
        `Skipping old .tmp file (exceeds cap of ${MAX_TMP_FILES}): ${s.path}`,
      );
      safeUnlink(s.path);
      result.discarded.push(s.path);
    }
  }

  const candidates = withMtime.slice(0, MAX_TMP_FILES);

  // Parse current state file's last_written_at
  let currentTimestamp: string | null = null;
  try {
    const currentContent = fs.readFileSync(statePath, "utf-8");
    const parsed = parseStateFile(currentContent);
    const lwa = parsed.frontmatter.last_written_at;
    if (typeof lwa === "string") {
      currentTimestamp = lwa;
    }
  } catch {
    // State file doesn't exist or can't be read — any valid tmp is promotable
  }

  // Find the best candidate: newest last_written_at that is newer than current
  let bestCandidate: { path: string; timestamp: string } | null = null;

  for (const candidate of candidates) {
    try {
      const content = fs.readFileSync(candidate.path, "utf-8");
      const parsed = parseStateFile(content);
      const lwa = parsed.frontmatter.last_written_at;

      if (typeof lwa !== "string") {
        result.warnings.push(
          `Discarding .tmp without valid last_written_at: ${candidate.path}`,
        );
        safeUnlink(candidate.path);
        result.discarded.push(candidate.path);
        continue;
      }

      if (
        !bestCandidate ||
        lwa > bestCandidate.timestamp
      ) {
        bestCandidate = { path: candidate.path, timestamp: lwa };
      }
    } catch (err) {
      result.warnings.push(
        `Discarding unparseable .tmp: ${candidate.path}: ${err}`,
      );
      safeUnlink(candidate.path);
      result.discarded.push(candidate.path);
    }
  }

  // Promote if newer than current
  if (bestCandidate) {
    const shouldPromote =
      currentTimestamp === null || bestCandidate.timestamp > currentTimestamp;

    if (shouldPromote) {
      try {
        fs.renameSync(bestCandidate.path, statePath);
        result.promoted = true;
        result.promotedFrom = bestCandidate.path;
      } catch (err) {
        result.warnings.push(
          `Failed to promote .tmp: ${bestCandidate.path}: ${err}`,
        );
        safeUnlink(bestCandidate.path);
        result.discarded.push(bestCandidate.path);
      }
    } else {
      safeUnlink(bestCandidate.path);
      result.discarded.push(bestCandidate.path);
    }

    // Clean up remaining candidates
    for (const candidate of candidates) {
      if (candidate.path !== bestCandidate.path) {
        safeUnlink(candidate.path);
        result.discarded.push(candidate.path);
      }
    }
  }

  return result;
}

function safeUnlink(filePath: string): void {
  try {
    fs.unlinkSync(filePath);
  } catch {
    // Ignore — file may already be gone
  }
}
