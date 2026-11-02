// Whole-file agent assets carry no id granularity, so the first root that holds
// the file shadows the whole file. Callers order roots highest precedence first:
// the project overlay, then the user overlay, then the bundled source tree.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { resolveDefinitionCandidates, shouldLogDefinitionMasking, type DefinitionCandidate, type DefinitionResolution } from "../definition-resolution.js";
import { Log } from "../log.js";

const log = Log.create({ service: "agent-asset-loader" });
export interface AgentAssetRoot {
  readonly dir: string;
  readonly layer: "project" | "user" | "bundled";
}

/** Resolve one whole-file asset without discarding failed or masked sources. */
export function loadAssetResolution(
  roots: readonly AgentAssetRoot[],
  filename: string,
  bundledContent: string,
): DefinitionResolution<string> {
  const candidates: DefinitionCandidate<string>[] = [];
  for (const root of roots) {
    const path = join(root.dir, filename);
    try {
      const raw = readFileSync(path, "utf-8");
      candidates.push({
        kind: "valid",
        source: { path, layer: root.layer, identity: createHash("sha256").update(raw).digest("hex") },
        value: raw,
      });
    } catch (error) {
      const code = typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
      if (code !== "ENOENT") candidates.push({ kind: "rejected", source: { path, layer: root.layer }, reason: error instanceof Error ? error.message : String(error) });
    }
  }
  if (!candidates.some((candidate) => candidate.source.layer === "bundled")) {
    candidates.push({ kind: "valid", source: { path: `manifest:${filename}`, layer: "bundled", identity: createHash("sha256").update(bundledContent).digest("hex") }, value: bundledContent });
  }
  const resolution = resolveDefinitionCandidates("system-prompt", filename.replace(/\.md$/u, ""), filename, candidates);
  const bundledFailure = candidates.find((candidate) => candidate.kind === "rejected" && candidate.source.layer === "bundled");
  if (bundledFailure?.kind === "rejected") throw new Error(`Bundled asset ${bundledFailure.source.path}: ${bundledFailure.reason}`);
  for (const diagnostic of resolution.diagnostics) {
    if (diagnostic.kind === "masking" && shouldLogDefinitionMasking(diagnostic)) log.warn("system prompt override masks bundled definition", { winner: diagnostic.winner.path, bundled: diagnostic.displaced.path });
  }
  return resolution;
}
/** Read the first readable copy of `filename` across `roots`. Overlay roots
 *  are optional external state: a missing or unreadable file means "no
 *  override" and falls through to the next root. Returns "" when no root
 *  holds the file, which is the caller's signal to use the compiled-in
 *  manifest (the only layer present in a binary). */
export function loadFirstAssetFile(roots: readonly string[], filename: string): string {
  for (const root of roots) {
    try {
      return readFileSync(join(root, filename), "utf-8");
    } catch {
      // Overlay dirs are optional user/project layers; absence is "no overrides", not corruption.
    }
  }
  return "";
}
