// fs/promises used intentionally — Bun has no readdir equivalent.
import { mkdir, readdir, readFile, rm, writeFile } from "fs/promises";
import { join } from "path";
import { homedir } from "os";
import { Log } from "../../infra/log.js";
import { errorMessage } from "../../infra/error-message.js";
import { agents as manifestAgents, skills as manifestSkills } from "./manifest.js";

const log = Log.create({ service: "agent-installer" });

interface InstallResult {
  installed: number;
  skipped: number;
  errors: string[];
}


interface AgentSources {
  agents: Record<string, string>;
  skills: Record<string, { skill: string; references: Record<string, string> }>;
}

function getSourceDir(): string {
  return new URL(".", import.meta.url).pathname;
}

async function readFromFilesystem(): Promise<AgentSources> {
  const baseDir = getSourceDir();
  const agents: Record<string, string> = {};
  const skills: AgentSources["skills"] = {};

  const personaDir = join(baseDir, "personas", "fly");
  const personaFiles = (await readdir(personaDir)).filter((f) => f.endsWith(".md"));
  for (const file of personaFiles) {
    agents[file] = await readFile(join(personaDir, file), "utf-8");
  }

  const skillsDir = join(baseDir, "skills");
  const skillEntries = await readdir(skillsDir, { withFileTypes: true });
  for (const entry of skillEntries) {
    if (!entry.isDirectory()) continue;
    const skillSrc = join(skillsDir, entry.name);
    let skillContent: string;
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

  return { agents, skills };
}

async function loadSources(): Promise<AgentSources> {
  try {
    return await readFromFilesystem();
  } catch {
    // Filesystem unavailable (compiled binary) — use bundled manifest
  }
  if (Object.keys(manifestAgents).length === 0) {
    throw new Error("no agent sources available (filesystem failed, manifest empty)");
  }
  return { agents: manifestAgents, skills: manifestSkills };
}


async function writeIfChanged(
  destPath: string,
  content: string,
): Promise<"installed" | "skipped"> {
  try {
    const existing = await readFile(destPath, "utf-8");
    if (existing === content) return "skipped";
  } catch {
    // File doesn't exist — will write
  }
  await writeFile(destPath, content, "utf-8");
  return "installed";
}

async function installAgentFiles(
  agents: Record<string, string>,
  result: InstallResult,
): Promise<void> {
  const targetDir = join(homedir(), ".claude", "agents", "fly");
  const files = Object.keys(agents);

  if (files.length === 0) {
    log.warn("no persona files found");
    return;
  }

  // We own the entire fly/ directory — wipe and re-copy for a clean slate
  try {
    await rm(targetDir, { recursive: true, force: true });
  } catch {
    // Directory may not exist yet
  }

  try {
    await mkdir(targetDir, { recursive: true });
  } catch (err) {
    result.errors.push(`failed to create agents dir ${targetDir}: ${errorMessage(err)}`);
    return;
  }

  for (const file of files) {
    try {
      await writeFile(join(targetDir, file), agents[file]!, "utf-8");
      result.installed++;
    } catch (err) {
      result.errors.push(`failed to install agent ${file}: ${errorMessage(err)}`);
    }
  }
}

async function installSkillFiles(
  skills: AgentSources["skills"],
  result: InstallResult,
): Promise<void> {
  const targetBase = join(homedir(), ".claude", "skills");

  for (const [skillName, { skill, references }] of Object.entries(skills)) {
    const skillDest = join(targetBase, skillName);

    try {
      await mkdir(skillDest, { recursive: true });
    } catch (err) {
      result.errors.push(`failed to create skill dir ${skillDest}: ${errorMessage(err)}`);
      continue;
    }

    try {
      const outcome = await writeIfChanged(join(skillDest, "SKILL.md"), skill);
      if (outcome === "installed") result.installed++;
      else result.skipped++;
    } catch (err) {
      result.errors.push(`failed to install skill ${skillName}/SKILL.md: ${errorMessage(err)}`);
    }

    const refsDest = join(skillDest, "references");
    try {
      await rm(refsDest, { recursive: true, force: true });
    } catch {
      // May not exist
    }

    const refEntries = Object.entries(references);
    if (refEntries.length === 0) continue;

    try {
      await mkdir(refsDest, { recursive: true });
    } catch (err) {
      result.errors.push(`failed to create ${refsDest}: ${errorMessage(err)}`);
      continue;
    }

    for (const [file, content] of refEntries) {
      try {
        await writeFile(join(refsDest, file), content, "utf-8");
        result.installed++;
      } catch (err) {
        result.errors.push(
          `failed to install skill ${skillName}/references/${file}: ${errorMessage(err)}`,
        );
      }
    }
  }
}

export async function installAgents(): Promise<InstallResult> {
  const result: InstallResult = { installed: 0, skipped: 0, errors: [] };

  const sources = await loadSources();
  await installAgentFiles(sources.agents, result);
  await installSkillFiles(sources.skills, result);

  log.info("agent installation complete", {
    installed: result.installed,
    skipped: result.skipped,
    errors: result.errors.length,
  });

  return result;
}
