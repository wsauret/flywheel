import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";


/** Checked in order per directory — first match wins. */
const CANDIDATES = ["agents.md", "AGENTS.md", "CLAUDE.md", "claude.md"] as const;
const MAX_INCLUDE_DEPTH = 5;
const MAX_BYTES = 32_768; // 32 KB cap on total project instructions
const SEPARATOR = "\n\n---\n\n";

// Regex: @ preceded by start-of-line or whitespace (lookbehind), followed by a path.
// Supports escaped spaces (\ ) in paths. Lookbehind ensures leading whitespace
// is not captured into m[0], so replacement doesn't eat surrounding text.
const INCLUDE_RE = /(?<=^|\s)@((?:[^\s\\]|\\ )+)/g;

// Lines that look like code fences — skip @-references inside them.
const FENCE_RE = /^(`{3,}|~{3,})/;


export async function loadProjectInstructions(cwd: string): Promise<string | undefined> {
  const files = await walkForInstructionFiles(cwd);
  if (files.length === 0) return undefined;

  const processed = new Set<string>();
  const sections: string[] = [];

  for (const file of files) {
    const expanded = await expandIncludes(file.path, file.content, processed, 0);
    sections.push(expanded);
  }

  return truncateToLimit(sections);
}


interface ContextFile {
  path: string;
  content: string;
}

async function walkForInstructionFiles(cwd: string): Promise<ContextFile[]> {
  const seen = new Set<string>();
  const ancestors: ContextFile[] = [];

  let current = resolve(cwd);
  for (;;) {
    const file = await probeDir(current);
    if (file && !seen.has(file.path)) {
      seen.add(file.path);
      ancestors.unshift(file); // root-first ordering
    }

    if (await isProjectRoot(current)) break;

    const parent = dirname(current);
    if (parent === current) break; // reached filesystem root
    current = parent;
  }

  return ancestors;
}

async function isProjectRoot(dir: string): Promise<boolean> {
  try {
    await access(join(dir, ".git"), constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function probeDir(dir: string): Promise<ContextFile | null> {
  for (const name of CANDIDATES) {
    const filePath = join(dir, name);
    const file = Bun.file(filePath);
    if (await file.exists()) {
      return { path: filePath, content: await file.text() };
    }
  }
  return null;
}


async function expandIncludes(
  filePath: string,
  content: string,
  processed: Set<string>,
  depth: number,
): Promise<string> {
  const normalized = resolve(filePath);
  if (processed.has(normalized) || depth >= MAX_INCLUDE_DEPTH) return content;
  processed.add(normalized);

  const baseDir = dirname(normalized);
  const paths = extractIncludePaths(content, baseDir);
  if (paths.length === 0) return content;

  let result = content;
  for (const inc of paths) {
    const file = Bun.file(inc.resolved);
    if (!(await file.exists())) continue;
    const incContent = await file.text();
    const expanded = await expandIncludes(inc.resolved, incContent, processed, depth + 1);
    result = result.replace(inc.raw, expanded);
  }

  return result;
}

interface IncludeRef {
  raw: string;
  resolved: string;
}

function extractIncludePaths(content: string, baseDir: string): IncludeRef[] {
  const refs: IncludeRef[] = [];
  const seen = new Set<string>();
  let inFence = false;

  for (const line of content.split("\n")) {
    // Track fenced code blocks — skip @-references inside them.
    const fenceMatch = line.match(FENCE_RE);
    if (fenceMatch) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;

    // Reset regex state for each line.
    INCLUDE_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = INCLUDE_RE.exec(line)) !== null) {
      const rawPath = m[1]!.replace(/\\ /g, " "); // unescape spaces
      const resolved = resolvePath(rawPath, baseDir);
      if (resolved && !seen.has(resolved)) {
        seen.add(resolved);
        refs.push({ raw: m[0]!, resolved });
      }
    }
  }

  return refs;
}


/**
 * Joins sections with separators, dropping root-end sections first if the
 * total exceeds MAX_BYTES. Closest-to-cwd sections (last in array) are
 * highest priority and kept.
 */
function truncateToLimit(sections: string[]): string {
  const full = sections.join(SEPARATOR);
  if (Buffer.byteLength(full, "utf-8") <= MAX_BYTES) return full;

  // Drop from the front (root-end, lowest priority) until we fit.
  let start = 0;
  while (start < sections.length - 1) {
    start++;
    const truncated = "[project instructions truncated]\n\n" + sections.slice(start).join(SEPARATOR);
    if (Buffer.byteLength(truncated, "utf-8") <= MAX_BYTES) return truncated;
  }

  // Even a single section exceeds the limit — hard-truncate the last one.
  const last = sections[sections.length - 1]!;
  const prefix = "[project instructions truncated]\n\n";
  const budget = MAX_BYTES - Buffer.byteLength(prefix, "utf-8");
  return prefix + last.slice(0, budget);
}

function resolvePath(raw: string, baseDir: string): string | null {
  if (raw.startsWith("~/")) {
    return resolve(homedir(), raw.slice(2));
  }
  if (raw.startsWith("./") || raw.startsWith("../")) {
    return resolve(baseDir, raw);
  }
  if (raw.startsWith("/")) {
    return raw.length > 1 ? resolve(raw) : null;
  }
  // Bare relative path — must start with an alphanumeric, dot, or underscore
  // to avoid matching @mentions or special characters.
  if (/^[a-zA-Z0-9._]/.test(raw)) {
    return resolve(baseDir, raw);
  }
  return null;
}
