import { beforeAll, expect, test } from "bun:test"
import { existsSync, mkdirSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { loadBashParser } from "../../../src/orchestration/agent-runtime/tools/bash-parser.js"
import { hostGuard, powerShellWrite, repositoryHarness } from "./_bash-mutation-repository.js"

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
    const command = session()
    const homes = [(await command("git status --porcelain")).home]
    for (let attempt = 0; attempt < Math.max(reuseAttempts, 1); attempt++) {
      const next = await command("git status --porcelain")
      expect(next.content).not.toMatch(/^( M|\?\?| D) /m)
      if (next.home === homes.at(-1)) break
      expect(existsSync(homes.at(-1)!)).toBe(false)
      homes.push(next.home)
    }
    if (reuseAttempts === 0) expect(homes).toHaveLength(2)
    else expect(homes.length).toBeLessThanOrEqual(reuseAttempts)
  })
}, 60_000)

for (const racy of [false, true]) {
  test(`a same-size project write with its mtime restored reaches the next command's copy (${racy ? "inside" : "outside"} the racy window)`, async () => {
    await inRepository(async ({ root, session }) => {
      const command = session()
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
    const command = session()
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
    const command = session()
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
      const command = session()
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
