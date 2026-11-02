import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { accountProjectDirectories, selectInteractiveStartupDirectories, selectStartupDirectories } from "../../../src/infra/directory-authorities.js"
import { errorMessage } from "../../../src/infra/error-message.js"

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "flywheel-directory-authorities-"))
  roots.push(root)
  return root
}

describe("canonical repository identity", () => {
  test("derives the repository root once from a nested execution directory", () => {
    const root = temporaryRoot()
    mkdirSync(join(root, ".git"))
    const nested = join(root, "packages", "app")
    mkdirSync(nested, { recursive: true })

    const selected = selectStartupDirectories({ cwd: nested, home: root, env: {} })

    expect(selected.canonicalRepositoryRoot).toBe(realpathSync(root))
  })

  test("accepts a .git file used by linked worktrees and submodules", () => {
    const root = temporaryRoot()
    writeFileSync(join(root, ".git"), "gitdir: ../common/worktrees/example\n")
    const nested = join(root, "src")
    mkdirSync(nested)

    expect(selectStartupDirectories({ cwd: nested, home: root, env: {} }).canonicalRepositoryRoot).toBe(realpathSync(root))
  })

  test("publishes no repository identity outside Git", () => {
    const root = temporaryRoot()
    expect(selectStartupDirectories({ cwd: root, home: root, env: {} }).canonicalRepositoryRoot).toBeUndefined()
  })

  test("canonicalizes a symlinked repository before publication", () => {
    const parent = temporaryRoot()
    const root = join(parent, "repo")
    mkdirSync(join(root, ".git"), { recursive: true })
    const alias = join(parent, "alias")
    symlinkSync(root, alias, "dir")

    expect(selectStartupDirectories({ cwd: alias, home: parent, env: {} }).canonicalRepositoryRoot).toBe(realpathSync(root))
  })
})

describe("an account service project open", () => {
  test("gives a project inside a repository that repository's identity", () => {
    const root = temporaryRoot()
    mkdirSync(join(root, ".git"))
    const project = join(root, "packages", "app")
    mkdirSync(project, { recursive: true })

    const opened = accountProjectDirectories({ userDataRoot: join(root, "home", ".flywheel"), accountHome: join(root, "home") }, project)

    expect(opened.executionCwd).toBe(project)
    expect(opened.canonicalRepositoryRoot).toBe(realpathSync(root))
  })

  test("gives a project outside Git no repository identity", () => {
    const root = temporaryRoot()
    expect(accountProjectDirectories({ userDataRoot: join(root, ".flywheel"), accountHome: root }, root).canonicalRepositoryRoot).toBeUndefined()
  })
})

describe("an unusable exact selection", () => {
  test("names a missing directory once, without the system error behind it", () => {
    const root = temporaryRoot()
    const missing = join(root, "no-such")
    let refusal: unknown
    try { selectStartupDirectories({ cwd: root, home: root, env: {}, projectRootOption: missing }) } catch (error) { refusal = error }
    expect(errorMessage(refusal)).toBe(`project directory does not exist: ${missing}`)
  })

  test("names a file that is not a directory", () => {
    const root = temporaryRoot()
    const file = join(root, "file")
    writeFileSync(file, "")
    expect(() => selectStartupDirectories({ cwd: root, home: root, env: {}, projectRootOption: file })).toThrow(`project directory is not a directory: ${file}`)
  })
})

// The account home's .flywheel is the account data root (ARCH-DIRECTORIES-002), so a
// project there mixes its state and logs into the account's.
describe("the account home is never an implicit project", () => {
  function accountHome(): string {
    const home = temporaryRoot()
    mkdirSync(join(home, ".flywheel"))
    mkdirSync(join(home, ".git"))
    mkdirSync(join(home, "notes"))
    return realpathSync(home)
  }

  test("a launch under a home that is a repository selects the starting directory, without a choice", async () => {
    const home = accountHome()
    const cwd = join(home, "notes")
    expect(selectStartupDirectories({ cwd, home, env: {}, opensProject: true }).projectRoot).toBe(cwd)
    const selected = await selectInteractiveStartupDirectories({ cwd, home, env: {}, opensProject: true }, () => { throw new Error("no choice is asked") })
    expect(selected.projectRoot).toBe(cwd)
  })

  test("a run that opens a project at the account home refuses and says that any other folder starts one", async () => {
    const home = accountHome()
    const refusal = `Flywheel can't use your home folder (${home}) as a project, because its .flywheel folder holds your global settings. To start a new project, run flywheel in any other folder.`
    expect(() => selectStartupDirectories({ cwd: home, home, env: {}, opensProject: true })).toThrow(refusal)
    await expect(selectInteractiveStartupDirectories({ cwd: home, home, env: {}, opensProject: true }, async () => "git-root")).rejects.toThrow(refusal)
  })

  test("an exact selection, and a command that opens no project, keep the account home", () => {
    const home = accountHome()
    expect(selectStartupDirectories({ cwd: home, home, env: {}, opensProject: true, projectRootOption: home }).projectRoot).toBe(home)
    expect(selectStartupDirectories({ cwd: home, home, env: { FLYWHEEL_PROJECT_ROOT: home }, opensProject: true }).projectRoot).toBe(home)
    expect(selectStartupDirectories({ cwd: home, home, env: {} }).projectRoot).toBe(home)
  })
})
