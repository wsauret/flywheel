/** The argument vector an installed Flywheel receives, run through the real
 *  entry in its own process.
 *
 *  A UAT run of `flywheel update --help` printed the root usage instead of the
 *  update command's, which is what a build whose entry does not know the
 *  subcommand looks like. Every unit around it passes on its own, so the seam
 *  that has to be proved is the whole entry: process start, root option
 *  extraction, subcommand routing, and the command's own argument handling.
 *
 *  `--help` answers before the command builds a service, so nothing here opens
 *  the account authority or reaches the network. */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { asAsyncEventReadSurface, asAsyncEventWriter } from "../../../src/infra/event-store-types.js";
import { resolveEventStoreDbFile } from "../../../src/infra/paths.js";
import { createSqliteEventStore } from "../../../src/infra/sqlite-event-store.js";
import { createConversationTree } from "../../../src/orchestration/session/conversation/conversation-tree-handle.js";

const ENTRY = join(import.meta.dir, "..", "..", "..", "src", "cli", "index.ts");

let home = "";
let projectRoot = "";

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "flywheel-cli-entry-"));
  projectRoot = join(home, "project");
  mkdirSync(projectRoot, { recursive: true });
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

async function runEntry(args: readonly string[], guardImports = false, env: { readonly [key: string]: string } = {}): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const preload = join(import.meta.dir, "..", "..", "fixtures", "cli-startup-imports.ts");
  const proc = Bun.spawn(["bun", ...(guardImports ? ["--preload", preload] : []), ENTRY, ...args], {
    cwd: projectRoot,
    env: { ...process.env, HOME: home, FLYWHEEL_PROJECT_ROOT: projectRoot, ...env },
    stdout: "pipe",
    stderr: "pipe",
    windowsHide: true,
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, exitCode };
}

describe("the CLI entry's subcommand dispatch", () => {
  it.each([
    ["--version", /^git version /],
    ["--help", /usage: git/],
  ] as const)("selects the real mutation Git helper for %s before poisoned normal CLI composition", async (argument, expected) => {
    const realGit = Bun.which("git");
    expect(realGit).not.toBeNull();
    if (!realGit) throw new Error("Git is required for the mutation helper entry test");
    const result = await runEntry(["--internal-role=mutation-git", "--", argument], true, {
      FLYWHEEL_TEST_POISON_CLI_IMPORTS: "1",
      FLYWHEEL_MUTATION_GIT_RUNTIME: process.execPath,
      FLYWHEEL_MUTATION_GIT_SOURCE: ENTRY,
      FLYWHEEL_MUTATION_GIT_REAL: realGit,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(expected);
    expect(result.stderr).not.toContain("normal CLI composition imported");
    expect(result.stderr).not.toContain("provider runtime initialized");
  });

  it.each(["--internal-role=guardian", "--internal-role=command-supervisor", "--internal-role=binary-install"])("keeps Git payload marker %s behind the role separator", async marker => {
    const realGit = Bun.which("git");
    if (!realGit) throw new Error("Git is required for the mutation helper entry test");
    const direct = Bun.spawn([realGit, "--version", marker], {
      cwd: projectRoot, stdout: "pipe", stderr: "pipe", windowsHide: true,
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(direct.stdout).text(), new Response(direct.stderr).text(), direct.exited,
    ]);
    const result = await runEntry(["--internal-role=mutation-git", "--", "--version", marker], true, {
      FLYWHEEL_TEST_POISON_CLI_IMPORTS: "1",
      FLYWHEEL_MUTATION_GIT_RUNTIME: process.execPath,
      FLYWHEEL_MUTATION_GIT_SOURCE: ENTRY,
      FLYWHEEL_MUTATION_GIT_REAL: realGit,
    });
    expect(result).toEqual({ stdout, stderr, exitCode });
    expect(result.stderr).not.toContain("normal CLI composition imported");
    expect(result.stderr).not.toContain("provider runtime initialized");
  });

  it("detects normal CLI composition with the same import poison", async () => {
    const result = await runEntry([], true, { FLYWHEEL_TEST_POISON_CLI_IMPORTS: "1" });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("normal CLI composition imported before internal role dispatch");
  });

  it.each([
    [["--help"], "Usage: flywheel"],
    [["--version"], "flywheel "],
    [["--internal-role=guardian"], "guardian selected"],
    [["--internal-role=command-supervisor"], "command supervisor selected"],
    [["--internal-role=binary-install"], "binary install selected"],
  ] as const)("selects %j without initializing provider clients or services", async (args, expected) => {
    const result = await runEntry(args, true);
    expect(result.stderr).not.toContain("provider runtime initialized before command selection");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(expected);
  });

  it("answers `update --help` with the update command's usage, not the root usage", async () => {
    const { stdout, exitCode } = await runEntry(["update", "--help"]);

    expect(stdout).toContain("Usage: flywheel update");
    expect(stdout).not.toContain("flywheel <subcommand> [args]");
    expect(exitCode).toBe(0);
  });

  it("reaches the update command through a global option that precedes it", async () => {
    const { stdout, exitCode } = await runEntry(["--project-root", projectRoot, "update", "--help"]);

    expect(stdout).toContain("Usage: flywheel update");
    expect(exitCode).toBe(0);
  });

  it("advertises the update command in the root usage", async () => {
    const { stdout, exitCode } = await runEntry(["--help"]);

    expect(stdout).toContain("flywheel <subcommand> [args]");
    expect(stdout).toContain("  update ");
    expect(exitCode).toBe(0);
  });

  it("registers the web command and its own help", async () => {
    const command = await runEntry(["web", "--help"]);
    const root = await runEntry(["--help"]);

    expect(command.stdout).toContain("Usage: flywheel web");
    expect(command.stdout).not.toContain("flywheel <subcommand> [args]");
    expect(command.exitCode).toBe(0);
    expect(root.stdout).toContain("  web ");
  });

  it("refuses an argument the update command does not take", async () => {
    const { stderr, exitCode } = await runEntry(["update", "--force"]);

    expect(stderr).toContain("Unknown update argument: --force");
    expect(exitCode).toBe(1);
  });

  it("registers canonical skills cleanup help without a colon alias", async () => {
    const canonical = await runEntry(["skills", "cleanup", "--help"]);
    const alias = await runEntry(["skills:cleanup", "--force"]);

    expect(canonical.stdout).toContain("Usage: flywheel skills cleanup --force [--json]");
    expect(canonical.exitCode).toBe(0);
    expect(alias.exitCode).toBe(1);
  });

  it("advertises skills cleanup in root help", async () => {
    const { stdout, exitCode } = await runEntry(["--help"]);

    expect(stdout).toContain("skills cleanup --force");
    expect(exitCode).toBe(0);
  });

  it("lets canonical events search select another project", async () => {
    const otherProject = join(home, "other-project");
    mkdirSync(otherProject, { recursive: true });

    const { stderr, exitCode } = await runEntry(["events", "search", "--project-root", otherProject]);

    expect(stderr).toContain(join(otherProject, ".flywheel", "flywheel.sqlite"));
    expect(stderr).not.toContain(join(projectRoot, ".flywheel", "flywheel.sqlite"));
    expect(exitCode).toBe(1);
  });

  it("shows complete canonical skills verb help", async () => {
    const { stderr, exitCode } = await runEntry(["skills"]);
    expect(stderr).toContain("<list|why|restore|prune|cleanup|maintain|doctor>");
    expect(exitCode).toBe(2);
  });

  it("keeps skill diagnostics out of ordinary command output", async () => {
    const skillDir = join(projectRoot, ".flywheel", "skills", "incomplete");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), "---\ndescription: Incomplete dependency fixture.\ndependencies:\n  - missing-skill\n---\nFixture body.\n");

    const { stderr, exitCode } = await runEntry(["skills", "list"]);

    expect(stderr).toBe("");
    expect(exitCode).toBe(0);
  });

  // A pipe holds 64 KiB. A reader that takes nothing for a second makes the
  // command wait on a full pipe, which a file or a fast reader never does.
  it.skipIf(process.platform === "win32")("hands a reader slower than the pipe every byte a command prints", async () => {
    const store = createSqliteEventStore(resolveEventStoreDbFile(projectRoot));
    const tree = await createConversationTree({ conversationId: "conversation-1", sessionId: "session-1", store: asAsyncEventReadSurface(store), writer: asAsyncEventWriter(store) });
    for (let index = 0; index < 200; index += 1) await tree.appendMessage({ kind: "user", content: `message ${index} ${"x".repeat(500)}` });
    await tree.getStorage().dispose();
    store.close();
    const fast = await runEntry(["events", "search", "--json", "--limit", "0"]);
    expect(fast.exitCode).toBe(0);
    expect(fast.stdout.length).toBeGreaterThan(128 * 1024);

    // The installed launcher runs the entry with the browser condition.
    const slow = Bun.spawn(["sh", "-c", 'bun --conditions=browser "$0" events search --json --limit 0 | (sleep 1; wc -c)', ENTRY], {
      cwd: projectRoot,
      env: { ...process.env, HOME: home, FLYWHEEL_PROJECT_ROOT: projectRoot },
      stdout: "pipe",
      stderr: "pipe",
      windowsHide: true,
    });
    const [counted] = await Promise.all([new Response(slow.stdout).text(), slow.exited]);
    expect(Number(counted.trim())).toBe(Buffer.byteLength(fast.stdout));
  }, 30_000);
});
