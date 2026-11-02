import { realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { bytesIdentity } from "../../src/orchestration/modules/development/benchmark/content-identity.js";
import { readJsonFile } from "../../src/orchestration/modules/development/benchmark/json-lines.js";

/** The ledger reference of an artifact below the campaign directory. Ledgers are portable records, so the
 * reference is a POSIX relative path on every OS and resolves on any OS that reads the ledger. */
export function campaignArtifactReference(directory: string, path: string): string {
  return relative(directory, path).split(sep).join("/");
}

/** Resolve a campaign-relative artifact without following a parent link outside its owner.
 * Missing files remain valid paths so interrupted workers can have incomplete evidence. */
async function campaignArtifactPath(directory: string, path: string): Promise<string> {
  const root = await realpath(directory);
  const target = resolve(root, path);
  const inside = (candidate: string) => {
    const suffix = relative(root, candidate);
    return suffix !== ".." && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix);
  };
  if (isAbsolute(path) || target === root || !inside(target)) throw new Error("Artifact escapes campaign directory");
  let existing = target;
  while (true) {
    try {
      if (!inside(await realpath(existing))) throw new Error("Artifact escapes campaign directory");
      return target;
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
      existing = dirname(existing);
    }
  }
}

/** Read the exact retained artifact. Missing or changed bytes refuse reuse. */
export async function readCampaignArtifact(directory: string, artifact: { readonly path: string; readonly sha256: string }): Promise<string> {
  const text = await readAvailableCampaignArtifact(directory, artifact);
  if (text === undefined) throw new Error("Artifact hash changed or is missing");
  return text;
}

/** Read retained bytes when present. Missing evidence is unavailable; changed bytes still refuse reuse. */
export async function readAvailableCampaignArtifact(directory: string, artifact: { readonly path: string; readonly sha256: string }): Promise<string | undefined> {
  const text = await readJsonFile(await campaignArtifactPath(directory, artifact.path));
  if (text !== undefined && bytesIdentity(text) !== artifact.sha256) throw new Error("Artifact hash changed or is missing");
  return text;
}
