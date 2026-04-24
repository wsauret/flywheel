// Manifest writer for the binary build.
//
// Generates src/workflows/agents/manifest.ts with three exports:
//   - agents:      canonical persona file contents keyed by filename
//   - skills:      skill directories keyed by name with SKILL.md + references
//   - stepMarkdown: .md files under src/workflows/queue/steps keyed by path
//                   relative to src/ (e.g. "workflows/queue/steps/sprint/preamble.md")
//
// Invoked by scripts/build-binary.ts before bundling, then restored to the
// checked-in empty default after bundling.

import { readdir, readFile } from "fs/promises";
import { join } from "path";

const ROOT = join(import.meta.dir, "..");
const AGENTS_SRC = join(ROOT, "src", "workflows", "agents");

export async function writeManifest(destPath: string): Promise<void> {
  const agents: Record<string, string> = {};
  const skills: Record<string, { skill: string; references: Record<string, string> }> = {};
  const stepMarkdown: Record<string, string> = {};

  // Read canonical agent persona files. The runtime installer projects each
  // file to the right shape for Claude (`~/.claude/agents/fly/`) and the
  // harness (`~/.flywheel/agents/`), so the manifest only needs the canonical
  // form.
  const personaDir = join(AGENTS_SRC, "personas", "fly");
  const mdFiles = (await readdir(personaDir)).filter((f) => f.endsWith(".md"));
  for (const file of mdFiles) {
    agents[file] = await readFile(join(personaDir, file), "utf-8");
  }

  // Read skill files
  const skillsDir = join(AGENTS_SRC, "skills");
  const entries = await readdir(skillsDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const skillSrc = join(skillsDir, entry.name);
    let skillContent = "";
    try {
      skillContent = await readFile(join(skillSrc, "SKILL.md"), "utf-8");
    } catch {
      continue;
    }

    const refs: Record<string, string> = {};
    try {
      const refFiles = (await readdir(join(skillSrc, "references"))).filter((f) =>
        f.endsWith(".md"),
      );
      for (const ref of refFiles) {
        refs[ref] = await readFile(join(skillSrc, "references", ref), "utf-8");
      }
    } catch {
      // No references — fine
    }

    skills[entry.name] = { skill: skillContent, references: refs };
  }

  // Read step markdown files (keyed by path relative to src/).
  const stepsDir = join(ROOT, "src", "workflows", "queue", "steps");
  const stepsGlob = new Bun.Glob("**/*.md");
  for await (const rel of stepsGlob.scan({ cwd: stepsDir })) {
    const abs = join(stepsDir, rel);
    stepMarkdown[`workflows/queue/steps/${rel}`] = await readFile(abs, "utf-8");
  }

  const code = [
    "// Populated by scripts/build-binary.ts — restored to empty defaults after bundling",
    "",
    `export const agents: Record<string, string> = ${JSON.stringify(agents, null, 2)};`,
    "",
    `export const skills: Record<string, { skill: string; references: Record<string, string> }> = ${JSON.stringify(skills, null, 2)};`,
    "",
    `export const stepMarkdown: Record<string, string> = ${JSON.stringify(stepMarkdown, null, 2)};`,
    "",
  ].join("\n");

  await Bun.write(destPath, code);
}
