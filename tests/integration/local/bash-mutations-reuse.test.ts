import { beforeAll, expect, spyOn, test } from "bun:test"
import { existsSync, mkdirSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { DebugLog } from "../../../src/infra/debug-log.js"
import type { ContainerProbe } from "../../../src/infra/process-container.js"
import { asRecord } from "../../../src/infra/record.js"
import { loadBashParser } from "../../../src/orchestration/agent-runtime/tools/bash-parser.js"
import { createPrivateCopyPool, type PrivateCopyPool } from "../../../src/orchestration/agent-runtime/tools/bash-private-copy-pool.js"
import { hostGuard, powerShellWrite, repositoryHarness, type CopyCommand } from "./_bash-mutation-repository.js"

/** A session's consecutive mutating commands against a real Git repository,
 *  real clones, real processes, and the host's real guard: each command sees
 *  the project as it is when it starts, and nothing an earlier command left
 *  reaches it. */

beforeAll(loadBashParser)
const inRepository = repositoryHarness()

/** Picks the command text of the host's shell. */
function shell(posix: string, powerShell: string): string {
  return process.platform === "win32" ? powerShell : posix
}

/** Whether the host proves that no process of a settled command still runs
 *  whatever else the machine does: Windows by its job, and Linux when the
 *  guard ran the command in its own process namespace. */
const provesNoSurvivor = process.platform === "win32" || hostGuard.pidNamespace

/** The commands after a session's first within which one must reuse its
 *  predecessor's copy; 0 when the platform never reuses. macOS proves no
 *  survivor from its process table, which a process that launchd started
 *  during the command breaks, and any program of a busy machine can start one,
 *  so a single refusal there proves nothing. */
const reuseAttempts = provesNoSurvivor ? 1 : process.platform === "darwin" ? 5 : 0

test("a session's next mutating command reuses its copy where the platform proves no survivor, and sees the project's clean state", async () => {
  await inRepository(async ({ session }) => {
    const { command, close } = session()
    const homes = [(await command("git status --porcelain")).home]
    for (let attempt = 0; attempt < Math.max(reuseAttempts, 1); attempt++) {
      const next = await command("git status --porcelain")
      expect(next.content).not.toMatch(/^( M|\?\?| D) /m)
      if (next.home === homes.at(-1)) break
      homes.push(next.home)
    }
    if (reuseAttempts === 0) expect(homes).toHaveLength(2)
    else expect(homes.length).toBeLessThanOrEqual(reuseAttempts)
    // A copy that was not reused was discarded, and the close discards the idle one: none is left behind.
    await close()
    for (const home of homes) expect(existsSync(home)).toBe(false)
  })
}, 60_000)

for (const racy of [false, true]) {
  test(`a same-size project write with its mtime restored reaches the next command's copy (${racy ? "inside" : "outside"} the racy window)`, async () => {
    await inRepository(async ({ root, session }) => {
      const { command } = session()
      const file = join(root, "a.txt")
      // A file changed within two seconds of the take is pinned by hash; an older one is trusted by its fingerprint.
      if (racy) writeFileSync(file, "one\n")
      else await Bun.sleep(2_100)
      const first = await command(shell("true", "$null"))
      const { atime, mtime } = statSync(file)
      writeFileSync(file, "uno\n")
      utimesSync(file, atime, mtime)
      const second = await command(shell("cat a.txt && printf 'uno\\nmore\\n' > a.txt", `[System.IO.File]::ReadAllText('a.txt')\n${powerShellWrite("a.txt", "uno\nmore\n")}`))
      expect(second.content).toContain("uno\n")
      expect(second.content).toContain("Updated a.txt")
      expect(readFileSync(file, "utf8")).toBe("uno\nmore\n")
      if (provesNoSurvivor) expect(second.home).toBe(first.home)
    })
  }, 60_000)
}

test("a file whose landing was refused never reaches the session's next command", async () => {
  await inRepository(async ({ root, session }) => {
    const { command } = session()
    const running = command(shell([
      "mkdir sub && printf 'left\\n' > sub/left.txt",
      "touch node_modules/started",
      "while [ ! -e node_modules/go ]; do sleep 0.05; done",
    ].join(" && "), [
      "$ErrorActionPreference = 'Stop'",
      "New-Item -ItemType Directory -Path 'sub' | Out-Null",
      powerShellWrite("sub/left.txt", "left\n"),
      powerShellWrite("node_modules/started", ""),
      "while (-not (Test-Path -LiteralPath 'node_modules/go')) { Start-Sleep -Milliseconds 50 }",
    ].join("\n")))
    const deadline = Date.now() + 20_000
    while (!existsSync(join(root, "node_modules", "started"))) {
      if (Date.now() > deadline) throw new Error("the mutation command did not start")
      await Bun.sleep(20)
    }
    // The real ancestor becomes a file, so the copy's new file cannot land.
    writeFileSync(join(root, "sub"), "real\n")
    writeFileSync(join(root, "node_modules", "go"), "")
    const first = await running
    const second = await command(shell("test ! -e sub/left.txt && cat sub", "if (Test-Path -LiteralPath 'sub/left.txt') { throw 'leftover' }\n[System.IO.File]::ReadAllText('sub')"))
    expect(second.content).toContain("real\n")
    expect(second.content).not.toContain("leftover")
    expect(readFileSync(join(root, "sub"), "utf8")).toBe("real\n")
    if (provesNoSurvivor) expect(second.home).toBe(first.home)
  })
}, 60_000)

test("the session's next command sees a new commit, a changed tracked file, and a new wholly ignored directory, and its edit lands", async () => {
  await inRepository(async ({ root, session, git }) => {
    const { command } = session()
    const first = await command(shell("true", "$null"))
    writeFileSync(join(root, ".gitignore"), "node_modules/\n.flywheel/\n.cache/\nout/\n")
    mkdirSync(join(root, "out"))
    writeFileSync(join(root, "out", "x"), "ignored\n")
    writeFileSync(join(root, "a.txt"), "changed\n")
    await git("commit", "-qam", "next")
    const head = (await git("rev-parse", "HEAD")).trim()
    const second = await command(shell(
      "git rev-parse HEAD && cat a.txt out/x && printf 'edited\\n' > a.txt",
      `git rev-parse HEAD\n[System.IO.File]::ReadAllText('a.txt')\n[System.IO.File]::ReadAllText('out/x')\n${powerShellWrite("a.txt", "edited\n")}`,
    ))
    expect(second.content).toContain(head)
    expect(second.content).toContain("changed\n")
    expect(second.content).toContain("ignored\n")
    expect(second.content).toContain("Updated a.txt")
    expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("edited\n")
    expect(await git("status", "--porcelain")).toBe(" M a.txt\n")
    if (provesNoSurvivor) expect(second.home).toBe(first.home)
  })
}, 60_000)

/** Commands that leave a writer running after they exit, which writes late.txt in the copy three seconds later. */
const detachedWriters = process.platform === "darwin" ? [
  `perl -e 'use POSIX; if (fork() == 0) { POSIX::setsid(); open(STDIN, "</dev/null"); open(STDOUT, ">/dev/null"); open(STDERR, ">/dev/null"); exec "/bin/sh", "-c", "sleep 3; printf late >> late.txt" }'`,
  `/usr/bin/perl -e 'use POSIX; if (fork() == 0) { POSIX::setsid(); open(STDIN, "</dev/null"); open(STDOUT, ">/dev/null"); open(STDERR, ">/dev/null"); sleep 3; open(my $f, ">>", "late.txt"); print $f "late"; exit 0 }'`,
] : process.platform === "linux" ? [
  "setsid -f sh -c 'sleep 3; printf late >> late.txt' </dev/null >/dev/null 2>&1",
  "env -i /usr/bin/setsid -f /bin/sh -c 'sleep 3; printf late >> late.txt' </dev/null >/dev/null 2>&1",
] : [
  "Start-Process -WindowStyle Hidden -FilePath 'powershell.exe' -ArgumentList '-NoProfile','-Command','Start-Sleep 3; Set-Content -LiteralPath late.txt -Value late' -WorkingDirectory (Get-Location).Path",
]

for (const [index, writer] of detachedWriters.entries()) {
  test(`a process a command left running never writes into a later command's copy or the project (writer ${index + 1})`, async () => {
    await inRepository(async ({ root, session }) => {
      const { command } = session()
      const absent = shell("test ! -e late.txt && echo absent", "if (-not (Test-Path -LiteralPath 'late.txt')) { 'absent' }")
      const first = await command(writer)
      const second = await command(absent)
      expect(second.content).toContain("absent")
      // Windows ends every process of the command with its job, and the Linux guard with its process namespace, so the
      // copy is proven free. On Linux without the namespace the copy is always retired. On macOS the writer may or may
      // not outlive the command's end, so only the absence checks below decide there.
      if (provesNoSurvivor) expect(second.home).toBe(first.home)
      else if (process.platform === "linux") expect(second.home).not.toBe(first.home)
      await Bun.sleep(4_000)
      // A survivor would have written into the copy by now, before any refresh could remove its bytes.
      expect(existsSync(join(second.cwd, "late.txt"))).toBe(false)
      const third = await command(absent)
      expect(third.content).toContain("absent")
      expect(existsSync(join(root, "late.txt"))).toBe(false)
    })
  }, 60_000)
}

/** A pool whose process table holds no process newer than any launch, so every
 *  copy whose landing passed goes back to it on every platform, and these cases
 *  decide only what the private Git directory of a reused copy holds. */
function settledPool(): PrivateCopyPool {
  const probe: ContainerProbe = {
    signal: () => undefined,
    groupExists: () => false,
    libproc: {
      query: pid => ({ kind: "process", pgid: pid, ppid: 1, identity: `${pid}`, start: "100" }),
      group: () => [],
      pids: () => [],
      children: () => [],
      executable: () => ({ kind: "unavailable" }),
      processArguments: () => undefined,
      environment: () => undefined,
      bootSession: () => undefined,
      footprintBytes: () => undefined,
      runnableThreads: () => undefined,
    },
  }
  return createPrivateCopyPool({ probe })
}

/** Runs `command` in a copy of `pool` and answers its output with the payload of its `agent.bash.mutation.applied` record. */
async function pooled(copyCommand: CopyCommand, pool: PrivateCopyPool, command: string) {
  const record = spyOn(DebugLog, "record")
  try {
    const content = await copyCommand(command, { pool })
    const applied = record.mock.calls.map(([event]) => event).filter(event => event.type === "agent.bash.mutation.applied")
    expect(applied).toHaveLength(1)
    return { content, record: asRecord(applied[0]!.payload) ?? {} }
  } finally {
    record.mockRestore()
  }
}

/** What a command reads of its repository: HEAD, every ref, the index entries, and the stash. */
const INSPECT: ReadonlyArray<readonly string[]> = [["rev-parse", "HEAD"], ["for-each-ref", "--format=%(refname) %(objectname)"], ["ls-files", "--stage"], ["stash", "list", "--format=%gs"]]
const INSPECT_IN_COPY = INSPECT.map(args => `git ${args.map(argument => `'${argument}'`).join(" ")}`).join(" && ")

const moves: ReadonlyArray<{ readonly name: string; readonly before?: (git: (...args: string[]) => Promise<string>, root: string) => Promise<void>; readonly move: (git: (...args: string[]) => Promise<string>, root: string) => Promise<void> }> = [
  { name: "a commit moved HEAD", move: async (git, root) => { writeFileSync(join(root, "b.txt"), "b\n"); await git("add", "b.txt"); await git("commit", "-qm", "moved") } },
  { name: "a branch was created and a tag deleted", before: async git => { await git("tag", "v1") }, move: async git => { await git("branch", "feature"); await git("tag", "-d", "v1") } },
  { name: "a file was staged", move: async (git, root) => { writeFileSync(join(root, "c.txt"), "c\n"); await git("add", "c.txt") } },
  { name: "a change was stashed", move: async (git, root) => { writeFileSync(join(root, "gone.txt"), "stashed\n"); await git("stash", "push", "-qm", "saved") } },
  { name: "a soft reset moved HEAD back", before: async (git, root) => { writeFileSync(join(root, "b.txt"), "b\n"); await git("add", "b.txt"); await git("commit", "-qm", "undone") }, move: async git => { await git("reset", "--soft", "HEAD~1") } },
]

test.skipIf(process.platform === "win32")("a reused copy keeps its private Git directory while the real repository stands still", async () => {
  await inRepository(async ({ root, copyCommand, git }) => {
    const pool = settledPool()
    try {
      expect((await pooled(copyCommand, pool, "true")).record).toMatchObject({ copy: "taken", fate: "pooled" })
      const second = await pooled(copyCommand, pool, "printf 'edited\\n' > a.txt")
      expect(second.record).toMatchObject({ copy: "refreshed", reseeded: false, status: "completed", fate: "pooled" })
      expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("edited\n")
      expect(await git("status", "--porcelain")).toBe(" M a.txt\n")
    } finally {
      await pool.close()
    }
  })
}, 60_000)

for (const { name, before, move } of moves) {
  test.skipIf(process.platform === "win32")(`a reused copy is seeded again after ${name} between commands, shows the real state, and lands its edit without changing it`, async () => {
    await inRepository(async ({ root, copyCommand, git }) => {
      const pool = settledPool()
      try {
        await before?.(git, root)
        expect((await pooled(copyCommand, pool, "true")).record).toMatchObject({ copy: "taken", fate: "pooled" })
        await move(git, root)
        const real = async () => (await Promise.all(INSPECT.map(args => git(...args)))).join("")
        const expected = await real()
        const head = await git("symbolic-ref", "HEAD")
        const second = await pooled(copyCommand, pool, `${INSPECT_IN_COPY} && printf 'edited\\n' > a.txt`)

        expect(second.record).toMatchObject({ copy: "refreshed", reseeded: true, status: "completed", fate: "pooled" })
        expect(second.content).toStartWith(expected)
        expect(second.content).toContain("Updated a.txt")
        // Landing publishes file contents only, as from a fresh copy: HEAD, refs, index, and stash stay as the move left them.
        expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("edited\n")
        expect(await real()).toBe(expected)
        expect(await git("symbolic-ref", "HEAD")).toBe(head)
      } finally {
        await pool.close()
      }
    })
  }, 60_000)
}

for (const write of ["commit -q --allow-empty -m private", "add a.txt", "stash push -q"]) {
  test.skipIf(process.platform === "win32")(`a command that runs git ${write.split(" ")[0]} in its copy is refused, lands nothing, and its copy is retained, taken or reused`, async () => {
    await inRepository(async ({ root, realGit, copyCommand, gitState }) => {
      const pool = settledPool()
      try {
        const before = await gitState()
        const command = `printf 'private\\n' > a.txt && ${JSON.stringify(realGit)} ${write}`
        // The first refused copy is taken; the command after it leaves a pooled copy that the second one reuses.
        for (const copy of ["taken", "refreshed"]) {
          const refused = await pooled(copyCommand, pool, command)
          expect(refused.record).toMatchObject({ copy, status: "repository_changed", fate: "retained" })
          expect(refused.content).toContain("A Git command changed the repository inside this mutating command")
          expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("one\n")
          // A retained copy never went back to the pool, so the next command takes a new one.
          expect((await pooled(copyCommand, pool, "true")).record).toMatchObject({ copy: "taken", fate: "pooled" })
        }
        expect(await gitState()).toEqual(before)
      } finally {
        await pool.close()
      }
    })
  }, 60_000)
}

test.skipIf(process.platform === "win32")("an index flag that a command set in its copy does not reach the next command's index", async () => {
  await inRepository(async ({ realGit, copyCommand }) => {
    const pool = settledPool()
    try {
      // Index flags leave `ls-files --stage` unchanged, so the landing passes and the copy goes back to the pool.
      const first = await pooled(copyCommand, pool, `${JSON.stringify(realGit)} update-index --assume-unchanged a.txt && git ls-files -v a.txt`)
      expect(first.record).toMatchObject({ status: "unchanged", fate: "pooled" })
      expect(first.content).toStartWith("h a.txt\n")
      const second = await pooled(copyCommand, pool, "git ls-files -v a.txt")
      expect(second.record).toMatchObject({ copy: "refreshed", reseeded: false })
      expect(second.content).toStartWith("H a.txt\n")
    } finally {
      await pool.close()
    }
  })
}, 60_000)

test.skipIf(process.platform === "win32")("a git config write in a copy lands with its file edit and does not reach the next command's private config", async () => {
  await inRepository(async ({ root, realGit, copyCommand }) => {
    const pool = settledPool()
    try {
      const first = await pooled(copyCommand, pool, `printf 'edited\\n' > a.txt && ${JSON.stringify(realGit)} config user.name x && git config --get user.name`)
      expect(first.record).toMatchObject({ status: "completed", fate: "pooled" })
      expect(first.content).toStartWith("x\n")
      expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("edited\n")
      const second = await pooled(copyCommand, pool, "git config --get user.name")
      expect(second.record).toMatchObject({ copy: "refreshed", reseeded: false })
      expect(second.content).toStartWith("Mutations\n")
    } finally {
      await pool.close()
    }
  })
}, 60_000)
