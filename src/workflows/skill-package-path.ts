import { posix } from "node:path";
import { SKILL_FILE } from "./skill-schema.js";

const SUPPORT_DIRS = ["references", "templates", "scripts", "assets"] as const;

/** Why this path is not one a package may hold, or undefined when it is safe. */
export function packagePathRefusal(path: string): string | undefined {
  if (path === SKILL_FILE) return undefined;
  // A package path is a POSIX specifier, not a host path: the native
  // normalizer rewrites "a/b" to "a\b" on Windows and would refuse every
  // valid support path there.
  const normalized = posix.normalize(path);
  if (normalized !== path || path.startsWith("/") || path.includes("..") || path.includes("\\")) {
    return `Support path must be a plain package-relative POSIX path: ${JSON.stringify(path)}.`;
  }
  const supportDirs: readonly string[] = SUPPORT_DIRS;
  const [head, ...rest] = path.split("/");
  if (head === undefined || !supportDirs.includes(head) || rest.length === 0 || rest.some((part) => part.length === 0)) {
    return `Support files live under ${SUPPORT_DIRS.map((dir) => `${dir}/`).join(", ")}: ${JSON.stringify(path)}.`;
  }
  return undefined;
}
