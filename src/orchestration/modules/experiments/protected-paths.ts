import { isAbsolute, relative, resolve, sep } from "node:path"
import { physicalPathWithMissingTail } from "../../../infra/canonical-path.js"

function slash(path: string): string {
  return path.replaceAll("\\", "/").replace(/^\.\/+/u, "").replace(/\/+$/u, "")
}

function relativeInside(path: string, workDir: string): string | null {
  const absolute = resolve(path)
  const root = resolve(workDir)
  const result = relative(root, absolute)
  if (result === ".." || result.startsWith(`..${sep}`) || isAbsolute(result)) return null
  return slash(result) || "."
}

function relativeCandidate(path: string, workDir: string): string | null {
  return isAbsolute(path) ? relativeInside(path, workDir) : relativeInside(resolve(workDir, path), workDir)
}

function patternMatches(path: string, pattern: string): boolean {
  const normalized = slash(pattern)
  const glob = new Bun.Glob(normalized)
  const ancestors = path.split("/").map((_, index, segments) => segments.slice(0, index + 1).join("/"))
  return glob.match(path) || ancestors.some((ancestor) => glob.match(ancestor)) || path === normalized || path.startsWith(`${normalized}/`)
}

/** Matches a canonical candidate against charter globs inside the charter work directory. */
export function isCharterPathMatch(path: string, patterns: readonly string[], workDir: string): boolean {
  const candidate = relativeCandidate(path, workDir)
  return candidate !== null && patterns.some((pattern) => patternMatches(candidate, pattern))
}

/** Returns the charter pattern that an operation on `path` reaches: a match,
 *  the work directory, or an ancestor of the pattern's static prefix. A search
 *  root that is one can read or traverse the pattern; a write, delete, or move
 *  target that is one can replace it. */
export function charterPathConflict(path: string, patterns: readonly string[], workDir: string): string | null {
  const candidate = relativeCandidate(path, workDir)
  if (candidate === null) return null
  for (const pattern of patterns) {
    const normalized = slash(pattern)
    const staticPrefix = normalized.split(/[*?[{]/u, 1)[0]?.replace(/\/+$/u, "") ?? ""
    if (patternMatches(candidate, pattern) || candidate === "." || (staticPrefix && (staticPrefix === candidate || staticPrefix.startsWith(`${candidate}/`)))) return pattern
  }
  return null
}

/** The charter in the physical form that write targets are placed in: the
 *  work directory and each pattern's fixed leading segments resolved through
 *  links, so a protected directory reached through a symbolic link still
 *  matches. A pattern keeps its glob segments unchanged. */
export function physicalCharter(patterns: readonly string[], workDir: string) {
  const physicalWorkDir = physicalPathWithMissingTail(resolve(workDir))
  return {
    workDir: physicalWorkDir,
    patterns: patterns.map((pattern) => {
      const segments = slash(pattern).split("/")
      const firstGlob = segments.findIndex((segment) => /[*?[{]/u.test(segment))
      const fixed = firstGlob === -1 ? segments : segments.slice(0, firstGlob)
      if (fixed.length === 0) return pattern
      const physical = slash(relative(physicalWorkDir, physicalPathWithMissingTail(resolve(workDir, ...fixed))))
      return [physical, ...segments.slice(fixed.length)].join("/")
    }),
  }
}
