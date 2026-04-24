/**
 * Native ripgrep search engine wrapper.
 *
 * Loads the flywheel-ripgrep N-API addon and exposes typed search functions.
 */

import { createRequire } from "node:module";
import { arch, platform } from "node:os";
import { resolve } from "node:path";
import { Log } from "../../../../../infra/log.js";
import { errorMessage } from "../../../../../infra/error-message.js";

const log = Log.create({ service: "harness-ripgrep" });

interface ContextLine {
  lineNumber: number;
  line: string;
}

interface GrepOptions {
  pattern: string;
  path: string;
  glob?: string;
  type?: string;
  ignoreCase?: boolean;
  multiline?: boolean;
  hidden?: boolean;
  gitignore?: boolean;
  maxCount?: number;
  offset?: number;
  contextBefore?: number;
  contextAfter?: number;
  context?: number;
  maxColumns?: number;
  mode?: "content" | "filesWithMatches" | "count";
}

export interface GrepMatch {
  path: string;
  lineNumber: number;
  line: string;
  contextBefore?: ContextLine[];
  contextAfter?: ContextLine[];
  truncated?: boolean;
  matchCount?: number;
}

export interface GrepResult {
  matches: GrepMatch[];
  totalMatches: number;
  filesWithMatches: number;
  filesSearched: number;
  limitReached?: boolean;
}

interface NativeAddon {
  grep(options: GrepOptions): GrepResult;
}

// Process-global native-addon cache. The Node `.node` binding can only be
// dlopen'd once per process, and its internal state is shared — threading this
// through a factory would still produce the same singleton via require().
// addonLoadError is sticky so we don't retry a broken binary each grep call.
let addonCache: NativeAddon | null = null;
let addonLoadError: string | null = null;

function loadAddon(): NativeAddon | null {
  if (addonCache) return addonCache;
  if (addonLoadError) return null;

  try {
    const require = createRequire(import.meta.url);
    const addonName = `flywheel-ripgrep.${platform()}-${arch()}.node`;
    const addonPath = resolve(import.meta.dir, "../../../../../../crates/ripgrep", addonName);
    addonCache = require(addonPath) as NativeAddon;
    return addonCache;
  } catch (err) {
    addonLoadError = errorMessage(err);
    log.warn("ripgrep addon not available, text_search will be unavailable", {
      error: addonLoadError,
    });
    return null;
  }
}

export function grep(options: GrepOptions): GrepResult {
  const addon = loadAddon();
  if (!addon) throw new Error("Ripgrep native addon not available");
  return addon.grep(options);
}
