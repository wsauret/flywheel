import { beforeAll, expect, test } from "bun:test"
import { chmodSync, readFileSync, existsSync, mkdirSync, realpathSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { createCliLauncher } from "../../../src/cli/runtime-launch.js"
import { runOwnedCommand } from "../../../src/infra/owned-command.js"
import { createBashDefinition } from "../../../src/orchestration/agent-runtime/tools/bash.js"
import { privateCopyRemovals } from "../../../src/orchestration/agent-runtime/tools/bash-private-copy.js"
import { loadBashParser } from "../../../src/orchestration/agent-runtime/tools/bash-parser.js"
import { temporaryDirectories } from "../../helpers/directories.js"
import { hostGuard, powerShellWrite, repositoryHarness, type GitState } from "./_bash-mutation-repository.js"

/** A mutation command against a real Git repository, real clones, and a real
 *  shell: the command sees its private copy and the real history, and only
 *  publication writes the real project. */

beforeAll(loadBashParser)
const createDirectory = temporaryDirectories()
const inRepository = repositoryHarness()

/** Writes through absolute paths the command text does not show, so the root rewrite cannot reach them. */
function hiddenAbsoluteWrites(root: string): string {
  return [
    `head='${root.slice(0, 4)}'`,
    `tail='${root.slice(4)}'`,
    "printf 'escaped\\n' > \"$head$tail/escaped.txt\"",
    "printf 'shared\\n' > \"$head$tail/node_modules/pkg/shared.txt\"",
    "printf 'kept\\n' > kept.txt",
    "git status --porcelain",
  ].join("; ")
}


test("a mutating command runs in a private copy with real Git and lands its changes at exit", async () => {
  await inRepository(async ({ root, mutation }) => {
    writeFileSync(join(root, "untracked.txt"), "untracked\n")
    const realIndex = readFileSync(join(root, ".git", "index"))

    const result = await mutation(process.platform === "win32" ? [
      "$ErrorActionPreference = 'Stop'",
      powerShellWrite("a.txt", "two\n"),
      "Remove-Item -LiteralPath 'gone.txt'",
      powerShellWrite("made.txt", "new\n"),
      powerShellWrite(join(root, "absolute.txt"), "absolute\n"),
      "if (-not (Test-Path -LiteralPath 'node_modules/pkg/index.js' -PathType Leaf)) { throw 'missing dependency' }",
      "if (-not (Test-Path -LiteralPath '.cache/entry' -PathType Leaf)) { throw 'missing cache entry' }",
      "git status --porcelain",
      "Write-Output (Get-Location).Path",
    ].join("\n") : [
      "printf 'two\\n' > a.txt",
      "rm gone.txt",
      "printf 'new\\n' > made.txt",
      `printf 'absolute\\n' > ${root}/absolute.txt`,
      "test -f node_modules/pkg/index.js",
      "test -f .cache/entry",
      "git status --porcelain",
      "pwd",
    ].join(" && "))
    const content = String(result.content)

    expect(content).toContain("M a.txt\n D gone.txt\n?? absolute.txt\n?? made.txt\n?? untracked.txt\n")
    expect(content).not.toContain(`\n${root}\n`)
    expect(content).toContain(["Applied to the project:", "Updated a.txt", "Created absolute.txt", "Deleted gone.txt", "Created made.txt"].join("\n"))
    expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("two\n")
    expect(readFileSync(join(root, "absolute.txt"), "utf8")).toBe("absolute\n")
    expect(readFileSync(join(root, "made.txt"), "utf8")).toBe("new\n")
    expect(existsSync(join(root, "gone.txt"))).toBe(false)
    expect(readFileSync(join(root, "untracked.txt"), "utf8")).toBe("untracked\n")
    expect(readFileSync(join(root, ".git", "index"))).toEqual(realIndex)
  })
}, 60_000)

test("an unborn repository allows file publication but refuses its first Git write", async () => {
  await inRepository(async ({ root, mutation, git, run }) => {
    rmSync(join(root, ".git"), { recursive: true, force: true })
    await git("init", "-q", "-b", "main")
    const result = await mutation(process.platform === "win32" ? [
      "$ErrorActionPreference = 'Stop'",
      powerShellWrite("first.txt", "first\n"),
      "git add first.txt",
      "git -c user.email=mutations@example.com -c user.name=Mutations commit -qm first",
    ].join("\n") : [
      "printf 'first\\n' > first.txt",
      "git add first.txt",
      "git -c user.email=mutations@example.com -c user.name=Mutations commit -qm first",
    ].join(" && "))

    expect(String(result.content)).not.toContain("could not take a private copy")
    expect(readFileSync(join(root, "first.txt"), "utf8")).toBe("first\n")
    expect(String(result.content)).toContain("Git repository writes are not allowed in a mutating command. Rerun this git command as a separate call without mutates.")
    expect(existsSync(join(root, ".git", "index"))).toBe(false)
    expect(await git("symbolic-ref", "HEAD")).toBe("refs/heads/main\n")
    expect((await run("rev-parse", "--verify", "HEAD")).exitCode).not.toBe(0)
    expect(await git("for-each-ref")).toBe("")
  })
}, 60_000)

test("plain file edits before a Git-write refusal land without changing the project's staged entries or HEAD", async () => {
  await inRepository(async ({ root, mutation, git, gitState }) => {
    writeFileSync(join(root, "staged.txt"), "staged by the project\n")
    await git("add", "staged.txt")
    const before = await gitState()
    const result = await mutation(process.platform === "win32" ? [
      "$ErrorActionPreference = 'Stop'",
      powerShellWrite("a.txt", "two\n"),
      powerShellWrite("made.txt", "new\n"),
      powerShellWrite("loose.txt", "loose\n"),
      "git add a.txt made.txt loose.txt",
      "git -c user.email=mutations@example.com -c user.name=Mutations commit -qm fix -- a.txt made.txt",
      "git rm -q --cached gone.txt",
    ].join("\n") : [
      "printf 'two\\n' > a.txt",
      "printf 'new\\n' > made.txt",
      "printf 'loose\\n' > loose.txt",
      "git add a.txt made.txt loose.txt",
      "git -c user.email=mutations@example.com -c user.name=Mutations commit -qm fix -- a.txt made.txt",
      "git rm -q --cached gone.txt",
    ].join(" && "))

    expect(String(result.content)).toContain(["Applied to the project:", "Updated a.txt", "Created loose.txt", "Created made.txt"].join("\n"))
    expect(String(result.content)).toContain("Git repository writes are not allowed in a mutating command")
    expect(await gitState()).toEqual(before)
    expect((await git("status", "--porcelain")).split("\n").filter(Boolean).sort()).toEqual([" M a.txt", "?? loose.txt", "?? made.txt", "A  staged.txt"])
  })
}, 60_000)

test("concurrent separate Git staging stays owned by the project when a mutating command's add is refused", async () => {
  await inRepository(async ({ root, mutation, git }) => {
    const started = join(root, "node_modules", "started")
    const running = mutation(process.platform === "win32" ? [
      "$ErrorActionPreference = 'Stop'",
      powerShellWrite("node_modules/started", ""),
      "while (-not (Test-Path -LiteralPath 'node_modules/go')) { Start-Sleep -Milliseconds 50 }",
      powerShellWrite("made.txt", "mine\n"),
      "git add made.txt",
    ].join("\n") : [
      "touch node_modules/started",
      "while [ ! -e node_modules/go ]; do sleep 0.05; done",
      "printf 'mine\\n' > made.txt",
      "git add made.txt",
    ].join("\n"))
    const deadline = Date.now() + 20_000
    while (!existsSync(started)) {
      if (Date.now() > deadline) throw new Error("the mutation command did not start")
      await Bun.sleep(20)
    }
    writeFileSync(join(root, "made.txt"), "theirs\n")
    await git("add", "made.txt")
    const index = readFileSync(join(root, ".git", "index"))
    writeFileSync(join(root, "node_modules", "go"), "")
    const content = String((await running).content)

    expect(content).toContain("Git repository writes are not allowed in a mutating command")
    expect(readFileSync(join(root, ".git", "index"))).toEqual(index)
    expect(await git("show", ":made.txt")).toBe("theirs\n")
  })
}, 60_000)

test("file landing never locks or replaces the real index, so concurrent staging succeeds and retains index permissions", async () => {
  await inRepository(async ({ root, mutation, git, run }) => {
    // In a group-shared repository the index is group-writable; a written index with the umask's mode locks the group out.
    await git("config", "core.sharedRepository", "group")
    chmodSync(join(root, ".git", "index"), 0o664)
    writeFileSync(join(root, "a.txt"), "1\n2\n3\n4\n5\n6\n7\n")
    writeFileSync(join(root, "staged.txt"), "project staging\n")
    let concurrent: Awaited<ReturnType<typeof run>> | undefined
    let stagedIndex: Buffer | undefined
    let stagedIdentity: number | undefined
    const started = join(root, "node_modules", "started")
    const running = mutation(process.platform === "win32" ? [
      powerShellWrite("node_modules/started", ""),
      "while (-not (Test-Path -LiteralPath 'node_modules/go')) { Start-Sleep -Milliseconds 50 }",
      powerShellWrite("a.txt", "1\n2\n3\n4\n5\n6\ncommand\n"),
    ].join("\n") : [
      "touch node_modules/started",
      "while [ ! -e node_modules/go ]; do sleep 0.05; done",
      "printf '1\\n2\\n3\\n4\\n5\\n6\\ncommand\\n' > a.txt",
    ].join("\n"), async (command) => {
      if (concurrent || !command.includes("merge-file")) return
      expect(existsSync(join(root, ".git", "index.lock"))).toBe(false)
      concurrent = await run("add", "staged.txt")
      stagedIndex = readFileSync(join(root, ".git", "index"))
      stagedIdentity = statSync(join(root, ".git", "index")).ino
    })
    const deadline = Date.now() + 20_000
    while (!existsSync(started)) {
      if (Date.now() > deadline) throw new Error("the mutation command did not start")
      await Bun.sleep(20)
    }
    writeFileSync(join(root, "a.txt"), "1\nproject\n3\n4\n5\n6\n7\n")
    writeFileSync(join(root, "node_modules", "go"), "")
    const result = await running
    expect(String(result.content)).toContain("Updated a.txt")
    expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("1\nproject\n3\n4\n5\n6\ncommand\n")
    expect(concurrent?.exitCode).toBe(0)
    expect(stagedIndex).toEqual(readFileSync(join(root, ".git", "index")))
    expect(stagedIdentity).toBe(statSync(join(root, ".git", "index")).ino)
    expect(await git("show", ":staged.txt")).toBe("project staging\n")
    // Windows has no POSIX permission bits to keep.
    if (process.platform !== "win32") expect(statSync(join(root, ".git", "index")).mode & 0o777).toBe(0o664)
  })
}, 60_000)

test("file-only landing preserves Git's racily clean dirty-file visibility without writing its index", async () => {
  await inRepository(async ({ root, mutation, git }) => {
    // Git then compares only whole-second mtimes, sizes, and modes, so the race is set up with file times alone.
    await git("config", "core.trustctime", "false")
    await git("config", "core.checkStat", "minimal")
    const tick = new Date("2026-01-01T00:00:00Z")
    writeFileSync(join(root, "a.txt"), "two\n")
    utimesSync(join(root, "a.txt"), tick, tick)
    await git("add", "a.txt")
    // The index was written in the tick a.txt was staged, and a.txt changed again in that tick with the same size.
    utimesSync(join(root, ".git", "index"), tick, tick)
    writeFileSync(join(root, "a.txt"), "six\n")
    utimesSync(join(root, "a.txt"), tick, tick)
    const index = readFileSync(join(root, ".git", "index"))

    await mutation(process.platform === "win32" ? [
      "$ErrorActionPreference = 'Stop'",
      powerShellWrite("made.txt", "new\n"),
      "git status --porcelain",
    ].join("\n") : "printf 'new\\n' > made.txt && git status --porcelain")

    expect(readFileSync(join(root, ".git", "index"))).toEqual(index)
    expect(readFileSync(join(root, "made.txt"), "utf8")).toBe("new\n")
    expect((await git("status", "--porcelain")).split("\n").filter(Boolean).sort()).toEqual(["?? made.txt", "MM a.txt"])
  })
}, 60_000)

test("a file the project changed while the command ran is rebased with git merge-file: separate lines merge, the same lines get markers around only them", async () => {
  await inRepository(async ({ root, mutation }) => {
    writeFileSync(join(root, "lines.txt"), "1\n2\n3\n4\n5\n6\n7\n")
    writeFileSync(join(root, "clash.txt"), "x\ny\nz\n")
    // The command signals through the shared node_modules once its copy exists, then waits for the project's writes.
    const started = join(root, "node_modules", "started")
    const running = mutation(process.platform === "win32" ? [
      powerShellWrite("node_modules/started", ""),
      "while (-not (Test-Path -LiteralPath 'node_modules/go')) { Start-Sleep -Milliseconds 50 }",
      powerShellWrite("lines.txt", "1\n2\n3\n4\n5\n6\nC\n"),
      powerShellWrite("clash.txt", "x\nMINE\nz\n"),
    ].join("\n") : [
      "touch node_modules/started",
      "while [ ! -e node_modules/go ]; do sleep 0.05; done",
      "printf '1\\n2\\n3\\n4\\n5\\n6\\nC\\n' > lines.txt",
      "printf 'x\\nMINE\\nz\\n' > clash.txt",
    ].join("\n"))
    const deadline = Date.now() + 20_000
    while (!existsSync(started)) {
      if (Date.now() > deadline) throw new Error("the mutation command did not start")
      await Bun.sleep(20)
    }
    writeFileSync(join(root, "lines.txt"), "1\nP\n3\n4\n5\n6\n7\n")
    writeFileSync(join(root, "clash.txt"), "x\nTHEIRS\nz\n")
    writeFileSync(join(root, "node_modules", "go"), "")
    const result = await running
    const content = String(result.content)

    expect(readFileSync(join(root, "lines.txt"), "utf8")).toBe("1\nP\n3\n4\n5\n6\nC\n")
    // The user's merge.conflictStyle can add the base section, so only the markers around the one clashing line are fixed.
    const clash = readFileSync(join(root, "clash.txt"), "utf8")
    expect(clash.startsWith("x\n<<<<<<< project\nTHEIRS\n")).toBe(true)
    expect(clash.endsWith("=======\nMINE\n>>>>>>> command\nz\n")).toBe(true)
    // The recorded diff of a rebased file holds only the command's hunk; the unit suite asserts that evidence.
    expect(content).toContain("These files also keep the changes the project made while the command ran: lines.txt")
    expect(content).toContain("Flywheel added conflict markers where the project changed the same lines as the command: clash.txt. Edit each file to resolve the marked sections.")
  })
}, 60_000)

test("a project below the Git top level sees only its own changes in Git, and the real index stays untouched", async () => {
  const top = realpathSync(createDirectory("bash-mutations-top-"))
  const root = join(top, "packages", "app")
  const launcher = await createCliLauncher()
  const generation = launcher.scope.open()
  const git = async (...args: string[]) => {
    const result = await runOwnedCommand(generation, ["git", "-c", "user.email=mutations@example.com", "-c", "user.name=Mutations", ...args], { cwd: top })
    expect(result.exitCode).toBe(0)
  }
  try {
    mkdirSync(join(top, "other"))
    writeFileSync(join(top, "other", "x.txt"), "x\n")
    writeFileSync(join(top, ".gitignore"), ".flywheel/\n")
    mkdirSync(root, { recursive: true })
    writeFileSync(join(root, "a.txt"), "one\n")
    await git("init", "-q")
    await git("add", ".")
    await git("commit", "-qm", "init")
    const realIndex = readFileSync(join(top, ".git", "index"))

    const result = await createBashDefinition().execute({ mutates: true, command: process.platform === "win32"
      ? `${powerShellWrite("a.txt", "two\n")}; git status --porcelain`
      : "printf 'two\\n' > a.txt && git status --porcelain" }, {
      executionCwd: root, userDataRoot: `${root}/.test-account`, projectRoot: root, scratchDir: join(root, ".flywheel", "scratch"),
      availableTools: new Set(["bash", "edit", "write"]), spawnOwned: generation.spawnOwned, artifactScopeId: "bash-mutation", retrievalSessionId: "bash-mutation", sessionId: "bash-mutation", toolUseId: "bash-mutations-1",
    })
    const content = String(result.content)

    // The one porcelain line, with Git's leading space, shows nothing outside the project as deleted.
    expect(content.startsWith(" M packages/app/a.txt\n[exit code: 0]")).toBe(true)
    expect(content).toContain(["Applied to the project:", "Updated a.txt"].join("\n"))
    expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("two\n")
    expect(readFileSync(join(top, ".git", "index"))).toEqual(realIndex)
  } finally {
    await privateCopyRemovals()
    await launcher.dispose()
  }
}, 60_000)

// Seatbelt exists only on macOS, and cannot start when Flywheel already runs inside a restrictive sandbox.
test.skipIf(hostGuard.kind !== "seatbelt")("on macOS a hidden absolute write to the real project is denied and explained, while shared directories stay writable", async () => {
  await inRepository(async ({ root, mutation }) => {
    const content = String((await mutation(hiddenAbsoluteWrites(root))).content)

    expect(content).toContain(`${root}/escaped.txt: Operation not permitted`)
    expect(content).toContain("this command runs in a private copy of the project")
    expect(content).toContain(["Applied to the project:", "Created kept.txt"].join("\n"))
    expect(existsSync(join(root, "escaped.txt"))).toBe(false)
    expect(readFileSync(join(root, "node_modules", "pkg", "shared.txt"), "utf8")).toBe("shared\n")
  })
}, 60_000)

// bubblewrap exists only on Linux hosts that install it and allow it a user namespace.
test.skipIf(hostGuard.kind !== "mount-namespace")("on Linux a hidden absolute write is refused, while shared directories stay writable", async () => {
  await inRepository(async ({ root, mutation }) => {
    const content = String((await mutation(hiddenAbsoluteWrites(root))).content)

    expect(content).toContain("this command runs in a private copy")
    expect(content).toContain(["Applied to the project:", "Created kept.txt"].join("\n"))
    expect(existsSync(join(root, "escaped.txt"))).toBe(false)
    expect(readFileSync(join(root, "node_modules", "pkg", "shared.txt"), "utf8")).toBe("shared\n")
  })
}, 60_000)

test.skipIf(process.platform === "win32")("private refs preserve symbolic and dangling targets while writes refuse and bypassed changes reject every file", async () => {
  await inRepository(async ({ root, realGit, mutation, copyCommand, git, gitState }) => {
    await git("branch", "first")
    await git("branch", "second")
    await git("symbolic-ref", "refs/remotes/origin/HEAD", "refs/heads/first")
    expect(String((await mutation("git symbolic-ref refs/remotes/origin/HEAD")).content)).toContain("refs/heads/first")
    const refused = await mutation("git symbolic-ref refs/remotes/origin/HEAD refs/heads/second")
    expect(String(refused.content)).toContain("Git repository writes are not allowed in a mutating command")
    expect(await git("symbolic-ref", "refs/remotes/origin/HEAD")).toBe("refs/heads/first\n")
    await git("symbolic-ref", "refs/remotes/probe/dangling", "refs/heads/missing")
    const read = await mutation("git symbolic-ref refs/remotes/probe/dangling && printf 'read\\n' > read.txt")
    expect(String(read.content)).toContain("refs/heads/missing")
    expect(readFileSync(join(root, "read.txt"), "utf8")).toBe("read\n")
    // Packed and loose names that differ only in case, as a case-insensitive volume holds them after a fetch.
    await git("update-ref", "refs/heads/Case", "HEAD")
    await git("tag", "-a", "annotated", "-m", "annotated")
    await git("pack-refs", "--all")
    await git("update-ref", "refs/heads/case", (await git("commit-tree", "HEAD^{tree}", "-m", "other")).trim())
    const listing = "--format=%(refname) %(objectname) %(*objectname) %(symref)"
    expect(await copyCommand(`git for-each-ref '${listing}'`)).toStartWith(await git("for-each-ref", listing))
    expect(await copyCommand(`find "$(git rev-parse --git-dir)/refs/heads" -type f`)).not.toContain("refs/heads/")
    const before = await gitState()
    for (const write of ["symbolic-ref refs/remotes/origin/HEAD refs/heads/second", "update-ref refs/heads/case HEAD", "branch made"]) {
      const rejected = await copyCommand(`printf 'private\\n' > a.txt && ${JSON.stringify(realGit)} ${write}`)
      expect(rejected).toContain("A Git command changed the repository inside this mutating command")
      expect(rejected).toContain("None of the command's changes were applied")
    }
    expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("one\n")
    expect(await gitState()).toEqual(before)
    expect(await git("symbolic-ref", "refs/remotes/origin/HEAD")).toBe("refs/heads/first\n")
    const direct = await mutation("git update-ref --no-deref refs/remotes/origin/HEAD HEAD")
    expect(String(direct.content)).toContain("Git repository writes are not allowed in a mutating command")
    expect(await git("symbolic-ref", "refs/remotes/origin/HEAD")).toBe("refs/heads/first\n")
  })
}, 60_000)

test.skipIf(process.platform === "win32")("private Git reads the pre-existing stash stack but refuses stash writes without changing it", async () => {
  await inRepository(async ({ copyCommand, git, gitState, root }) => {
    writeFileSync(join(root, "a.txt"), "first\n")
    await git("stash", "push", "-qm", "first")
    writeFileSync(join(root, "a.txt"), "second\n")
    await git("stash", "push", "-qm", "second")
    const branch = (await git("branch", "--show-current")).trim()
    const stack = `On ${branch}: second\nOn ${branch}: first\n`
    const before = await gitState()
    const read = await copyCommand("git stash list --format=%gs && git stash show -p 'stash@{1}'")
    expect(read).toContain(stack)
    expect(read).toContain("+first")
    for (const command of ["git stash push -qm private", "git stash pop -q", "git stash drop -q 'stash@{1}'"]) {
      expect(await copyCommand(command)).toContain("Git repository writes are not allowed in a mutating command")
    }
    expect(await git("stash", "list", "--format=%gs")).toBe(stack)
    expect(await gitState()).toEqual(before)
    expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("one\n")
  })
}, 60_000)

test.skipIf(process.platform === "win32")("private Git lists registered sibling worktrees but refuses branch and ref writes", async () => {
  await inRepository(async ({ mutation, git, root }) => {
    const sibling = realpathSync(createDirectory("bash-mutations-sibling-"))
    await git("worktree", "add", "-qb", "sibling", sibling)
    const before = await git("rev-parse", "sibling")
    const read = await mutation("git worktree list --porcelain")
    expect(String(read.content)).toContain(`worktree ${sibling}`)
    const refusedSwitch = await mutation("git switch sibling")
    expect(String(refusedSwitch.content)).toContain("Git repository writes are not allowed in a mutating command")
    expect(await git("rev-parse", "sibling")).toBe(before)
    const refusedRef = await mutation("git update-ref refs/heads/sibling HEAD")
    expect(String(refusedRef.content)).toContain("Git repository writes are not allowed in a mutating command")
    expect(await git("rev-parse", "sibling")).toBe(before)
    expect(await git("-C", sibling, "status", "--porcelain")).toBe("")
    expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("one\n")
  })
}, 60_000)

test.skipIf(process.platform === "win32")("a split index supports private reads and file-only publication without changing the real index", async () => {
  await inRepository(async ({ root, mutation, git, gitState }) => {
    await git("update-index", "--split-index")
    const before = await gitState()
    const result = await mutation("git status --porcelain && printf 'split\\n' > a.txt && git commit -qam split")
    expect(String(result.content)).toContain("Git repository writes are not allowed in a mutating command")
    expect(String(result.content)).toContain("Updated a.txt")
    expect(await gitState()).toEqual(before)
    expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("split\n")
    expect(await git("status", "--porcelain")).toBe(" M a.txt\n")
  })
}, 60_000)

for (const format of ["--ref-format=reftable", "--object-format=sha256"]) {
  test.skipIf(process.platform === "win32")(`private Git preserves ${format} reads while only file edits land`, async () => {
    await inRepository(async ({ root, mutation, git, gitState }) => {
      const before = await gitState()
      const noop = await mutation("git status --porcelain && git rev-parse HEAD")
      expect(String(noop.content)).toContain(before.head.trim())
      expect(await gitState()).toEqual(before)
      const edited = await mutation("printf 'format\\n' > a.txt && git commit -qam format")
      expect(String(edited.content)).toContain("Git repository writes are not allowed in a mutating command")
      expect(await gitState()).toEqual(before)
      expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("format\n")
      expect(await git("status", "--porcelain")).toBe(" M a.txt\n")
      if (format === "--ref-format=reftable") {
        const sibling = realpathSync(createDirectory("bash-mutations-reftable-tree-"))
        await git("worktree", "add", "-qb", "sibling", sibling)
        const refused = await mutation("git switch sibling")
        expect(String(refused.content)).toContain("Git repository writes are not allowed in a mutating command")
        const detached = await mutation("git switch --detach -q HEAD")
        expect(String(detached.content)).toContain("Git repository writes are not allowed in a mutating command")
        expect(await git("symbolic-ref", "HEAD")).toMatch(/^refs\/heads\//)
      }
    }, [format])
  }, 60_000)
}

test.skipIf(process.platform === "win32")("handover lands only files, never private objects, and retains literal legacy Git-backed copies even when interrupted", async () => {
  await inRepository(async ({ copyCommand, gitState, run, root, realGit }) => {
    const executable = JSON.stringify(realGit)
    const before = await gitState()
    const landed = await copyCommand(`printf 'handover\\n' > a.txt && ${executable} hash-object -w a.txt`, { handover: true })
    const blob = landed.split("\n")[0]!
    expect(blob).toMatch(/^[0-9a-f]{40}$/)
    expect((await run("cat-file", "-e", blob)).exitCode).not.toBe(0)
    expect(await gitState()).toEqual(before)
    expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("handover\n")

    const detached = await copyCommand(`printf 'detached\\n' > a.txt && ${executable} switch --detach -q HEAD`, { handover: true })
    expect(detached).toContain("None of the command's changes were applied")
    expect(await gitState()).toEqual(before)
    expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("handover\n")
    await copyCommand(`printf 'interrupted\\n' > a.txt && ${executable} commit -qam interrupted`, { interrupted: true })
    expect(await gitState()).toEqual(before)
    expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("handover\n")
    for (const legacy of [2, 3] as const) {
      for (const interrupted of [false, true]) {
        const retained = await copyCommand(`printf 'legacy-${legacy}\\n' > a.txt && ${executable} add a.txt && ${executable} commit -qm legacy && ${executable} gc --prune=now`, { legacy, interrupted })
        expect(retained).toContain("a build that still landed Git changes took it")
        expect(retained).toContain("None of the command's changes were applied")
        expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("handover\n")
        expect(await gitState()).toEqual(before)
      }
    }
  })
}, 60_000)

test.skipIf(process.platform === "win32")("a bypassed private commit rejects all files and never enters the real object store while a concurrent real commit stays", async () => {
  await inRepository(async ({ root, realGit, copyCommand, git, gitState, run }) => {
    let concurrent: GitState | undefined
    const result = await copyCommand(`printf 'private\\n' > a.txt && ${JSON.stringify(realGit)} commit -qam private && git rev-parse HEAD`, {
      beforeLand: async () => {
        await git("commit", "--allow-empty", "-qm", "concurrent")
        concurrent = await gitState()
      },
    })
    expect(concurrent).toEqual(await gitState())
    expect(result).toContain("A Git command changed the repository inside this mutating command")
    expect(result).toContain("None of the command's changes were applied")
    const commandCommit = result.split("\n")[0]!
    expect(commandCommit).toMatch(/^[0-9a-f]{40}$/)
    expect((await run("cat-file", "-e", commandCommit)).exitCode).not.toBe(0)
    expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("one\n")
    const staged = await copyCommand(`printf 'private-index\\n' > a.txt && ${JSON.stringify(realGit)} add a.txt`)
    expect(staged).toContain("None of the command's changes were applied")
    expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("one\n")
    expect(concurrent).toEqual(await gitState())
  })
}, 60_000)

test.skipIf(process.platform === "win32")("fetch and registration writes refuse, config and hooks never land, and nested repositories reject adjacent files", async () => {
  await inRepository(async ({ copyCommand, git, gitState, run, root, realGit }) => {
    const remote = realpathSync(createDirectory("bash-mutations-remote-"))
    await git("init", "--bare", "-q", remote)
    await git("push", "-q", remote, "HEAD:refs/heads/remote")
    const before = await gitState()
    const fetched = await copyCommand(`git fetch ${JSON.stringify(remote)} remote:refs/remotes/probe/remote`)
    expect(fetched).toContain("Git repository writes are not allowed in a mutating command")
    expect((await run("rev-parse", "--verify", "refs/remotes/probe/remote")).exitCode).not.toBe(0)
    writeFileSync(join(root, ".git", "config.worktree"), "[probe]\ndisabled = should-not-load\n")
    const config = readFileSync(join(root, ".git", "config"))
    const result = await copyCommand(`test -z "$(git config --get probe.disabled)" && ${JSON.stringify(realGit)} config probe.private yes && mkdir -p "$(git rev-parse --absolute-git-dir)/hooks" && printf x > "$(git rev-parse --absolute-git-dir)/hooks/changed" && printf 'file\\n' > config.txt`)
    expect(result).toContain("Created config.txt")
    expect(readFileSync(join(root, ".git", "config"))).toEqual(config)
    expect(existsSync(join(root, ".git", "hooks", "changed"))).toBe(false)
    expect(await git("remote")).toBe("")
    for (const command of ["git config probe.private yes", "git remote add extra https://example.invalid/repo", "git worktree add -qb temp ../temp-tree"]) {
      expect(await copyCommand(command)).toContain("Git repository writes are not allowed in a mutating command")
    }
    const nested = await copyCommand(`mkdir nested && ${JSON.stringify(realGit)} -C nested init -q && printf 'rejected\\n' > adjacent.txt`)
    expect(nested).toContain("None of the command's changes were applied")
    expect(existsSync(join(root, "nested", ".git"))).toBe(false)
    expect(existsSync(join(root, "adjacent.txt"))).toBe(false)
    expect(await gitState()).toEqual(before)
    expect(await git("worktree", "list", "--porcelain")).not.toContain("refs/heads/temp")
  })
}, 60_000)

test.skipIf(process.platform === "win32" || hostGuard.kind === "none")("scratch allowances do not reopen registered trees or a separate Git directory, including copy aliases and mixed-path errors", async () => {
  await inRepository(async ({ copyCommand, git, root }) => {
    const scratch = join(root, ".flywheel", "scratch")
    mkdirSync(scratch, { recursive: true })
    const nested = join(scratch, "protected")
    await git("worktree", "add", "-qb", "protected", nested)
    const separate = join(scratch, "real.git")
    await git("init", "-q", `--separate-git-dir=${separate}`)
    const result = await copyCommand('printf source > source; mv "$PWD/source" .flywheel/scratch/protected/moved; printf nope > .flywheel/scratch/real.git/config; printf okay > .flywheel/scratch/allowed')
    expect(result).toContain("Set cwd")
    expect(result).toContain(nested)
    expect(existsSync(join(nested, "moved"))).toBe(false)
    expect(readFileSync(join(scratch, "allowed"), "utf8")).toBe("okay")
    expect(await git("config", "core.repositoryformatversion")).toBe("0\n")
    const direct = await copyCommand(`cd ${JSON.stringify(nested)} && printf nope > a.txt`)
    expect(direct).toContain("Set cwd")
    expect(readFileSync(join(nested, "a.txt"), "utf8")).toBe("one\n")
  })
}, 60_000)

test.skipIf(hostGuard.kind !== "seatbelt")("a shared ancestor cannot be moved to escape protection of its registered worktree", async () => {
  await inRepository(async ({ copyCommand, git, root }) => {
    writeFileSync(join(root, ".gitignore"), "node_modules/\n.flywheel/\n.trees/\n")
    const nested = join(root, ".trees", "nested")
    await git("worktree", "add", "-qb", "nested", nested)
    const result = await copyCommand(`head=${JSON.stringify(root.slice(0, 4))}; tail=${JSON.stringify(root.slice(4))}; target="$head$tail"; mv "$target/.trees" "$target/.flywheel/scratch/relocated" && printf damage > "$target/.flywheel/scratch/relocated/nested/a.txt"`)
    expect(result).toContain("Operation not permitted")
    expect(existsSync(nested)).toBe(true)
    expect(readFileSync(join(nested, "a.txt"), "utf8")).toBe("one\n")
    expect(await git("worktree", "list", "--porcelain")).toContain(`worktree ${nested}\n`)
  })
}, 60_000)
