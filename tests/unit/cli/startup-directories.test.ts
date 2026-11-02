import { describe, expect, test } from "bun:test"
import { mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import path, { join, relative, resolve } from "node:path"

import {
  nearestProjectRoot,
  resolveExecutionDirectoryInput,
  selectInteractiveStartupDirectories,
  selectStartupDirectories,
  type StartupDirectoryFallbackCandidate,
} from "../../../src/infra/directory-authorities.js"
import { rootCliAction } from "../../../src/cli/root-args.js"
import { temporaryDirectories } from "../../helpers/directories.js"

const temporaryDirectory = temporaryDirectories()

function tempDir(): string {
  return realpathSync(temporaryDirectory("flywheel-startup-dirs-"))
}

function repository(): string {
  const root = tempDir()
  mkdirSync(join(root, ".git"))
  return root
}

// A selected account home is canonicalized, so a fixture states one that is
// already canonical for the running platform: a POSIX literal resolves onto the
// current drive on Windows and would never equal itself.
const REDIRECTED_HOME = resolve("/home/redirected")
const SOME_HOME = resolve("/home/someone")

describe("nearestProjectRoot", () => {
  test("a repository root is the project root of every directory under it", () => {
    const root = repository()
    const nested = join(root, "packages", "cli", "src")
    mkdirSync(nested, { recursive: true })

    expect(nearestProjectRoot(nested)).toBe(root)
    expect(nearestProjectRoot(root)).toBe(root)
  })

  test("a `.git` file marks the root, so a worktree or submodule resolves like a repository", () => {
    const root = tempDir()
    writeFileSync(join(root, ".git"), "gitdir: /elsewhere/.git/worktrees/one\n")
    const nested = join(root, "src")
    mkdirSync(nested)

    expect(nearestProjectRoot(nested)).toBe(root)
  })

  test("the nearest repository wins over an outer one", () => {
    const outer = repository()
    const inner = join(outer, "vendor", "inner")
    mkdirSync(inner, { recursive: true })
    mkdirSync(join(inner, ".git"))

    expect(nearestProjectRoot(join(inner, "src"))).toBe(inner)
  })

  test("a directory with no repository above it is its own project root", () => {
    const nested = join(tempDir(), "a", "b")
    mkdirSync(nested, { recursive: true })

    expect(nearestProjectRoot(nested)).toBe(nested)
  })

  test("a relative starting directory resolves to an absolute root", () => {
    const relativeCwd = relative(process.cwd(), tempDir())

    expect(nearestProjectRoot(relativeCwd)).toBe(resolve(relativeCwd))
  })
})

describe("execution directory overrides", () => {
  test("resolves ordinary and fully qualified Windows paths without ambient drive state", () => {
    expect(resolveExecutionDirectoryInput("D:\\parent", "child", path, "win32")).toBe("D:\\parent\\child")
    expect(resolveExecutionDirectoryInput("D:\\parent", "C:\\repo", path, "win32")).toBe("C:\\repo")
    expect(resolveExecutionDirectoryInput("D:\\parent", "\\\\server\\share\\repo", path, "win32"))
      .toBe("\\\\server\\share\\repo")
  })

  test("rejects Windows paths whose meaning depends on ambient drive state", () => {
    expect(() => resolveExecutionDirectoryInput("D:\\parent", "C:repo", path, "win32")).toThrow("drive-relative")
    expect(() => resolveExecutionDirectoryInput("D:\\parent", "C:", path, "win32")).toThrow("drive-relative")
    expect(() => resolveExecutionDirectoryInput("D:\\parent", "\\repo", path, "win32")).toThrow("must include a drive")
    expect(() => resolveExecutionDirectoryInput("D:\\parent", "/repo", path, "win32")).toThrow("must include a drive")
  })
})

describe("the account home selection", () => {
  test("a redirected HOME is the account home every account-global path hangs off, and the data root under it", () => {
    const directories = selectStartupDirectories({ env: { HOME: REDIRECTED_HOME }, cwd: process.cwd() })

    expect(directories.accountHome).toBe(REDIRECTED_HOME)
    expect(directories.userDataRoot).toBe(join(REDIRECTED_HOME, ".flywheel"))
  })
})

describe("selectStartupDirectories", () => {
  test("without an explicit selection the nearest repository above the starting directory owns project state", () => {
    const root = repository()
    const nested = join(root, "packages", "cli")
    mkdirSync(nested, { recursive: true })

    expect(selectStartupDirectories({ env: {}, cwd: nested, home: SOME_HOME })).toEqual({
      userDataRoot: join(SOME_HOME, ".flywheel"),
      accountHome: SOME_HOME,
      projectRoot: root,
      executionCwd: nested,
      canonicalRepositoryRoot: root,
    })
  })

  test("with no repository above it the starting directory owns project state", () => {
    const start = tempDir()

    expect(selectStartupDirectories({ env: {}, cwd: start, home: SOME_HOME }).projectRoot).toBe(start)
  })

  test("the option wins over the environment value", () => {
    const root = repository()
    const chosen = join(root, "chosen")
    const ignored = join(root, "ignored")
    mkdirSync(chosen)
    mkdirSync(ignored)

    const directories = selectStartupDirectories({
      projectRootOption: chosen,
      env: { FLYWHEEL_PROJECT_ROOT: ignored },
      cwd: root,
    })

    expect(directories.projectRoot).toBe(chosen)
  })

  test("the environment value wins over repository discovery", () => {
    const root = repository()
    const selected = join(root, "selected")
    mkdirSync(selected)

    expect(selectStartupDirectories({ env: { FLYWHEEL_PROJECT_ROOT: selected }, cwd: root }).projectRoot).toBe(selected)
  })

  test("an empty environment value selects nothing", () => {
    const root = repository()
    const nested = join(root, "packages")
    mkdirSync(nested)

    expect(selectStartupDirectories({ env: { FLYWHEEL_PROJECT_ROOT: "" }, cwd: nested }).projectRoot).toBe(root)
  })

  test("an explicit project root is exact, so a directory inside a repository keeps its own state", () => {
    const outer = repository()
    const sandbox = join(outer, ".flywheel", "sessions", "test", "scratch", "uat")
    mkdirSync(sandbox, { recursive: true })

    expect(selectStartupDirectories({ projectRootOption: sandbox, env: {}, cwd: sandbox }).projectRoot).toBe(sandbox)
  })

  test("an explicit project root never replaces the execution directory", () => {
    const outer = repository()
    const sandbox = join(outer, "sandbox")
    mkdirSync(sandbox)

    expect(selectStartupDirectories({ projectRootOption: sandbox, env: {}, cwd: outer, home: SOME_HOME })).toEqual({
      userDataRoot: join(SOME_HOME, ".flywheel"),
      accountHome: SOME_HOME,
      projectRoot: sandbox,
      executionCwd: outer,
      canonicalRepositoryRoot: outer,
    })
  })

  test("both selections are canonicalized through symlinks", () => {
    const root = tempDir()
    const real = join(root, "real")
    const link = join(root, "link")
    mkdirSync(real)
    symlinkSync(real, link)

    expect(selectStartupDirectories({ projectRootOption: link, env: {}, cwd: link })).toMatchObject({
      projectRoot: real,
      executionCwd: real,
    })
  })

  test("a project root whose name holds spaces and shell metacharacters is an ordinary path", () => {
    const root = tempDir()
    const project = join(root, "Projects (2026)", "my app & tools")
    mkdirSync(project, { recursive: true })

    expect(selectStartupDirectories({ projectRootOption: project, env: {}, cwd: root }).projectRoot).toBe(project)
  })

  test("a project root that does not exist is rejected", () => {
    const missing = join(tempDir(), "absent")

    expect(() => selectStartupDirectories({ projectRootOption: missing, env: {}, cwd: process.cwd() }))
      .toThrow(/project directory does not exist/)
  })

  test("a project root that is not a directory is rejected", () => {
    const file = join(tempDir(), "file.txt")
    writeFileSync(file, "")

    expect(() => selectStartupDirectories({ projectRootOption: file, env: {}, cwd: process.cwd() }))
      .toThrow(/project directory is not a directory/)
  })
})

describe("monorepo-aware startup directory selection", () => {
  test("the nearest .flywheel directory between cwd and the Git root owns project state", () => {
    const root = repository()
    const subproject = join(root, "packages", "app")
    const nested = join(subproject, "src", "features")
    mkdirSync(join(root, ".flywheel"))
    mkdirSync(join(subproject, ".flywheel"), { recursive: true })
    mkdirSync(nested, { recursive: true })

    expect(selectStartupDirectories({ env: {}, cwd: nested }).projectRoot).toBe(subproject)
  })

  test("a non-directory .flywheel marker is ignored", () => {
    const root = repository()
    const nested = join(root, "packages", "app")
    mkdirSync(nested, { recursive: true })
    writeFileSync(join(nested, ".flywheel"), "not a directory")

    expect(selectStartupDirectories({ env: {}, cwd: nested }).projectRoot).toBe(root)
  })

  test("discovery does not inspect sibling projects or ancestors above the nearest Git root", () => {
    const outer = tempDir()
    const root = join(outer, "repo")
    const sibling = join(root, "sibling")
    const nested = join(root, "packages", "app")
    mkdirSync(join(outer, ".flywheel"))
    mkdirSync(join(root, ".git"), { recursive: true })
    mkdirSync(join(sibling, ".flywheel"), { recursive: true })
    mkdirSync(nested, { recursive: true })

    expect(selectStartupDirectories({ env: {}, cwd: nested }).projectRoot).toBe(root)
  })

  test("interactive selection receives canonical distinct candidates and can choose the starting directory", async () => {
    const root = repository()
    const real = join(root, "packages", "app")
    const link = join(root, "app-link")
    mkdirSync(real, { recursive: true })
    symlinkSync(real, link)
    let received: readonly StartupDirectoryFallbackCandidate[] = []

    const directories = await selectInteractiveStartupDirectories({ env: {}, cwd: link }, async (candidates) => {
      received = candidates
      return "starting-directory"
    })

    expect(received).toEqual([
      { kind: "git-root", path: root },
      { kind: "starting-directory", path: real },
    ])
    expect(directories.projectRoot).toBe(real)
  })

  test("interactive selection can choose the Git root and propagates chooser rejection", async () => {
    const root = repository()
    const nested = join(root, "packages", "app")
    mkdirSync(nested, { recursive: true })

    expect((await selectInteractiveStartupDirectories({ env: {}, cwd: nested }, async () => "git-root")).projectRoot).toBe(root)
    expect(selectInteractiveStartupDirectories({ env: {}, cwd: nested }, async () => { throw new Error("cancelled") }))
      .rejects.toThrow("cancelled")
  })

  test("explicit and established projects bypass the chooser", async () => {
    const root = repository()
    const established = join(root, "packages", "app")
    mkdirSync(join(established, ".flywheel"), { recursive: true })
    let calls = 0
    const chooser = async (): Promise<"git-root"> => { calls += 1; return "git-root" }

    expect((await selectInteractiveStartupDirectories({ projectRootOption: established, env: {}, cwd: root }, chooser)).projectRoot).toBe(established)
    expect((await selectInteractiveStartupDirectories({ env: {}, cwd: established }, chooser)).projectRoot).toBe(established)
    expect(calls).toBe(0)
  })

  test("collapsed fallback candidates select silently", async () => {
    const root = repository()
    let calls = 0

    const directories = await selectInteractiveStartupDirectories({ env: {}, cwd: root }, async () => {
      calls += 1
      return "starting-directory"
    })

    expect(directories.projectRoot).toBe(root)
    expect(calls).toBe(0)
  })

  test("deleting an established marker causes a later interactive choice", async () => {
    const root = repository()
    const project = join(root, "packages", "app")
    const marker = join(project, ".flywheel")
    mkdirSync(marker, { recursive: true })
    expect((await selectInteractiveStartupDirectories({ env: {}, cwd: project }, async () => { throw new Error("not called") })).projectRoot).toBe(project)

    rmSync(marker, { recursive: true })
    expect((await selectInteractiveStartupDirectories({ env: {}, cwd: project }, async () => "starting-directory")).projectRoot).toBe(project)
  })
})

describe("the global --project-root option", () => {
  test("the separated form is accepted and removed before dispatch", async () => {
    expect(await rootCliAction(["--project-root", "/scratch/project", "events", "maintain", "--stats"])).toEqual({
      kind: "run",
      args: ["events", "maintain", "--stats"],
      projectRootOption: "/scratch/project",
    })
  })

  test("the equals form is accepted", async () => {
    expect(await rootCliAction(["--project-root=/scratch/project"])).toEqual({
      kind: "run",
      args: [],
      projectRootOption: "/scratch/project",
    })
  })

  test("it is accepted anywhere before a literal --", async () => {
    expect(await rootCliAction(["memory", "show", "--json", "--project-root", "/scratch/project"])).toEqual({
      kind: "run",
      args: ["memory", "show", "--json"],
      projectRootOption: "/scratch/project",
    })
  })

  test("everything after a literal -- belongs to the command", async () => {
    expect(await rootCliAction(["mcp", "add", "local", "--", "--project-root", "/scratch/project"])).toEqual({
      kind: "run",
      args: ["mcp", "add", "local", "--", "--project-root", "/scratch/project"],
    })
  })

  test("a missing value is rejected", async () => {
    expect(await rootCliAction(["--project-root"])).toEqual({ kind: "error", message: "--project-root requires a value" })
    expect(await rootCliAction(["--project-root", "--print-logs"])).toEqual({ kind: "error", message: "--project-root requires a value" })
    expect(await rootCliAction(["--project-root="])).toEqual({ kind: "error", message: "--project-root requires a value" })
  })

  test("a duplicate is rejected", async () => {
    expect(await rootCliAction(["--project-root", "/scratch/a", "--project-root=/scratch/b"]))
      .toEqual({ kind: "error", message: "--project-root may be given once" })
  })
})
