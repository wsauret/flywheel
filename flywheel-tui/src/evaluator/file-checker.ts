// ---------------------------------------------------------------------------
// Production file checker for trust-but-verify evaluator
// ---------------------------------------------------------------------------
//
// Checks whether a file exists on disk. Used by the trust-but-verify
// evaluator to verify worker claims about file creation/modification.
// ---------------------------------------------------------------------------

import * as fs from "node:fs";
import * as path from "node:path";
import { Log } from "../utils/log";
import type { FileChecker } from "./trust-verify";

const log = Log.create({ service: "evaluator-file-checker" });

/**
 * Creates a production file checker that resolves paths relative to
 * the given working directory and checks existence via fs.existsSync.
 */
export function createFileChecker(cwd: string): FileChecker {
  return async (filePath: string) => {
    const resolved = path.isAbsolute(filePath)
      ? filePath
      : path.resolve(cwd, filePath);

    const exists = fs.existsSync(resolved);

    log.info("file existence check", {
      path: filePath,
      resolved,
      exists,
    });

    return exists;
  };
}
