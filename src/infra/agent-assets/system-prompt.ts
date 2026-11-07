// The universal system prompt is runner-wide: chat, agents of a workflow, and
// subagents all inject it. It belongs to no single runner, so it resolves here
// instead of in the workflow definition registry.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { FLYWHEEL_DIR_NAME } from "../directory-authorities.js";
import type { DefinitionResolution } from "../definition-resolution.js";
import { loadAssetResolution } from "./loader.js";
import { engineeringDoctrineText as bundledEngineeringDoctrine, systemPromptText as bundledSystemPrompt } from "./manifest.js";

const sourceRoot = dirname(fileURLToPath(import.meta.url));

interface AssetDirectories {
  readonly projectRoot: string;
  readonly userDataRoot: string;
}

/** Whole-file overlay precedence shared by every agent asset: project > user >
 *  bundled source tree, with the compiled-in manifest as the final fallback
 *  (the only layer present in a binary). Both overlay roots are
 *  startup-selected directory authorities (ARCH-DIRECTORIES-003), so this resolves no path
 *  of its own. */
function loadAgentAssetResolution(directories: AssetDirectories, filename: string, bundledContent: string): DefinitionResolution<string> {
  return loadAssetResolution([
    { dir: join(directories.projectRoot, FLYWHEEL_DIR_NAME), layer: "project" },
    { dir: directories.userDataRoot, layer: "user" },
    { dir: sourceRoot, layer: "bundled" },
  ], filename, bundledContent);
}

/** Universal system prompt of one project realm. */
export function loadSystemPromptResolution(directories: AssetDirectories): DefinitionResolution<string> {
  return loadAgentAssetResolution(directories, "system-prompt.md", bundledSystemPrompt);
}

export function loadSystemPrompt(directories: AssetDirectories): string {
  return loadSystemPromptResolution(directories).selected?.value ?? "";
}

/** Engineering doctrine of one project realm: the writing, elegance, and
 *  anti-pattern guidance composed only into prompts of agents that author or
 *  judge code. Read-only research personas opt out via their definition. */
export function loadEngineeringDoctrineResolution(directories: AssetDirectories): DefinitionResolution<string> {
  return loadAgentAssetResolution(directories, "engineering-doctrine.md", bundledEngineeringDoctrine);
}

export function loadEngineeringDoctrine(directories: AssetDirectories): string {
  return loadEngineeringDoctrineResolution(directories).selected?.value ?? "";
}

export type AgentAssetName = "system-prompt.md" | "engineering-doctrine.md";

const bundledAssets = new Map<AgentAssetName, string>();

/** The bundled bytes of one agent asset: the compiled-in manifest in a binary, the source file in a source run. A
 *  loaded asset with these bytes is the bundled one, which alone may carry capability markers (ARCH-CONTEXT-033). */
export function bundledAgentAsset(name: AgentAssetName): string {
  let text = bundledAssets.get(name);
  if (text === undefined) {
    text = (name === "system-prompt.md" ? bundledSystemPrompt : bundledEngineeringDoctrine) || readFileSync(join(sourceRoot, name), "utf8");
    bundledAssets.set(name, text);
  }
  return text;
}
