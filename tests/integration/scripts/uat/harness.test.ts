import { describe, expect, it } from "bun:test"
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { cloneAuthProfileFiles, prepareTuiUatSandbox, removeUatHome } from "../../../../scripts/uat/harness.js"
import { windowsDirectoryIsOwnerOnly } from "../../../../src/infra/windows-private-directory-acl.js"
import { LOGIN_ACCOUNTS_DIRECTORY } from "../../../../src/orchestration/modules/provider-claude-agent-sdk/names.js"

async function entriesAndModes(root: string): Promise<Map<string, number>> {
  const result = new Map<string, number>()
  async function visit(directory: string, relative: string): Promise<void> {
    for (const name of await readdir(directory)) {
      const path = join(directory, name)
      const key = join(relative, name)
      const metadata = await lstat(path)
      result.set(key, metadata.mode)
      if (metadata.isDirectory()) await visit(path, key)
    }
  }
  await visit(root, "")
  return result
}

describe("TUI UAT sandbox", () => {
  it("prepares one canonical project and clones the effective profile without changing its source", async () => {
    const scratchRoot = await mkdtemp(join(tmpdir(), "flywheel-uat-test-"))
    const sourceHome = join(scratchRoot, "source-home")
    const project = join(scratchRoot, "source-project")
    const profile = join(sourceHome, ".flywheel", "auth", "profiles", "work")
    await mkdir(profile, { recursive: true, mode: 0o750 })
    await mkdir(project)
    await writeFile(join(profile, "auth.json"), '{"token":"secret"}', { mode: 0o640 })
    await writeFile(join(profile, "profile.json"), '{"displayName":"Work"}', { mode: 0o640 })
    const login = join(profile, LOGIN_ACCOUNTS_DIRECTORY, "one")
    await mkdir(login, { recursive: true })
    await writeFile(join(login, ".claude.json"), '{"oauthAccount":{"accountUuid":"shared"}}')
    await writeFile(join(login, ".credentials.json"), "must not be copied")
    const secondLogin = join(profile, LOGIN_ACCOUNTS_DIRECTORY, "two")
    await mkdir(secondLogin)
    await writeFile(join(secondLogin, ".claude.json"), '{"oauthAccount":{"accountUuid":"second"}}')
    await writeFile(join(sourceHome, ".flywheel", "auth", ".active-profile"), "work", { mode: 0o640 })
    const before = await entriesAndModes(join(sourceHome, ".flywheel"))
    const oldHome = process.env.HOME
    process.env.HOME = sourceHome
    try {
      const sandbox = await prepareTuiUatSandbox({ scratchRoot, sourceProjectRoot: project, config: "[notifications]\ndesktop = false\n" })
      expect(sandbox.project).not.toBe(sandbox.home)
      expect("projectRoot" in sandbox).toBe(false)
      expect(sandbox.authProfile).toBe("work")
      expect(await readFile(join(sandbox.home, ".flywheel", "auth", "profiles", "work", "auth.json"), "utf8")).toContain("secret")
      const clonedProfile = join(sandbox.home, ".flywheel", "auth", "profiles", "work")
      const referenceFiles = await readdir(join(clonedProfile, LOGIN_ACCOUNTS_DIRECTORY))
      expect(referenceFiles).toHaveLength(2)
      const references = await Promise.all(referenceFiles.map(async (name) => JSON.parse(await readFile(join(clonedProfile, LOGIN_ACCOUNTS_DIRECTORY, name), "utf8"))))
      expect(references).toContainEqual({ version: 1, configDir: login })
      expect(references).toContainEqual({ version: 1, configDir: secondLogin })
      if (process.platform === "win32") {
        expect(windowsDirectoryIsOwnerOnly(join(sandbox.home, ".flywheel"))).toBe(true)
        expect(windowsDirectoryIsOwnerOnly(clonedProfile)).toBe(true)
        expect(windowsDirectoryIsOwnerOnly(join(clonedProfile, "auth.json"))).toBe(true)
        expect(windowsDirectoryIsOwnerOnly(join(clonedProfile, "profile.json"))).toBe(true)
      } else {
        expect((await stat(join(clonedProfile, "auth.json"))).mode & 0o777).toBe(0o600)
      }
      expect(await entriesAndModes(join(sourceHome, ".flywheel"))).toEqual(before)
      await removeUatHome(sandbox.home)
    } finally {
      process.env.HOME = oldHome
      await rm(scratchRoot, { recursive: true, force: true })
    }
  })

  it("allows an optional profile descriptor but requires auth credentials", async () => {
    const root = await mkdtemp(join(tmpdir(), "flywheel-uat-auth-"))
    const profile = join(root, "profile")
    await mkdir(profile)
    await writeFile(join(profile, "auth.json"), "{}")
    const login = join(profile, LOGIN_ACCOUNTS_DIRECTORY, "one")
    await mkdir(login, { recursive: true })
    await writeFile(join(login, ".claude.json"), '{"oauthAccount":{"accountUuid":"shared"}}')
    await writeFile(join(login, ".credentials.json"), "must not be copied")
    await cloneAuthProfileFiles(profile, join(root, "without-descriptor"))
    expect(await readFile(join(root, "without-descriptor", "auth.json"), "utf8")).toBe("{}")
    const references = join(root, "without-descriptor", LOGIN_ACCOUNTS_DIRECTORY)
    const referenceFiles = await readdir(references)
    expect(referenceFiles).toHaveLength(1)
    expect(JSON.parse(await readFile(join(references, referenceFiles[0]!), "utf8"))).toEqual({ version: 1, configDir: login })
    await rm(join(profile, "auth.json"))
    await expect(cloneAuthProfileFiles(profile, join(root, "missing-auth"))).rejects.toThrow("auth.json")
    await rm(root, { recursive: true, force: true })
  })

  it("does not follow linked credentials", async () => {
    const root = await mkdtemp(join(tmpdir(), "flywheel-uat-linked-auth-"))
    const profile = join(root, "profile")
    await mkdir(profile)
    await writeFile(join(root, "secret"), "{}")
    await symlink(join(root, "secret"), join(profile, "auth.json"))
    await expect(cloneAuthProfileFiles(profile, join(root, "destination"))).rejects.toThrow()
    await rm(root, { recursive: true, force: true })
  })

  it("does not migrate legacy account-root credentials", async () => {
    const scratchRoot = await mkdtemp(join(tmpdir(), "flywheel-uat-legacy-"))
    const sourceHome = join(scratchRoot, "home")
    const sourceRoot = join(sourceHome, ".flywheel")
    const project = join(scratchRoot, "project")
    await mkdir(join(sourceRoot, "auth"), { recursive: true })
    await mkdir(project)
    await writeFile(join(sourceRoot, "auth", "auth.json"), '{"legacy":true}')
    const oldHome = process.env.HOME
    process.env.HOME = sourceHome
    try {
      await expect(prepareTuiUatSandbox({ scratchRoot, sourceProjectRoot: project })).rejects.toThrow("default")
      expect(await readFile(join(sourceRoot, "auth", "auth.json"), "utf8")).toContain("legacy")
      await expect(lstat(join(sourceRoot, "auth", "profiles"))).rejects.toThrow()
    } finally {
      process.env.HOME = oldHome
      await rm(scratchRoot, { recursive: true, force: true })
    }
  })

  it("keeps credential homes until process cleanup succeeds", async () => {
    const root = await mkdtemp(join(tmpdir(), "flywheel-uat-cleanup-"))
    await writeFile(join(root, "auth.json"), "secret")
    await chmod(root, 0o700)
    try {
      await expect(removeUatHome(root, async () => {
        throw new Error("stop failed")
      })).rejects.toThrow("stop failed")
      expect((await lstat(root)).isDirectory()).toBe(true)
      await removeUatHome(root)
      await expect(lstat(root)).rejects.toThrow()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
