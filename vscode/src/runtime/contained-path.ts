import { isAbsolute, join, normalize, relative, resolve } from "node:path"

/** Resolves a path the extension was handed against the directory it is
 *  supposed to be inside, and refuses anything that lands outside.
 *
 *  Paths reach the host from two places that both count as external. The
 *  transcript is model output and tool results, and the webview is a separate
 *  document that posts messages in. Flywheel's own rule applies to both: be
 *  liberal at an external boundary and strict inside it, which means the path
 *  is normalized and checked here rather than trusted because of where it came
 *  from.
 *
 *  Two failures are worth naming, because a plain join has both. A relative
 *  path containing `..` escapes the base entirely, and an absolute path is
 *  silently reinterpreted as relative, so the editor opens a real file that is
 *  not the one the transcript named. Silently opening the wrong file is worse
 *  than refusing, so neither is allowed through.
 *
 *  boundary: the containment authority (ARCH-DIRECTORIES-012) is `ContainedDirectory` in
 *  `src/infra/descriptor-directory.ts`, which holds directories open through
 *  `bun:ffi`. A Node extension host cannot load that, and infra is not part of
 *  the protocol surface this extension may import, so the pure path-resolution
 *  rule is restated here rather than reused. */
export function resolveContainedPath(base: string, candidate: string): string | undefined {
  if (candidate.length === 0) return undefined
  // A NUL byte truncates the path at the syscall boundary, so a name carrying
  // one does not mean here what it will mean there.
  if (candidate.includes("\0")) return undefined

  const root = resolve(base)
  const target = isAbsolute(candidate) ? normalize(candidate) : resolve(root, candidate)

  if (target === root) return target
  const inside = relative(root, target)
  // `relative` answers with a `..` prefix exactly when the target is outside,
  // and with an absolute path when the two share no root at all.
  if (inside.startsWith("..") || isAbsolute(inside)) return undefined
  return join(root, inside)
}

/** True when `candidate` names something inside `base`. */
export function isContainedPath(base: string, candidate: string): boolean {
  return resolveContainedPath(base, candidate) !== undefined
}

