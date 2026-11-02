import { describe, expect, it, afterAll } from "bun:test"
import * as crypto from "node:crypto"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

import { excludeStateFromGit } from "../../../src/orchestration/state-git-exclude.js"

/** The state directory holds every word of every session, and it sits inside
 *  the project it records. These prove it is kept out of that project's version
 *  control without anything the project's authors own being edited. */

const tmpRoot = path.join(os.tmpdir(), `flywheel-git-exclude-${process.pid}-${Date.now()}`)

afterAll(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true })
})

function makeDir(): string {
  const dir = path.join(tmpRoot, crypto.randomUUID())
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

/** A checkout whose `.git` is an ordinary directory. */
function makeRepository(): string {
  const root = makeDir()
  fs.mkdirSync(path.join(root, ".git"), { recursive: true })
  return root
}

function excludeText(gitDir: string): string {
  const file = path.join(gitDir, "info", "exclude")
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : ""
}

describe("excludeStateFromGit", () => {
  it("writes the rule once, however many starts prepare the workspace", () => {
    const root = makeRepository()
    excludeStateFromGit(root)
    excludeStateFromGit(root)
    excludeStateFromGit(root)
    const rules = excludeText(path.join(root, ".git")).split("\n").filter((line) => line.trim() === "/.flywheel/")
    expect(rules).toHaveLength(1)
  })

  it("keeps the rules a checkout already had, and does not run them together", () => {
    const root = makeRepository()
    fs.mkdirSync(path.join(root, ".git", "info"), { recursive: true })
    // No trailing newline: the case where appending blindly would produce
    // "scratch//.flywheel/" and silently exclude neither.
    fs.writeFileSync(path.join(root, ".git", "info", "exclude"), "scratch/")

    excludeStateFromGit(root)

    const lines = excludeText(path.join(root, ".git")).split("\n")
    expect(lines).toContain("scratch/")
    expect(lines).toContain("/.flywheel/")
  })

  it("names the project's own path when it is a subdirectory of the checkout", () => {
    const root = makeRepository()
    const nested = path.join(root, "services", "api")
    fs.mkdirSync(nested, { recursive: true })

    excludeStateFromGit(nested)

    expect(excludeText(path.join(root, ".git")).split("\n")).toContain("/services/api/.flywheel/")
  })

  it("writes where git reads it for a linked worktree, which is the common directory", () => {
    const main = makeRepository()
    const commonGitDir = path.join(main, ".git")
    const worktreeGitDir = path.join(commonGitDir, "worktrees", "feature")
    fs.mkdirSync(worktreeGitDir, { recursive: true })
    fs.writeFileSync(path.join(worktreeGitDir, "commondir"), "../..\n")

    const worktree = makeDir()
    fs.writeFileSync(path.join(worktree, ".git"), `gitdir: ${worktreeGitDir}\n`)

    excludeStateFromGit(worktree)

    expect(excludeText(commonGitDir).split("\n")).toContain("/.flywheel/")
    expect(excludeText(worktreeGitDir)).toBe("")
  })

  it("adds nothing when a rule the checkout already has ignores the state directory", () => {
    const root = makeRepository()
    excludeStateFromGit(root)
    // A project opened inside a session's scratch directory, under the root
    // state directory that `/.flywheel/` already hides.
    const scratchProject = path.join(root, ".flywheel", "sessions", "abc", "scratch", "p")
    fs.mkdirSync(scratchProject, { recursive: true })
    const before = excludeText(path.join(root, ".git"))

    excludeStateFromGit(scratchProject)

    expect(excludeText(path.join(root, ".git"))).toBe(before)
  })

  it("adds nothing when the checkout's own .gitignore already ignores the state directory", () => {
    const root = makeRepository()
    fs.writeFileSync(path.join(root, ".gitignore"), "node_modules/\n.flywheel/\ntests/e2e/results/\n")
    const results = path.join(root, "tests", "e2e", "results", "run-1")
    fs.mkdirSync(results, { recursive: true })

    excludeStateFromGit(root)
    excludeStateFromGit(path.join(root, "services", "api"))
    excludeStateFromGit(results)

    expect(excludeText(path.join(root, ".git"))).toBe("")
  })

  it("still writes its rule when a negation could bring the state directory back", () => {
    const root = makeRepository()
    fs.writeFileSync(path.join(root, ".gitignore"), ".flywheel/\n!/.flywheel/\n")
    const wildcard = makeRepository()
    fs.writeFileSync(path.join(wildcard, ".gitignore"), ".flywheel/\n!*.fly*\n")

    excludeStateFromGit(root)
    excludeStateFromGit(wildcard)

    expect(excludeText(path.join(root, ".git")).split("\n")).toContain("/.flywheel/")
    expect(excludeText(path.join(wildcard, ".git")).split("\n")).toContain("/.flywheel/")
  })

  it("ignores a negation that names neither the state directory nor an ancestor", () => {
    const root = makeRepository()
    fs.writeFileSync(path.join(root, ".gitignore"), "Cargo.lock\n!crates/tokenizer/Cargo.lock\n.flywheel/\n")

    excludeStateFromGit(root)

    expect(excludeText(path.join(root, ".git"))).toBe("")
  })

  it("removes only its own earlier rules that another rule now covers", () => {
    const root = makeRepository()
    fs.mkdirSync(path.join(root, ".git", "info"), { recursive: true })
    const header = "# Added by Flywheel. Its state directory holds the full text of every session,\n# and belongs to this checkout rather than to the project."
    fs.writeFileSync(path.join(root, ".git", "info", "exclude"), [
      "/.flywheel/sessions/own/.flywheel/",
      header,
      "/.flywheel/",
      header,
      "/.flywheel/",
      header,
      "/.flywheel/sessions/abc/scratch/p/.flywheel/",
      header,
      "/services/api/.flywheel/",
      "",
    ].join("\n"))

    excludeStateFromGit(root)

    const lines = excludeText(path.join(root, ".git")).split("\n")
    // A line the user wrote stays, even though it is covered.
    expect(lines).toContain("/.flywheel/sessions/own/.flywheel/")
    // One copy of a duplicated rule stays, because each copy covered the other.
    expect(lines.filter((line) => line === "/.flywheel/")).toHaveLength(1)
    expect(lines).not.toContain("/.flywheel/sessions/abc/scratch/p/.flywheel/")
    expect(lines).toContain("/services/api/.flywheel/")
    expect(lines.filter((line) => line.startsWith("# Added by Flywheel"))).toHaveLength(2)
  })

  it("does nothing at all outside a checkout", () => {
    const plain = makeDir()
    excludeStateFromGit(plain)
    expect(fs.readdirSync(plain)).toEqual([])
  })

  it("reports rather than throws when the checkout will not take the rule", () => {
    const root = makeRepository()
    // A regular file where `info/` has to be: the write cannot succeed, and a
    // workspace is not worth failing to prepare over an ignore rule.
    fs.writeFileSync(path.join(root, ".git", "info"), "not a directory")
    expect(() => excludeStateFromGit(root)).not.toThrow()
  })
})
