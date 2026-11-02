import { lstatSync, readlinkSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, parse, resolve, sep, win32 } from "node:path";

function isMissingPathError(error: unknown): boolean {
  const code = error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : undefined;
  return code === "ENOENT" || code === "ENOTDIR";
}

/** Resolve a path's physical identity, including a destination that does not exist yet.
 *
 * The longest existing ancestor is resolved through links, then the missing path tail is
 * appended unchanged. Other filesystem failures remain errors for the caller to handle.
 */
export function canonicalPathWithMissingTail(filePath: string): string {
  const missingTail: string[] = [];
  let existing = resolve(filePath);

  while (true) {
    try {
      return resolve(realpathSync.native(existing), ...missingTail);
    } catch (error) {
      if (!isMissingPathError(error)) throw error;
      const parent = dirname(existing);
      if (parent === existing) throw error;
      missingTail.unshift(basename(existing));
      existing = parent;
    }
  }
}

/** Normalize a spelling as Win32 does before it opens a file: unify the
 * separators, remove `.` and `..` lexically, then remove one trailing period
 * from each inner segment and every trailing period and space from the final
 * segment. A trailing separator makes the final segment inner and is kept.
 * Throws when a trim leaves a name that no file can have. */
function win32Normalized(filePath: string): string {
  const trailingSeparator = /[\\/]$/.test(filePath);
  const resolved = win32.resolve(filePath);
  const { root } = win32.parse(resolved);
  const segments = resolved.slice(root.length).split(win32.sep).filter(Boolean);
  const trimmed = segments.map((segment, index) => index === segments.length - 1 && !trailingSeparator
    ? segment.replace(/[. ]+$/, "")
    : segment.replace(/(?<!\.)\.$/, ""));
  if (trimmed.some(segment => segment === "" || segment === "." || segment === "..")) throw new Error("unplaceable Windows path spelling");
  return `${root}${trimmed.join(win32.sep)}${trailingSeparator && trimmed.length > 0 ? win32.sep : ""}`;
}

/** Resolve segments in kernel order. POSIX follows a link before it applies a
 * later `..`. Windows normalizes the spelling with `win32Normalized` before it
 * follows any link, and it joins a relative link target to the link's
 * directory and removes that target's `.` and `..` lexically, without trims.
 * Missing tail segments are retained. A delete preserves its final link unless
 * the spelling ends in a separator. Filesystem errors other than missing paths,
 * and spellings that cannot be placed, remain errors, so a policy caller can
 * report an unplaceable target. A caller can share link observations while
 * analyzing one filesystem snapshot. */
export function physicalPathWithMissingTail(filePath: string, deleteEntry = false, linkCache?: Map<string, string | null>): string {
  const absolute = process.platform === "win32"
    ? win32Normalized(filePath)
    : isAbsolute(filePath) ? filePath : `${process.cwd()}${sep}${filePath}`;
  const root = parse(absolute).root;
  const segments = absolute.slice(root.length).split(sep);
  let current = root;
  let links = 0;
  while (segments.length > 0) {
    const segment = segments.shift() ?? "";
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      current = dirname(current);
      continue;
    }
    const next = join(current, segment);
    if (deleteEntry && segments.length === 0) return join(canonicalPathWithMissingTail(current), segment);
    try {
      let target = linkCache?.get(next);
      if (target === undefined) {
        target = lstatSync(next).isSymbolicLink() ? readlinkSync(next) : null;
        linkCache?.set(next, target);
      }
      if (target !== null) {
        if (++links > 40) throw new Error("too many symbolic links");
        if (process.platform === "win32") target = win32.resolve(current, target);
        if (isAbsolute(target)) current = parse(target).root;
        segments.unshift(...target.slice(isAbsolute(target) ? parse(target).root.length : 0).split(sep));
        continue;
      }
      current = next;
    } catch (error) {
      if (!isMissingPathError(error)) throw error;
      linkCache?.set(next, null);
      current = next;
    }
  }
  return canonicalPathWithMissingTail(current);
}
