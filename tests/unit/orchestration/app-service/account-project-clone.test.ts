import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { createAccountProjectClone, ProjectCloneFailure } from "../../../../src/orchestration/app-service/account-project-clone.js"
import { createAccountProjectRegistry } from "../../../../src/orchestration/app-service/account-project-registry.js"
import type { OwnedCommandOptions, OwnedCommandResult } from "../../../../src/infra/owned-command.js"
import { temporaryDirectories } from "../../../helpers/directories.js"
import { fakeOwnedCommandRunner, ownedCommandResult } from "../../../helpers/owned-command-fake.js"

/** The account's clone owner: what a paired device's repository becomes on
 *  the machine. Git is faked at the owned-command seam, so nothing here runs
 *  git or touches the network. */

const temporary = temporaryDirectories()
const registries: ReturnType<typeof createAccountProjectRegistry>[] = []

afterEach(async () => {
  for (const registry of registries.splice(0)) await registry.dispose()
})

/** A git that clones by making the destination folder, as a real clone would. */
function cloningGit(answer: (destination: string, options: OwnedCommandOptions | undefined) => OwnedCommandResult = () => ownedCommandResult()) {
  return fakeOwnedCommandRunner(async (command, options) => {
    const destination = command.at(-1) ?? ""
    mkdirSync(join(destination, ".git"), { recursive: true })
    return answer(destination, options)
  })
}

function setup(run: ReturnType<typeof fakeOwnedCommandRunner>["run"]) {
  const home = realpathSync(temporary("flywheel-clone-home-"))
  const registry = createAccountProjectRegistry({ userDataRoot: join(home, ".flywheel") })
  registries.push(registry)
  const projectsRoot = join(home, "flywheel-projects")
  const clone = createAccountProjectClone({ projectsRoot, registry, run, searchPath: () => "/login/bin", environment: { HOME: home, PATH: "/service/bin" } })
  return { home, registry, projectsRoot, clone }
}

describe("account project clone", () => {
  test("clones over https or ssh only, with the login PATH and no prompt, into a folder named for the repository, and records it", async () => {
    const git = cloningGit()
    const { registry, projectsRoot, clone } = setup(git.run)
    const project = await clone.clone("owner/tool")
    expect(project).toEqual({ projectRoot: join(projectsRoot, "tool"), label: "tool" })
    expect(git.calls[0]?.command).toEqual(["git", "-c", "protocol.allow=never", "-c", "protocol.https.allow=always", "-c", "protocol.ssh.allow=always", "clone", "--", "https://github.com/owner/tool.git", join(projectsRoot, "tool")])
    expect(git.calls[0]?.options?.env).toMatchObject({ PATH: "/login/bin", GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never" })
    expect((await registry.list()).map((recorded) => [recorded.projectRoot, recorded.label])).toEqual([[join(projectsRoot, "tool"), "tool"]])
  })

  test("never clones into a folder that exists or one Windows cannot make, and two clones of one repository at once take two folders", async () => {
    let release: () => void = () => {}
    const held = new Promise<void>((resolve) => { release = resolve })
    const git = fakeOwnedCommandRunner(async (command) => {
      await held
      mkdirSync(command.at(-1) ?? "", { recursive: true })
      return ownedCommandResult()
    })
    const { projectsRoot, clone } = setup(git.run)
    mkdirSync(join(projectsRoot, "tool"), { recursive: true })
    writeFileSync(join(projectsRoot, "tool", "mine.txt"), "the person's own")
    const first = clone.clone("owner/tool")
    const second = clone.clone("https://example.com/other/tool.git")
    await new Promise((resolve) => setTimeout(resolve, 0))
    release()
    expect((await Promise.all([first, second])).map((project) => project.label).sort()).toEqual(["tool-2", "tool-3"])
    expect((await clone.clone("owner/aux")).label).toBe("aux-project")
    expect((await clone.clone("owner/CON.js")).label).toBe("CON-project.js")
  })

  test("refuses a path on the machine without running git", async () => {
    const git = cloningGit()
    const { registry, clone } = setup(git.run)
    await expect(clone.clone("/home/person/secret")).rejects.toBeInstanceOf(ProjectCloneFailure)
    expect(git.calls).toEqual([])
    expect(await registry.list()).toEqual([])
  })

  test("a clone the machine has no credentials for says how to give it access, removes its folder, and records nothing", async () => {
    const git = cloningGit(() => ({ ...ownedCommandResult("", 128), stderr: "Cloning into 'private'...\nfatal: could not read Username for 'https://github.com': terminal prompts disabled\n" }))
    const { registry, projectsRoot, clone } = setup(git.run)
    const failure = await clone.clone("owner/private").catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(ProjectCloneFailure)
    expect(String(failure)).toContain("gh auth setup-git")
    expect(String(failure)).toContain("terminal prompts disabled")
    expect(existsSync(join(projectsRoot, "private"))).toBe(false)
    expect(await registry.list()).toEqual([])
  })

  test("stopping ends a clone in progress and says so", async () => {
    const gitStarted = Promise.withResolvers<void>()
    const git = fakeOwnedCommandRunner((command, options) => new Promise((resolve) => {
      mkdirSync(command.at(-1) ?? "", { recursive: true })
      options?.signal?.addEventListener("abort", () => resolve({ ...ownedCommandResult(), exitCode: null }), { once: true })
      gitStarted.resolve()
    }))
    const { projectsRoot, clone } = setup(git.run)
    const cloning = clone.clone("owner/tool").catch((error: unknown) => error)
    // The clone makes its projects folder on the file system before git
    // starts, so "in progress" is git having started, not a timer turn.
    await gitStarted.promise
    await clone.dispose()
    expect(String(await cloning)).toContain("stopped before the clone finished")
    expect(existsSync(join(projectsRoot, "tool"))).toBe(false)
    await expect(clone.clone("owner/tool")).rejects.toThrow("stopping")
  })
})
