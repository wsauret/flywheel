// fs/promises used for mkdir/readdir/rm — Bun has no equivalents for these.
import { mkdir, readdir, rm } from "fs/promises";
import { join } from "path";
import { homedir } from "os";
import * as yaml from "js-yaml";
import { Log } from "../../infra/log.js";
import { errorMessage } from "../../infra/error-message.js";
import { parseFrontmatter } from "../../infra/frontmatter.js";
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

async function readMdFilesFromDir(dirPath: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  try {
    const files = (await readdir(dirPath)).filter((f) => f.endsWith(".md"));
    for (const file of files) {
      result[file] = await Bun.file(join(dirPath, file)).text();
    }
  } catch {
    // Directory may not exist
  }
  return result;
}

async function readFromFilesystem(): Promise<AgentSources> {
  const baseDir = getSourceDir();
  const agents: Record<string, string> = {};
  const skills: AgentSources["skills"] = {};

  const personaDir = join(baseDir, "personas", "fly");
  Object.assign(agents, await readMdFilesFromDir(personaDir));

  const skillsDir = join(baseDir, "skills");
  const skillEntries = await readdir(skillsDir, { withFileTypes: true });
  for (const entry of skillEntries) {
    if (!entry.isDirectory()) continue;
    const skillSrc = join(skillsDir, entry.name);
    let skillContent: string;
    try {
      skillContent = await Bun.file(join(skillSrc, "SKILL.md")).text();
    } catch {
      continue;
    }
    const refs: Record<string, string> = {};
    try {
      const refFiles = (await readdir(join(skillSrc, "references"))).filter((f) =>
        f.endsWith(".md"),
      );
      for (const ref of refFiles) {
        refs[ref] = await Bun.file(join(skillSrc, "references", ref)).text();
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
    const existing = await Bun.file(destPath).text();
    if (existing === content) return "skipped";
  } catch {
    // File doesn't exist — will write
  }
  await Bun.write(destPath, content);
  return "installed";
}

async function installAgentFilesToDir(
  agents: Record<string, string>,
  targetDir: string,
  result: InstallResult,
): Promise<void> {
  const files = Object.keys(agents);
  if (files.length === 0) return;

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
      await Bun.write(join(targetDir, file), agents[file]!);
      result.installed++;
    } catch (err) {
      result.errors.push(`failed to install agent ${file}: ${errorMessage(err)}`);
    }
  }
}

type Destination = "claude" | "harness";

// Top-level `tier:` is canonical (powerful/mid/cheap/inherit). The installer
// projects it to each target's vocabulary: a Claude `model:` short name, or
// the harness's own `tier:` field. `inherit` becomes "no pin" — Claude omits
// `model:` so the session model is used; the harness skips `tier:` so the
// subagent inherits from the parent at runtime.
const TIER_TO_CLAUDE_MODEL: Record<string, string> = {
  powerful: "opus",
  mid: "sonnet",
  cheap: "haiku",
};

// Projects the canonical frontmatter down to the flat shape each destination
// expects. Returns null when the persona has no subtree for this destination —
// those personas are skipped at install time so each registry only sees agents
// it can actually run.
function projectPersona(content: string, destination: Destination): string | null {
  const parsed = parseFrontmatter(content);
  if (!parsed) return null;

  const fm = parsed.frontmatter;
  const section = fm[destination];
  if (!section || typeof section !== "object") return null;

  const tier = typeof fm.tier === "string" ? fm.tier : "inherit";
  const sectionFields = section as Record<string, unknown>;

  const projected: Record<string, unknown> = {
    name: fm.name,
    description: fm.description,
  };

  if (destination === "claude") {
    const model = TIER_TO_CLAUDE_MODEL[tier];
    if (model) projected.model = model;
  } else {
    if (tier !== "inherit") projected.tier = tier;
  }

  Object.assign(projected, sectionFields);

  const yamlText = yaml.dump(projected, { lineWidth: -1, noRefs: true }).trimEnd();
  return `---\n${yamlText}\n---\n${parsed.body}`;
}

function projectAll(agents: Record<string, string>, destination: Destination): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [filename, content] of Object.entries(agents)) {
    const projected = projectPersona(content, destination);
    if (projected) out[filename] = projected;
  }
  return out;
}

async function installAgentFiles(
  agents: Record<string, string>,
  result: InstallResult,
): Promise<void> {
  if (Object.keys(agents).length === 0) {
    log.warn("no persona files found");
    return;
  }

  await installAgentFilesToDir(
    projectAll(agents, "claude"),
    join(homedir(), ".claude", "agents", "fly"),
    result,
  );
  await installAgentFilesToDir(
    projectAll(agents, "harness"),
    join(homedir(), ".flywheel", "agents"),
    result,
  );
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
        await Bun.write(join(refsDest, file), content);
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
