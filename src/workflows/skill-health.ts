/** Deterministic health check over an installed skill library.
 *
 *  Some skill decay needs no judgment at all: a path either resolves or it does
 *  not, a reference is either named by its body or unreachable, a body is either
 *  inside its budget or past it. Those answers are free, exact, and repeatable,
 *  so they belong in a check rather than in a model's attention.
 *
 *  Inspection writes nothing. An explicit repair rewrites resolved moved paths.
 *  A finding is evidence for the maintenance pass and for
 *  the reader, and the two severities say which is which: `broken` is a defect
 *  that will waste an agent's turn, and `smell` is a shape worth a look that may
 *  be entirely correct. Reporting a smell as a defect trains a reader to ignore
 *  the report, so the distinction is load-bearing.
 *
 *  Decay is the third axis of skill health, after size and duplication, and the
 *  only one no write triggers: a skill nobody touches still rots as the code it
 *  names moves underneath it. */

import { existsSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { basename, join, relative, sep } from "node:path";
import type { ProjectDirectories } from "../infra/directory-authorities.js";
import { ownedSkillStoreDirs } from "./skills.js";
import {
  SKILL_BODY_CROWDED_SHARE,
  skillBodyBudgetChars,
  type SkillDefinition,
  type SkillRegistryRevision,
} from "./skill-schema.js";

/** A reference this large is worth a cohesion look. Size is the smell and not
 *  the rule: a single-topic file this big is fine, because the reader asked for
 *  exactly that topic. It is bundling that hurts, and bundling is not
 *  measurable, so this only ever reports. */

const REFERENCE_LOOK_CHARS = 8_000;

/** Repository roots a skill may name in prose. A path outside these is prose,
 *  not a pointer, and is never checked. */
const REPO_ROOTS = ["docs", "src", "scripts", "tests", "bench", "vscode"];

type SkillFindingKind =
  | "body-over-budget"
  | "body-crowded"
  | "reference-unreachable"
  | "reference-dangling"
  | "reference-large"
  | "path-stale"
  | "skill-pointer-stale"
  | "duplicate-heading";

export interface SkillFinding {
  readonly kind: SkillFindingKind;
  /** `broken` wastes an agent's turn; `smell` may be correct as it stands. */
  readonly severity: "broken" | "smell";
  readonly skill: string;
  /** What a reader should do about it, in one line. */
  readonly detail: string;
  /** The file the finding is in, relative to the package. */
  readonly file?: string;
  readonly path?: string;
  readonly target?: string;
  readonly heading?: string;
  readonly chars?: number;
  /** Where a stale path's basename resolves now, when exactly one file matches. */
  readonly movedTo?: string;
}

interface SkillHealthInput {
  readonly revision: SkillRegistryRevision;
  readonly directories: ProjectDirectories;
  /** Include packages the reader cannot change: bundled, and anything installed
   *  in a shared root Flywheel does not own. Off by default, because a report
   *  full of findings nobody can act on trains its reader to skip it. */
  readonly includeUnowned?: boolean;
}

function canonicalRoot(dir: string): string | undefined {
  try {
    return realpathSync(dir);
  } catch {
    return undefined;
  }
}

function packageFiles(dir: string, prefix = ""): readonly string[] {
  const out: string[] = [];
  let entries: readonly string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    const relativePath = prefix ? `${prefix}/${entry}` : entry;
    try {
      if (statSync(full).isDirectory()) out.push(...packageFiles(full, relativePath));
      else out.push(relativePath);
    } catch {
      continue;
    }
  }
  return out;
}

/** Where a lost path's basename lives now, when exactly one file carries that
 *  name. More than one match is a guess, and a guess in a repair is worse than
 *  a report. */
function movedTo(projectRoot: string, path: string): string | undefined {
  const name = basename(path);
  const matches: string[] = [];
  const walk = (dir: string, depth: number): void => {
    if (depth > 6 || matches.length > 1) return;
    let entries: readonly string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry === "node_modules" || entry.startsWith(".")) continue;
      const full = join(dir, entry);
      try {
        if (statSync(full).isDirectory()) walk(full, depth + 1);
        else if (entry === name) matches.push(relative(projectRoot, full).replaceAll("\\", "/"));
      } catch {
        continue;
      }
      if (matches.length > 1) return;
    }
  };
  for (const root of REPO_ROOTS) {
    const start = join(projectRoot, root);
    if (existsSync(start)) walk(start, 0);
  }
  return matches.length === 1 ? matches[0] : undefined;
}

function inspectPackage(skill: SkillDefinition, dir: string, installedSkills: ReadonlyMap<string, SkillDefinition>, projectRoot: string): readonly SkillFinding[] {
  const findings: SkillFinding[] = [];
  const body = skill.body.trimEnd();
  const add = (finding: Omit<SkillFinding, "skill">): void => { findings.push({ ...finding, skill: skill.id }); };

  const budget = skillBodyBudgetChars(skill);
  if (body.length > budget) {
    add({
      kind: "body-over-budget", severity: "broken", chars: body.length,
      detail: `Body is ${body.length.toLocaleString("en-US")} chars, over the ${budget.toLocaleString("en-US")} budget. Only a direct edit can produce this; every write path refuses it. It may now only shrink.`,
    });
  } else if (body.length >= budget * SKILL_BODY_CROWDED_SHARE) {
    add({
      kind: "body-crowded", severity: "smell", chars: body.length,
      detail: `Body is ${body.length.toLocaleString("en-US")}/${budget.toLocaleString("en-US")} chars. The next writer will have to free space before it can add anything.`,
    });
  }

  const files = packageFiles(dir);
  const referenceFiles = files.filter((path) => path.startsWith("references/"));
  for (const path of referenceFiles) {
    if (!body.includes(basename(path))) {
      add({
        kind: "reference-unreachable", severity: "broken", path,
        detail: `Nothing in the body names ${path}, so no agent can ask for it. Give it a pointer line or remove it.`,
      });
    }
    try {
      const bytes = statSync(join(dir, path)).size;
      if (bytes > REFERENCE_LOOK_CHARS) {
        add({
          kind: "reference-large", severity: "smell", path, chars: bytes,
          detail: `${path} is ${bytes.toLocaleString("en-US")} bytes and arrives whole. Check it is one topic; if a reader wanting part of it must take the rest, split it.`,
        });
      }
    } catch {
      continue;
    }
  }

  for (const file of [{ path: "SKILL.md", text: body }, ...referenceFiles.map((path) => ({ path, text: safeRead(join(dir, path)) }))]) {
    for (const named of new Set(file.text.match(/references\/[A-Za-z0-9._-]+\.md/gu))) {
      if (!files.includes(named)) {
        add({
          kind: "reference-dangling", severity: "broken", file: file.path, path: named,
          detail: `${file.path} points at ${named}, which is not in the package. An agent that follows it loses a turn.`,
        });
      }
    }
    for (const quoted of new Set(file.text.match(/`((?:docs|src|scripts|tests|bench|vscode)\/[A-Za-z0-9._/-]+)`/gu))) {
      const path = quoted.slice(1, -1);
      // A trailing slash names a directory in prose, not a file to open.
      if (path.endsWith("/")) continue;
      // An ellipsis is a placeholder in prose, not a pointer to a file.
      if (path.includes("...")) continue;
      if (existsSync(join(dir, path)) || existsSync(join(projectRoot, path))) continue;
      const moved = movedTo(projectRoot, path);
      add({
        kind: "path-stale", severity: "broken", file: file.path, path,
        ...(moved === undefined ? {} : { movedTo: moved }),
        detail: moved === undefined
          ? `${file.path} names ${path}, which does not exist in the package or the repository.`
          : `${file.path} names ${path}, which does not exist. A file of that name is now at ${moved}.`,
      });
    }
    for (const quoted of new Set(file.text.match(/`([a-z][a-z0-9]*(?:[.-][a-z0-9]+)+)`/gu))) {
      const target = quoted.slice(1, -1);
      if (target.includes("/") || /\.(?:ts|tsx|md|json|toml|ya?ml|jsonl|sqlite)$/u.test(target)) continue;
      const installed = installedSkills.get(target);
      // A token that IS a skill id is a skill reference, whatever the prose
      // around it says. Only an unknown token needs the surrounding words to
      // decide it was meant as one, which is what an id that has since been
      // renamed away looks like.
      if (installed === undefined && !mentionsSkill(file.text, quoted)) continue;
      if (installed !== undefined) continue;
      add({
        kind: "skill-pointer-stale", severity: "broken", file: file.path, target,
        detail: `${file.path} tells an agent to use the "${target}" skill, which is not installed. Loading it fails.`,
      });
    }
  }

  const headings = body.split("\n").filter((line) => /^#{2,3} /u.test(line)).map((line) => line.trim());
  const seen = new Map<string, number>();
  for (const heading of headings) seen.set(heading, (seen.get(heading) ?? 0) + 1);
  for (const [heading, count] of seen) {
    if (count < 2) continue;
    add({
      kind: "duplicate-heading", severity: "smell", heading,
      detail: `"${heading}" appears ${count} times, so content that belongs together is split and a reader may only find the first.`,
    });
  }

  return findings;
}

/** Whether the prose around a token treats it as a skill. Only consulted for a
 *  token that matches no installed id, where the words are the only evidence
 *  that a skill was meant. */
function mentionsSkill(text: string, quoted: string): boolean {
  const at = text.indexOf(quoted);
  if (at < 0) return false;
  return /skill/iu.test(text.slice(Math.max(0, at - 120), at + 120));
}

function safeRead(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

/** Inspect every installed filesystem package. Read-only. */
export function inspectSkillLibrary(input: SkillHealthInput): readonly SkillFinding[] {
  const installedSkills = input.revision.skills;
  const owned = ownedSkillStoreDirs(input.directories);
  const ownedRoots = [owned.project, owned.user].map((root) => canonicalRoot(root)).filter((root): root is string => root !== undefined);
  const findings: SkillFinding[] = [];
  for (const skill of input.revision.skills.values()) {
    if (skill.source.kind !== "filesystem") continue;
    const dir = skill.source.canonicalDir;
    if (input.includeUnowned !== true && !ownedRoots.some((root) => dir.startsWith(`${root}${sep}`))) continue;
    findings.push(...inspectPackage(skill, dir, installedSkills, input.directories.projectRoot));
  }
  return findings;
}

/** Repair the one finding class a machine can settle: a path whose basename
 *  resolves to exactly one file in the repository has moved, and rewriting it
 *  is mechanical. Every other finding needs a decision and is only reported.
 *  Returns the findings it repaired, and the relocatable findings it left in
 *  linked packages, which the person edits where the link points. */
export function repairMovedPaths(findings: readonly SkillFinding[], revision: SkillRegistryRevision) {
  const repaired: SkillFinding[] = [];
  const linked: SkillFinding[] = [];
  const byFile = new Map<string, SkillFinding[]>();
  for (const finding of findings) {
    if (finding.kind !== "path-stale" || finding.movedTo === undefined || finding.file === undefined) continue;
    const skill = revision.skills.get(finding.skill);
    if (!skill || skill.source.kind !== "filesystem") continue;
    // Flywheel never writes through a linked package (ARCH-BOUNDARIES-008).
    if (skill.source.linked) {
      linked.push(finding);
      continue;
    }
    const target = join(skill.source.canonicalDir, finding.file);
    byFile.set(target, [...(byFile.get(target) ?? []), finding]);
  }
  for (const [target, entries] of byFile) {
    let text: string;
    try {
      text = readFileSync(target, "utf8");
    } catch {
      continue;
    }
    let next = text;
    for (const entry of entries) {
      if (entry.path === undefined || entry.movedTo === undefined) continue;
      next = next.split(`\`${entry.path}\``).join(`\`${entry.movedTo}\``);
    }
    if (next === text) continue;
    try {
      writeFileSync(target, next);
      repaired.push(...entries);
    } catch {
      continue;
    }
  }
  return { repaired, linked };
}
