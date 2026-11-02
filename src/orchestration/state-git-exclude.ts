import * as fs from "node:fs"
import * as path from "node:path"

import { FLYWHEEL_DIR_NAME } from "../infra/directory-authorities.js"
import { Log } from "../infra/log.js"
import { readGitMetadata } from "../infra/git-metadata.js"

/** Keeps Flywheel's state directory out of the version control of the project
 *  it records.
 *
 *  The state directory sits inside the project, so a project under git reports
 *  it as untracked and offers to commit it. What it holds is the full text of
 *  every conversation, every model reply, and every tool result, so that offer
 *  is worth removing rather than relying on each user to decline it every time.
 *
 *  The rule goes in `$GIT_DIR/info/exclude`, which is git's own place for
 *  ignores that belong to one checkout rather than to the project. Two other
 *  places were possible and are worse. The project's `.gitignore` is a tracked
 *  file its authors write, and a tool that edits it makes a commit out of
 *  someone else's decision. A `.gitignore` inside the state directory would be
 *  an entry the retirement manifests do not account for, and quarantine refuses
 *  to discard a target holding anything unaccounted, so a courtesy to git would
 *  have wedged generation cleanup.
 *
 *  `info/exclude` is also the honest match in scope: Flywheel's state is local
 *  to one checkout, and so is the rule that hides it. Nothing is added to the
 *  project, and nothing reaches anyone who clones it.
 *
 *  A rule is written only when no rule the checkout already has ignores the
 *  state directory. A project opened inside another project's state directory,
 *  such as a session's scratch directory, is already hidden by the outer rule,
 *  and writing a rule for each one grew the file by one block per scratch
 *  project. */

const log = Log.create({ service: "workspace.git-exclude" })

/** What is written above the rule, so that a reader who finds it knows what put
 *  it there and that removing it costs nothing. */
const EXCLUDE_HEADER = `# Added by Flywheel. Its state directory holds the full text of every session,
# and belongs to this checkout rather than to the project.`

/** One git repository, as far as excluding a path from it needs to know. */
interface GitRepository {
  /** Where `info/exclude` lives. For a linked worktree this is the common
   *  directory, because that is the one git reads the rule from. */
  readonly excludeRoot: string
  /** The directory the rules are written relative to. */
  readonly workTree: string
}

/** Exclude this project's state directory from the git checkout that contains
 *  it, if one does.
 *
 *  Idempotent: the rule is written once, and not at all when a rule the
 *  checkout already has ignores the state directory. The same pass removes the
 *  blocks an earlier Flywheel wrote that another rule now covers. Best effort:
 *  a project outside git, a checkout that refuses the write, or a `.git` this
 *  cannot read all leave the workspace working and unmarked, which is a better
 *  outcome than failing a start over an ignore rule. */
export function excludeStateFromGit(projectRoot: string): void {
  try {
    const repository = findRepository(projectRoot)
    if (!repository) return
    const rule = stateDirectoryRule(repository.workTree, projectRoot)
    if (rule === undefined) return
    reconcileRule(repository, rule)
  } catch (error) {
    log.warn("state directory not excluded from git", { projectRoot, detail: String(error) })
  }
}

/** The repository containing `startDir`, found the way git finds it: by walking
 *  up until a `.git` appears. Stops at the filesystem root. */
function findRepository(startDir: string): GitRepository | undefined {
  let current = path.resolve(startDir)
  for (;;) {
    const dotGit = path.join(current, ".git")
    const resolved = resolveGitDir(dotGit)
    if (resolved !== undefined) return { excludeRoot: resolved, workTree: current }
    const parent = path.dirname(current)
    if (parent === current) return undefined
    current = parent
  }
}

/** The directory holding `info/exclude` for the `.git` at this path, or
 *  undefined when there is no repository there.
 *
 *  `.git` is a directory in an ordinary clone and a file in a linked worktree
 *  or a submodule, where it names the real one. A worktree's own git directory
 *  then carries a `commondir` pointing at the repository all its worktrees
 *  share, and that is where git reads `info/exclude`, so a rule written to the
 *  worktree's own directory would have no effect. */
function resolveGitDir(dotGitPath: string): string | undefined {
  let stats: fs.Stats
  try {
    stats = fs.statSync(dotGitPath)
  } catch {
    return undefined
  }

  if (!stats.isDirectory() && !stats.isFile()) return undefined
  return readGitMetadata(dotGitPath)?.commonDir
}

/** The exclude rule naming this project's state directory, relative to the work
 *  tree and anchored to it.
 *
 *  Anchored with a leading slash so the rule names this one directory rather
 *  than every path component that happens to share its name. Undefined when the
 *  project root sits outside the work tree, which a rule cannot express and
 *  which means the state directory is not in that repository to begin with. */
function stateDirectoryRule(workTree: string, projectRoot: string): string | undefined {
  const within = path.relative(workTree, path.resolve(projectRoot))
  if (within === ".." || within.startsWith(`..${path.sep}`) || path.isAbsolute(within)) return undefined
  const posix = within.split(path.sep).filter(Boolean).join("/")
  return posix.length === 0 ? `/${FLYWHEEL_DIR_NAME}/` : `/${posix}/${FLYWHEEL_DIR_NAME}/`
}

/** One ignore line as this reads it. A literal line names one path: an
 *  anchored one, a pattern that starts with or contains a slash, names it
 *  relative to the file's directory, and any other names every path component
 *  with that name. A wildcard line is a pattern this does not evaluate, so it
 *  never counts as covering: the cost of not reading it is one redundant rule,
 *  never an unignored directory. */
type IgnoreLine =
  | { readonly kind: "literal"; readonly negated: boolean; readonly anchored: boolean; readonly path: string }
  | { readonly kind: "wildcard"; readonly negated: boolean }

function parseIgnoreLine(line: string): IgnoreLine | undefined {
  const text = line.trim()
  if (text.length === 0 || text.startsWith("#")) return undefined
  const negated = text.startsWith("!")
  const body = negated ? text.slice(1) : text
  if (/[*?[\\]/.test(body)) return { kind: "wildcard", negated }
  const trimmed = body.replace(/\/+$/, "")
  const linePath = trimmed.replace(/^\/+/, "")
  return linePath.length === 0 ? undefined : { kind: "literal", negated, anchored: trimmed.includes("/"), path: linePath }
}

/** Whether a literal line names `target`, a path relative to the work tree, or
 *  one of its ancestors. */
function namesPathOrAncestor(line: { readonly anchored: boolean; readonly path: string }, target: string): boolean {
  if (line.anchored) return target === line.path || target.startsWith(`${line.path}/`)
  return target.split("/").includes(line.path)
}

/** Whether a negation can bring `target` back. Git cannot re-include a path
 *  whose parent directory is excluded, so only a negation that names the
 *  target or an ancestor can, and a wildcard negation is assumed to. */
function mayReinclude(line: IgnoreLine, target: string): boolean {
  return line.negated && (line.kind === "wildcard" || namesPathOrAncestor(line, target))
}

function readText(file: string): string {
  try {
    return fs.readFileSync(file, "utf8")
  } catch {
    return ""
  }
}

/** Write the rule unless a rule the checkout already has covers it, and remove
 *  the blocks Flywheel wrote earlier that another rule now covers.
 *
 *  The rules read are `info/exclude` and the work tree's root `.gitignore`,
 *  both relative to the work tree. A path counts as covered only when a
 *  literal line excludes it or an ancestor and no negation can bring it back.
 *  Blocks are pruned in file order against the rules that remain, so of two
 *  identical blocks the second keeps the first's place. A line the user wrote
 *  is never removed. */
function reconcileRule(repository: GitRepository, rule: string): void {
  const infoDir = path.join(repository.excludeRoot, "info")
  const excludeFile = path.join(infoDir, "exclude")
  const existing = readText(excludeFile)
  const lines = existing.split("\n")
  const headerLines = EXCLUDE_HEADER.split("\n")
  const gitignore = readText(path.join(repository.workTree, ".gitignore")).split("\n").flatMap((line) => parseIgnoreLine(line) ?? [])
  const exclude = lines.map(parseIgnoreLine)
  const live = new Set(exclude.flatMap((line, index) => line ? [index] : []))

  const covered = (target: string, except?: number): boolean => {
    const rules = [...gitignore, ...[...live].flatMap((index) => {
      const line = exclude[index]
      return index === except || !line ? [] : [line]
    })]
    if (rules.some((line) => mayReinclude(line, target))) return false
    return rules.some((line) => line.kind === "literal" && !line.negated && namesPathOrAncestor(line, target))
  }

  const dropped = new Set<number>()
  for (const index of live) {
    const line = exclude[index]
    const written = index >= headerLines.length && headerLines.every((header, offset) => lines[index - headerLines.length + offset] === header)
    if (!written || line?.kind !== "literal" || line.negated || !covered(line.path, index)) continue
    live.delete(index)
    for (let offset = headerLines.length; offset >= 0; offset--) dropped.add(index - offset)
  }

  const kept = dropped.size === 0 ? existing : lines.filter((_, index) => !dropped.has(index)).join("\n")
  if (dropped.size > 0) {
    // Written aside and renamed, so git never reads a half-written file.
    const staging = `${excludeFile}.flywheel-${process.pid}`
    fs.writeFileSync(staging, kept)
    fs.renameSync(staging, excludeFile)
    log.debug("covered state directory rules removed from git exclude", { excludeFile, removed: dropped.size / (headerLines.length + 1) })
  }
  if (!covered(rule.replace(/^\/+|\/+$/g, ""))) appendRule(infoDir, excludeFile, kept, rule)
}

function appendRule(infoDir: string, excludeFile: string, existing: string, rule: string): void {
  fs.mkdirSync(infoDir, { recursive: true })
  const separator = existing.length === 0 || existing.endsWith("\n") ? "" : "\n"
  fs.appendFileSync(excludeFile, `${separator}${EXCLUDE_HEADER}\n${rule}\n`)
  log.debug("state directory excluded from git", { excludeFile, rule })
}
