import fuzzysort from "fuzzysort"
import { relative, sep } from "node:path"

import type { ListFilesResult } from "../agent-runtime/tools/ripgrep.js"
import type { ProjectFileEntry, ProjectFilesRequest, ProjectFilesResult } from "../../protocol/transcript-protocol-types.js"

/** The project's files and directories, for a person picking one to
 *  mention. The listing is the same walk the agent's list tool makes,
 *  respecting the project's ignore rules, with every directory on a file's
 *  path offered too so a mention can name a folder or step into one. It is
 *  held for a few seconds between searches: a picker asks on every
 *  keystroke, and the tree does not change between them. */

const LISTING_TTL_MS = 5_000
/** Enough for a large repository; past it the picker still searches what it
 *  has, which is the alphabetical head of the tree. */
const LISTING_LIMIT = 20_000
/** The native walk answers at most this many entries per call and descends
 *  at most this deep, so a project is read in pages. */
const WALK_PAGE = 1_000
const WALK_DEPTH = 12
const WALK_TIMEOUT_MS = 5_000
/** Flywheel's own state and the repository's object store are never
 *  something to mention. */
const NEVER_MENTIONED = [".flywheel", ".git"]
/** The repository's object store can hold more entries than the listing
 *  limit, so the walk never enters it. */
const NOT_ENTERED = ["**/.git"]

export interface ProjectFilesService {
  search(request: ProjectFilesRequest): Promise<ProjectFilesResult>
}

interface ProjectFilesDeps {
  readonly projectRoot: string
  readonly listFiles: (options: { path: string; include: "files"; depth: number; hidden: boolean; gitignore: boolean; excludeGlobs: readonly string[]; limit: number; offset: number; timeoutMs: number }) => Promise<ListFilesResult>
  readonly now?: () => number
}

export function createProjectFiles(deps: ProjectFilesDeps): ProjectFilesService {
  const now = deps.now ?? (() => Date.now())
  let listing: { readonly at: number; readonly entries: readonly Searchable[] } | undefined
  let pending: Promise<readonly Searchable[]> | undefined

  async function entries(): Promise<readonly Searchable[]> {
    if (listing !== undefined && now() - listing.at < LISTING_TTL_MS) return listing.entries
    // One walk at a time: the keystrokes that land during it share its answer.
    pending ??= walk()
      .then((walked) => {
        const files = walked
          .map((entry) => relative(deps.projectRoot, entry).split(sep).join("/"))
          .filter((path) => path.length > 0 && !NEVER_MENTIONED.some((root) => path === root || path.startsWith(`${root}/`)))
        const found = withDirectories(files)
        listing = { at: now(), entries: found }
        return found
      })
      .finally(() => { pending = undefined })
    return pending
  }

  async function walk(): Promise<string[]> {
    const walked: string[] = []
    let offset = 0
    while (walked.length < LISTING_LIMIT) {
      const page = await deps.listFiles({ path: deps.projectRoot, include: "files", depth: WALK_DEPTH, hidden: true, gitignore: true, excludeGlobs: NOT_ENTERED, limit: WALK_PAGE, offset, timeoutMs: WALK_TIMEOUT_MS })
      walked.push(...page.entries)
      if (!page.truncated || page.entries.length === 0) break
      offset = page.nextOffset
    }
    return walked
  }

  return {
    async search(request) {
      const limit = Math.max(1, Math.min(200, Math.floor(request.limit)))
      const all = await entries()
      const query = request.query.trim()
      if (query.length === 0) {
        // A bare `@` is a person looking around: the top level, folders first.
        const top = all.filter((entry) => !entry.path.includes("/"))
        return { entries: top.slice(0, limit).map(publicEntry), total: top.length }
      }
      const ranked = fuzzysort.go(query, all, {
        keys: ["name", "path"],
        // The file's own name is what a person types first; the path is
        // where it lives.
        scoreFn: (result) => Math.max((result[0]?.score ?? 0) * 2, result[1]?.score ?? 0),
        limit,
        threshold: 0,
      })
      return { entries: ranked.map((result) => publicEntry(result.obj)), total: ranked.total }
    },
  }
}

interface Searchable extends ProjectFileEntry {
  readonly name: string
}

const publicEntry = ({ path, directory }: Searchable): ProjectFileEntry => ({ path, directory })

/** The files plus every directory on their paths, each once, directories
 *  before files at equal depth and alphabetical within: the order a bare
 *  query lists and a tie in ranking falls back to. */
function withDirectories(files: readonly string[]): Searchable[] {
  const directories = new Set<string>()
  for (const file of files) {
    const parts = file.split("/")
    for (let depth = 1; depth < parts.length; depth += 1) directories.add(parts.slice(0, depth).join("/"))
  }
  const entry = (path: string, directory: boolean): Searchable => ({ path, directory, name: path.slice(path.lastIndexOf("/") + 1) })
  return [
    ...[...directories].sort().map((path) => entry(path, true)),
    ...[...files].sort().map((path) => entry(path, false)),
  ]
}
