// Manifest writers for the binary build.
//
// Two generated manifests carry runtime prompt assets inline:
//   src/workflows/agents/manifest.ts   persona markdown, skill packages, shared
//     reference assets and workflow output contract files
//   src/infra/agent-assets/manifest.ts the runner-universal system prompt
//
// Invoked by scripts/build-binary.ts before bundling, then restored to the
// checked-in empty defaults after bundling.

import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { DEFINITION_ASSET_EXTENSIONS } from "../src/workflows/definition-assets.js";
import { BUNDLED_REFERENCE_DIR, BUNDLED_SKILL_DIR } from "../src/workflows/skill-source-inventory.js";

const ROOT = join(import.meta.dir, "..");
const WORKFLOWS_SRC = join(ROOT, "src", "workflows");
const AGENT_ASSETS_SRC = join(ROOT, "src", "infra", "agent-assets");

interface TextByPath {
  [path: string]: string;
}

/** First line of a generated manifest, which tells a stale generated artifact
 *  from the checked-in empty default. */
const POPULATED_MANIFEST_HEADER = "// Populated by scripts/build-binary.ts - restored to empty defaults after bundling";

const EMPTY_WORKFLOW_MANIFEST_SOURCE = [
  "// Workflow asset manifest: static source of runtime prompt assets.",
  "//",
  "// Defaults to empty (dev mode reads from filesystem instead).",
  "// build-binary.ts populates these with real content before bundling,",
  "// so compiled binaries carry the definition and prompt asset files inline.",
  "",
  "export interface WorkflowAssets { [path: string]: string }",
  "export const workflowAssets: WorkflowAssets = {};",
  "",
  "export const agents: WorkflowAssets = {};",
  "",
  "export const skillDefinitions: WorkflowAssets = {};",
  "",
].join("\n");

const EMPTY_AGENT_ASSETS_MANIFEST_SOURCE = [
  "// Agent asset manifest: static source of the runner-universal system prompt.",
  "//",
  "// Defaults to empty (dev mode reads from the filesystem instead).",
  "// build-binary.ts populates this with real content before bundling,",
  "// so compiled binaries carry the prompt text inline.",
  "",
  'export const systemPromptText = "";',
  'export const engineeringDoctrineText = "";',
  "",
].join("\n");

const SKILL_REFERENCE_PATTERN = /\{\{ref:([a-z0-9-]+)\}\}/g;

export async function writeWorkflowManifest(destPath: string): Promise<void> {
  const workflowAssets = await collectWorkflowAssets();
  const agents = filesUnderPrefix(workflowAssets, "agents/personas/");
  const skillDefinitions = await collectSkillPackageFiles();
  validateSkillReferenceManifest(skillDefinitions, workflowAssets);

  const code = [
    POPULATED_MANIFEST_HEADER,
    "",
    `export interface WorkflowAssets { [path: string]: string }\nexport const workflowAssets: WorkflowAssets = ${JSON.stringify(workflowAssets, null, 2)};`,
    "",
    `export const agents: WorkflowAssets = ${JSON.stringify(agents, null, 2)};`,
    "",
    `export const skillDefinitions: WorkflowAssets = ${JSON.stringify(skillDefinitions, null, 2)};`,
    "",
  ].join("\n");

  await Bun.write(destPath, code);
}

/** The universal system prompt and the engineering doctrine are runner-wide,
 *  so they are embedded from their infra home rather than from the workflow
 *  asset tree. */
export async function writeAgentAssetsManifest(destPath: string): Promise<void> {
  const systemPromptText = await Bun.file(join(AGENT_ASSETS_SRC, "system-prompt.md")).text();
  const engineeringDoctrineText = await Bun.file(join(AGENT_ASSETS_SRC, "engineering-doctrine.md")).text();

  const code = [
    POPULATED_MANIFEST_HEADER,
    "",
    `export const systemPromptText = ${JSON.stringify(systemPromptText)};`,
    `export const engineeringDoctrineText = ${JSON.stringify(engineeringDoctrineText)};`,
    "",
  ].join("\n");

  await Bun.write(destPath, code);
}

export interface GeneratedManifest {
  /** Source path of the checked-in manifest this entry generates. */
  path: string;
  /** Checked-in empty default, which is what dev mode reads. */
  emptySource: string;
  write(destPath: string): Promise<void>;
}

/** Every generated manifest: build-binary.ts populates them before bundling and
 *  restores them afterwards, including after a failed bundle. */
export const GENERATED_MANIFESTS: readonly GeneratedManifest[] = [
  {
    path: join(WORKFLOWS_SRC, "agents", "manifest.ts"),
    emptySource: EMPTY_WORKFLOW_MANIFEST_SOURCE,
    write: writeWorkflowManifest,
  },
  {
    path: join(AGENT_ASSETS_SRC, "manifest.ts"),
    emptySource: EMPTY_AGENT_ASSETS_MANIFEST_SOURCE,
    write: writeAgentAssetsManifest,
  },
];

/** What a manifest must be restored to once the build is done. A previous
 *  interrupted build can leave generated content on disk, so a populated file
 *  restores to the checked-in empty default, never to the stale artifact. */
export function manifestRestoreSource(manifest: GeneratedManifest, currentSource: string): string {
  return currentSource.startsWith(POPULATED_MANIFEST_HEADER) ? manifest.emptySource : currentSource;
}

/** Prompt assets outside the skill packages. Skill packages are their own
 *  manifest lane, keyed by package, so their files never appear twice. */
export async function collectWorkflowAssets(): Promise<TextByPath> {
  return { ...await readTextFilesRecursive(WORKFLOWS_SRC, DEFINITION_ASSET_EXTENSIONS), ...await collectReferenceFiles() };
}

/** Bundled skill packages, keyed `<package>/<path>`, which is what the skill
 *  loader reads when the source tree is absent. Every file of a package is
 *  carried, not only markdown, because a package's resources are part of it:
 *  bundled packages therefore hold UTF-8 text only. The `references/` child
 *  holds no package and ships through the workflow asset lane. */
export async function collectSkillPackageFiles(packageDir = BUNDLED_SKILL_DIR): Promise<TextByPath> {
  if (!existsSync(packageDir)) return {};
  return Object.fromEntries(
    Object.entries(await readTextFilesRecursive(packageDir)).filter(([path]) => !path.startsWith("references/")),
  );
}

async function collectReferenceFiles(): Promise<TextByPath> {
  if (!existsSync(BUNDLED_REFERENCE_DIR)) return {};
  const files = await readTextFilesRecursive(BUNDLED_REFERENCE_DIR, [".md"]);
  return Object.fromEntries(Object.entries(files).map(([path, content]) => [`references/${path}`, content]));
}

async function readTextFilesRecursive(dir: string, extensions?: readonly string[]): Promise<TextByPath> {
  const contents: TextByPath = {};

  async function visit(currentDir: string, prefix = ""): Promise<void> {
    const entries = (await readdir(currentDir, { withFileTypes: true }))
      .sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of entries) {
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolutePath = join(currentDir, entry.name);

      if (entry.isDirectory()) {
        await visit(absolutePath, relativePath);
      } else if (entry.isFile() && (extensions?.some((extension) => entry.name.endsWith(extension)) ?? true)) {
        contents[relativePath] = await Bun.file(absolutePath).text();
      }
    }
  }

  await visit(dir);
  return contents;
}

function filesUnderPrefix(files: TextByPath, prefix: string): TextByPath {
  return Object.fromEntries(
    Object.entries(files)
      .filter(([file]) => file.startsWith(prefix))
      .map(([file, content]) => [file.slice(prefix.length), content]),
  );
}

/** Every `{{ref:...}}` in a skill package must name an
 *  embedded reference, because the binary has no other source for it. */
export function validateSkillReferenceManifest(
  skillDefinitions: TextByPath,
  workflowAssets: TextByPath,
): void {
  const referenceIds = new Set(
    Object.keys(workflowAssets)
      .filter((file) => file.startsWith("references/") && file.endsWith(".md"))
      .map((file) => file.slice("references/".length, -".md".length)),
  );
  const errors: string[] = [];

  for (const [file, body] of Object.entries(skillDefinitions)) {
    for (const match of body.matchAll(SKILL_REFERENCE_PATTERN)) {
      const referenceId = match[1];
      if (referenceId === undefined || !referenceIds.has(referenceId)) {
        errors.push(`${file} references missing skill reference ${referenceId}.md`);
      }
    }
  }

  if (errors.length > 0) {
    throw new Error(`Skill reference manifest is incomplete:\n${errors.join("\n")}`);
  }
}
