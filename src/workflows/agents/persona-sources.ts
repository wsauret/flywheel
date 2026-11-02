// node:fs sync APIs let persona sources resolve at module init (agent-roles) while
// remaining trivially consumable from the async installer; one loader, one source.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { agents as manifestAgents } from "./manifest.js";

export interface PersonaSources {
  readonly [path: string]: string;
}

interface MutablePersonaSources {
  [path: string]: string;
}

function readMarkdownFilesRecursive(dir: string): MutablePersonaSources {
  const files: MutablePersonaSources = {};

  function visit(currentDir: string, prefix = ""): void {
    const entries = readdirSync(currentDir, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of entries) {
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolutePath = join(currentDir, entry.name);

      if (entry.isDirectory()) {
        visit(absolutePath, relativePath);
      } else if (entry.isFile() && entry.name.endsWith(".md")) {
        files[relativePath] = readFileSync(absolutePath, "utf8");
      }
    }
  }

  visit(dir);
  return files;
}

/** Compiled binaries carry personas in the bundled manifest; dev mode (empty
 * manifest) reads them from the source tree. */
export function loadPersonaSources(): PersonaSources {
  if (Object.keys(manifestAgents).length > 0) return manifestAgents;
  const personaDir = join(fileURLToPath(new URL(".", import.meta.url)), "personas");
  try {
    return readMarkdownFilesRecursive(personaDir);
  } catch {
    // Persona dir unavailable (e.g. minimal test env); callers fall back to /
    // warn on the empty set.
    return {};
  }
}
