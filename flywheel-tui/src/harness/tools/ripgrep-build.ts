/**
 * Ripgrep native addon staleness check and auto-recompile.
 *
 * Compares mtime of source files against the built .node addon.
 * If any source is newer, runs cargo build and copies the dylib.
 * Blocks startup until the build completes.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";
import { Log } from "../../utils/log.js";

const CRATE_DIR = path.resolve(import.meta.dir, "../../../crates/ripgrep");
const ADDON_PATH = path.join(CRATE_DIR, "flywheel-ripgrep.darwin-arm64.node");
const DYLIB_PATH = path.join(CRATE_DIR, "target/release/libflywheel_ripgrep.dylib");

const SOURCE_GLOBS = [
  "src/*.rs",
  "Cargo.toml",
  "Cargo.lock",
  "build.rs",
];

function getNewestMtime(dir: string, patterns: string[]): number {
  let newest = 0;
  for (const pattern of patterns) {
    const base = path.dirname(pattern);
    const ext = path.extname(pattern);
    const searchDir = path.join(dir, base);

    if (!fs.existsSync(searchDir)) continue;

    const entries = fs.readdirSync(searchDir);
    for (const entry of entries) {
      if (ext && !entry.endsWith(ext)) continue;
      const stat = fs.statSync(path.join(searchDir, entry));
      if (stat.mtimeMs > newest) newest = stat.mtimeMs;
    }
  }
  return newest;
}

export function ensureRipgrepAddon(): void {
  if (!fs.existsSync(CRATE_DIR)) return;

  const addonExists = fs.existsSync(ADDON_PATH);
  const addonMtime = addonExists ? fs.statSync(ADDON_PATH).mtimeMs : 0;
  const sourceMtime = getNewestMtime(CRATE_DIR, SOURCE_GLOBS);

  if (addonExists && addonMtime >= sourceMtime) return;

  const reason = addonExists ? "source files are newer than the built addon" : "addon not found";
  Log.Default.info(`ripgrep addon stale (${reason}), rebuilding...`);
  console.error(`[flywheel] Rebuilding ripgrep addon (${reason})...`);

  try {
    execSync("cargo build --release", {
      cwd: CRATE_DIR,
      stdio: "pipe",
      timeout: 120_000,
    });

    fs.copyFileSync(DYLIB_PATH, ADDON_PATH);
    Log.Default.info("ripgrep addon rebuilt successfully");
    console.error("[flywheel] Ripgrep addon rebuilt successfully.");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    Log.Default.error("ripgrep addon build failed", { error: msg });
    console.error(`[flywheel] WARNING: ripgrep addon build failed: ${msg}`);
    console.error("[flywheel] The harness text-search tool may not work correctly.");
  }
}
