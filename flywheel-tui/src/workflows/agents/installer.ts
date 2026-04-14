// Agent Installer — syncs persona + skill files to Claude Code discovery paths
//
// Claude Code discovers agents and skills from:
//
//   ~/.claude/agents/fly/*.md             (agents)
//   ~/.claude/skills/<name>/SKILL.md      (skills)
//   ~/.claude/skills/<name>/references/   (skill references, optional)
//
// This module copies bundled persona and skill files from the repo into those
// locations so that flywheel workers can resolve agents via the Task tool, and
// agents can load the skills they reference.
//
// Idempotent: overwrites files that changed, skips identical ones.

import { mkdir, readdir, readFile, writeFile } from "fs/promises";
import { join } from "path";
import { homedir } from "os";
import { Log } from "../../infra/log.js";
import { errorMessage } from "../../infra/error-message.js";

const log = Log.create({ service: "agent-installer" });

// Source directories — bundled personas and skills in the repo

function getAgentSourceDir(): string {
  const thisDir = new URL(".", import.meta.url).pathname;
  return join(thisDir, "personas", "fly");
}

function getSkillSourceDir(): string {
  const thisDir = new URL(".", import.meta.url).pathname;
  return join(thisDir, "skills");
}

// Public API

interface InstallResult {
  installed: number;
  skipped: number;
  errors: string[];
}

// Shared helpers

/** Write a file if its content differs from what's already on disk. */
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

// Agent installation

async function installAgentFiles(result: InstallResult): Promise<void> {
  const sourceDir = getAgentSourceDir();
  const targetDir = join(homedir(), ".claude", "agents", "fly");

  let sourceFiles: string[];
  try {
    sourceFiles = (await readdir(sourceDir)).filter((f) => f.endsWith(".md"));
  } catch (err) {
    result.errors.push(`failed to read source personas: ${errorMessage(err)}`);
    return;
  }

  if (sourceFiles.length === 0) {
    log.warn("no persona files found in source directory", { dir: sourceDir });
    return;
  }

  try {
    await mkdir(targetDir, { recursive: true });
  } catch (err) {
    result.errors.push(`failed to create agents dir ${targetDir}: ${errorMessage(err)}`);
    return;
  }

  for (const file of sourceFiles) {
    try {
      const content = await readFile(join(sourceDir, file), "utf-8");
      const outcome = await writeIfChanged(join(targetDir, file), content);
      if (outcome === "installed") result.installed++;
      else result.skipped++;
    } catch (err) {
      result.errors.push(`failed to install agent ${file}: ${errorMessage(err)}`);
    }
  }
}

// Skill installation

async function installSkillFiles(result: InstallResult): Promise<void> {
  const sourceDir = getSkillSourceDir();
  const home = homedir();
  const targetBase = join(home, ".claude", "skills");

  let skillDirs: string[];
  try {
    const entries = await readdir(sourceDir, { withFileTypes: true });
    skillDirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch (err) {
    result.errors.push(`failed to read source skills: ${errorMessage(err)}`);
    return;
  }

  for (const skillName of skillDirs) {
    const skillSrc = join(sourceDir, skillName);
    const skillDest = join(targetBase, skillName);

    try {
      await mkdir(skillDest, { recursive: true });
    } catch (err) {
      result.errors.push(`failed to create skill dir ${skillDest}: ${errorMessage(err)}`);
      continue;
    }

    // Install SKILL.md
    try {
      const content = await readFile(join(skillSrc, "SKILL.md"), "utf-8");
      const outcome = await writeIfChanged(join(skillDest, "SKILL.md"), content);
      if (outcome === "installed") result.installed++;
      else result.skipped++;
    } catch (err) {
      result.errors.push(`failed to install skill ${skillName}/SKILL.md: ${errorMessage(err)}`);
    }

    // Install references/ if present
    const refsSrc = join(skillSrc, "references");
    let refFiles: string[];
    try {
      refFiles = (await readdir(refsSrc)).filter((f) => f.endsWith(".md"));
    } catch {
      continue; // No references dir — that's fine
    }

    const refsDest = join(skillDest, "references");
    try {
      await mkdir(refsDest, { recursive: true });
    } catch (err) {
      result.errors.push(`failed to create ${refsDest}: ${errorMessage(err)}`);
      continue;
    }

    for (const file of refFiles) {
      try {
        const content = await readFile(join(refsSrc, file), "utf-8");
        const outcome = await writeIfChanged(join(refsDest, file), content);
        if (outcome === "installed") result.installed++;
        else result.skipped++;
      } catch (err) {
        result.errors.push(`failed to install skill ${skillName}/references/${file}: ${errorMessage(err)}`);
      }
    }
  }
}

// Public API

/**
 * Install agent persona and skill files to Claude Code discovery paths.
 *
 * - Creates target directories if they don't exist
 * - Overwrites files that have changed (content comparison)
 * - Skips files that are already identical
 * - Continues on individual file errors
 */
export async function installAgents(): Promise<InstallResult> {
  const result: InstallResult = { installed: 0, skipped: 0, errors: [] };

  await installAgentFiles(result);
  await installSkillFiles(result);

  log.info("agent installation complete", {
    installed: result.installed,
    skipped: result.skipped,
    errors: result.errors.length,
  });

  return result;
}


