import * as path from "node:path"

/** A directory with the account home replaced by `~`: the home itself, a
 *  path under it, or the path unchanged when it lies elsewhere. Windows
 *  paths compare case-insensitively and keep their separators. */
export function collapseHome(directory: string, home: string): string {
  const pathApi = pathFlavor(directory, home)
  const normalizedCwd = pathApi.normalize(directory)
  const normalizedHome = pathApi.normalize(home)
  if (samePath(normalizedCwd, normalizedHome, pathApi)) return "~"
  const relative = pathApi.relative(normalizedHome, normalizedCwd)
  return relative && !relative.startsWith("..") && !pathApi.isAbsolute(relative)
    ? `~${pathApi.sep}${relative}`
    : directory
}

function pathFlavor(...values: string[]): typeof path.posix | typeof path.win32 {
  return values.some((value) => /^[A-Za-z]:[\\/]/.test(value) || value.includes("\\")) ? path.win32 : path.posix
}

function samePath(left: string, right: string, pathApi: typeof path.posix | typeof path.win32): boolean {
  return pathApi === path.win32 ? left.toLowerCase() === right.toLowerCase() : left === right
}
