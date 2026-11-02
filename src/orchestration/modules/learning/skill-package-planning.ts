import type { PreparedFile, PreparedPackage } from "../../agent-runtime/review-types.js";
import { Buffer } from "node:buffer";
import { containsSecret } from "../../../infra/redact-secrets.js";
import { parseFrontmatter } from "../../../infra/frontmatter.js";
import { bindPackageDir, readManifestPackage, readSkillPackage, readSkillPackageFiles } from "../../../workflows/skill-context.js";
import { normalizeSkillFrontmatter, SKILL_FILE, SKILL_LIMITS } from "../../../workflows/skill-schema.js";


export function prepareSkillPackage(files: ReadonlyMap<string, string>): { package: PreparedPackage } | { error: string } {
  try {
    const admitted = readManifestPackage(files);
    const ordered: PreparedFile[] = [
      { path: SKILL_FILE, bytes: Buffer.byteLength(admitted.skillFile, "utf8"), content: admitted.skillFile },
      ...admitted.resources.map((resource) => ({ path: resource.path, bytes: resource.bytes, content: files.get(resource.path) ?? "" })),
    ];
    const sensitive = ordered.find((file) => containsSecret(file.content));
    if (sensitive) {
      return { error: `Package file ${sensitive.path} contains a recognized credential value, and a plan of this mutation would retain every package byte durably. Remove the credential from the package (or replace it with a placeholder) and try again.` };
    }
    return { package: { files: ordered, identity: admitted.identity } };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

export function composeSkillFile(description: string, managed: "flywheel" | "user", createdBy: string, updatedBy: string, body: string, dependencies: readonly string[]): string {
  const frontmatter = [
    "---",
    `description: ${JSON.stringify(description)}`,
    ...(dependencies.length === 0 ? [] : ["dependencies:", ...dependencies.map((dependency) => `  - ${dependency}`)]),
    `managed: ${managed}`,
    "provenance:",
    `  createdBy: ${JSON.stringify(createdBy)}`,
    `  updatedBy: ${JSON.stringify(updatedBy)}`,
    "---",
  ].join("\n");
  return `${frontmatter}\n${body.trim()}\n`;
}

/** Validate a composed or patched SKILL.md exactly the way admission will. */
export function validateSkillFile(content: string): { trigger: string } | { error: string } {
  const parsed = parseFrontmatter(content);
  if (!parsed) return { error: `${SKILL_FILE} must keep valid YAML frontmatter; the change would break it.` };
  const bodyBytes = Buffer.byteLength(parsed.body, "utf8");
  const metadataBytes = Buffer.byteLength(content, "utf8") - bodyBytes;
  if (metadataBytes > SKILL_LIMITS.metadataBytes) return { error: `Frontmatter would be ${metadataBytes} bytes, over the ${SKILL_LIMITS.metadataBytes}-byte admission limit.` };
  if (bodyBytes > SKILL_LIMITS.bodyBytes) return { error: `${SKILL_FILE} body would be ${bodyBytes} bytes, over the ${SKILL_LIMITS.bodyBytes}-byte admission limit; move detail into support files (references/, templates/, scripts/, assets/).` };
  try {
    return { trigger: normalizeSkillFrontmatter(parsed.frontmatter).trigger };
  } catch (err) {
    return { error: `Frontmatter would not normalize: ${err instanceof Error ? err.message : String(err)}` };
  }
}

export function readPackageFiles(dir: string): ReadonlyMap<string, string> {
  const binding = bindPackageDir(dir);
  return binding ? readSkillPackageFiles(binding, "external") ?? new Map<string, string>() : new Map<string, string>();
}

export function packageDigestAt(dir: string): string | undefined {
  try {
    const binding = bindPackageDir(dir);
    return binding ? readSkillPackage(binding, "external")?.identity.sha256 : undefined;
  } catch {
    return undefined;
  }
}
