import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync, renameSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createGitProjection } from "../../../../src/orchestration/app-service/git-projection.js"
import { temporaryDirectories } from "../../../helpers/directories.js"

const roots: string[] = []
const directory = temporaryDirectories()

function repository(head: string): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "fw-git-projection-")))
  roots.push(root)
  mkdirSync(join(root, ".git"))
  writeFileSync(join(root, ".git", "HEAD"), head)
  return root
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe("git projection", () => {
  test("reads the branch HEAD names without publishing a change", () => {
    const patches: unknown[] = []
    const projectRoot = repository("ref: refs/heads/feature/intro\n")
    const projection = createGitProjection({ projectRoot, publish: (patch) => patches.push(patch) })
    expect(projection.view()).toEqual({ directories: { [projectRoot]: { branch: "feature/intro" } } })
    expect(patches).toEqual([])
    projection.dispose()
  })

  test("has no branch on a detached HEAD or outside a repository", () => {
    const projectRoot = repository("0123456789abcdef0123456789abcdef01234567\n")
    const detached = createGitProjection({ projectRoot, publish: () => {} })
    expect(detached.view()).toEqual({ directories: { [projectRoot]: {} } })
    detached.dispose()

    const plain = mkdtempSync(join(tmpdir(), "fw-git-projection-plain-"))
    roots.push(plain)
    const outside = createGitProjection({ projectRoot: plain, publish: () => {} })
    expect(outside.view()).toEqual({ directories: { [plain]: {} } })
    outside.dispose()
  })

  test("holds runner-null child details, shares their worktree watcher, and releases after the last held session", async () => {
    const projectRoot = repository("ref: refs/heads/main\n")
    const executionCwd = realpathSync(directory("fw-child-worktree-"))
    const gitDirectory = join(projectRoot, ".git", "worktrees", "child")
    mkdirSync(gitDirectory, { recursive: true })
    writeFileSync(join(executionCwd, ".git"), `gitdir: ${gitDirectory}\n`)
    writeFileSync(join(gitDirectory, "commondir"), "../..\n")
    writeFileSync(join(gitDirectory, "HEAD"), "ref: refs/heads/child\n")
    const patches: unknown[] = []
    const projection = createGitProjection({ projectRoot, publish: (patch) => patches.push(patch) })
    try {
      projection.holdSession("child-a", executionCwd)
      projection.holdSession("child-b", executionCwd)
      expect(projection.view().directories[executionCwd]).toEqual({ branch: "child", worktreeRoot: executionCwd })
      expect(patches).toHaveLength(1)
      projection.holdSession("child-a", executionCwd)
      expect(patches).toHaveLength(1)
      projection.releaseSession("child-a")
      expect(projection.view().directories[executionCwd]?.branch).toBe("child")
      writeFileSync(join(gitDirectory, "HEAD.lock"), "ref: refs/heads/switched\n")
      renameSync(join(gitDirectory, "HEAD.lock"), join(gitDirectory, "HEAD"))
      for (let attempt = 0; attempt < 400 && projection.view().directories[executionCwd]?.branch !== "switched"; attempt++) await Bun.sleep(5)
      expect(projection.view().directories[executionCwd]?.branch).toBe("switched")
      expect(patches).toHaveLength(2)
      projection.releaseSession("child-b")
      expect(projection.view().directories[executionCwd]).toBeUndefined()
      expect(projection.view().directories[projectRoot]).toEqual({ branch: "main" })
      const count = patches.length
      writeFileSync(join(gitDirectory, "HEAD"), "ref: refs/heads/released\n")
      for (let attempt = 0; attempt < 25; attempt++) await Bun.sleep(5)
      expect(patches).toHaveLength(count)
    } finally { projection.dispose() }
  })

  test("a later detail read transfers the session's directory hold", () => {
    const projectRoot = repository("ref: refs/heads/main\n")
    const previous = repository("ref: refs/heads/previous\n")
    const projection = createGitProjection({ projectRoot, publish: () => {} })
    try {
      projection.holdSession("child", previous)
      projection.holdSession("child", projectRoot)
      expect(projection.view().directories).toEqual({ [projectRoot]: { branch: "main" } })
      projection.releaseSession("child")
      expect(projection.view().directories).toEqual({ [projectRoot]: { branch: "main" } })
    } finally { projection.dispose() }
  })
})
