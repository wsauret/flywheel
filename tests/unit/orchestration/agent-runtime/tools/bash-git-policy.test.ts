import { describe, expect, it } from "bun:test";

import { classifyGitArgv } from "../../../../../src/orchestration/agent-runtime/tools/bash-git-policy.js";
import { runMutationGit } from "../../../../../src/orchestration/agent-runtime/tools/bash-git-main.js";
import { splitGitAlias } from "../../../../../src/orchestration/agent-runtime/tools/bash-git-alias.js";
import { join } from "node:path";
import type { runInheritedCommand } from "../../../../../src/infra/inherited-command.js";

const MESSAGE = "Git repository writes are not allowed in a mutating command. Rerun this git command as a separate call without mutates.";

const REAL_GIT = join(process.cwd(), "real-git");

function gitRunner(config = "", builtins = "status\nhelp\n", overrides: Partial<Awaited<ReturnType<typeof runInheritedCommand>>> = {}) {
  const calls: { command: readonly string[]; options: Parameters<typeof runInheritedCommand>[1] }[] = [];
  const run: typeof runInheritedCommand = async (command, options) => {
    calls.push({ command, options });
    return {
      exitCode: 0, signalCode: null, stdoutTruncated: false, stderrTruncated: false, stderr: "",
      stdout: command.includes("config") ? config : command.includes("--list-cmds=builtins") ? builtins : "",
      ...overrides,
    };
  };
  return { run, calls };
}

describe("mutation Git helper", () => {
  it("refuses write modes without any Git invocation", async () => {
    const fake = gitRunner();
    expect(await runMutationGit(["add", "secret file"], REAL_GIT, fake.run)).toEqual({ kind: "refused", exitCode: 97, message: MESSAGE });
    expect(fake.calls).toEqual([]);
  });

  it("resolves effective configuration in the selected context and puts trusted overrides last", async () => {
    const fake = gitRunner("diff.driver with spaces.textconv\ncat\0diff.driver with spaces.textconv\ncat\0");
    const context = ["-C", "repository with spaces", "-c", "core.fsmonitor=bad", "--config-env=diff.driver with spaces.cachetextconv=USER_CACHE"];
    expect(await runMutationGit([...context, "show", "HEAD:a b"], REAL_GIT, fake.run)).toEqual({ kind: "delegated", exitCode: 0, signalCode: null });
    expect(fake.calls[0]).toEqual({
      command: [REAL_GIT, ...context, "--no-optional-locks", "-c", "core.fsmonitor=false", "config", "--null", "--get-regexp", "^(alias\\.|diff\\..*\\.textconv$)"],
      options: { output: "capture", stdin: "ignore" },
    });
    expect(fake.calls[1]).toEqual({
      command: [REAL_GIT, ...context, "--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "diff.driver with spaces.cachetextconv=false", "show", "HEAD:a b"],
      options: { output: "inherit" },
    });
  });

  it("recursively classifies ordinary aliases and keeps exact quoted arguments", async () => {
    const fake = gitRunner(["alias.outer\n-c core.fsmonitor=bad inner 'a b'", "alias.inner\n" + String.raw`log --format="%H \"x\""`, ""].join("\0"));
    const result = await runMutationGit(["-C", "repo", "outer", "--", "trailing path"], REAL_GIT, fake.run);
    expect(result.kind).toBe("delegated");
    expect(fake.calls.at(-1)?.command).toEqual([
      REAL_GIT, "-C", "repo", "-c", "core.fsmonitor=bad", "--no-optional-locks", "-c", "core.fsmonitor=false",
      "log", '--format=%H "x"', "a b", "--", "trailing path",
    ]);
  });

  it.each([
    ["alias.a\n!echo content\0", "a"],
    ["alias.a\nb\0alias.b\na\0", "a"],
    ["alias.a\nlog 'unclosed\0", "a"],
    ["alias.a\nlog trailing\\\0", "a"],
    ["alias.a\nadd\0", "a"],
    ["alias.help\nstatus\0", "help"],
    ["alias.status\nadd\0", "status"],
    ["", "external-extension"],
  ])("does not execute uncertified aliases or override builtins (%s)", async (config, command) => {
    const fake = gitRunner(config);
    const result = await runMutationGit([command], REAL_GIT, fake.run);
    expect(result.kind).toBe(command === "status" ? "delegated" : "refused");
    expect(fake.calls.filter((call) => call.options.output === "inherit").length).toBe(command === "status" ? 1 : 0);
  });

  it.each([
    { exitCode: 128 }, { stdoutTruncated: true }, { stderrTruncated: true }, { signalCode: "SIGTERM" as const },
  ])("refuses when configuration cannot be completely read (%j)", async (failure) => {
    const fake = gitRunner("", "", failure);
    expect(await runMutationGit(["status"], REAL_GIT, fake.run)).toEqual({ kind: "refused", exitCode: 97, message: MESSAGE });
    expect(fake.calls).toHaveLength(1);
  });

  it("allows absent configuration and preserves delegated exit metadata", async () => {
    const fake = gitRunner("", "", { exitCode: 1 });
    expect(await runMutationGit(["status"], REAL_GIT, fake.run)).toEqual({ kind: "delegated", exitCode: 1, signalCode: null });
  });
});

describe("Git alias split_cmdline", () => {
  it.each([
    ["log 'a b' \"c d\" e\\ f", ["log", "a b", "c d", "e f"]],
    ['log "a\\qb" \'a\\qb\'', ["log", "aqb", "a\\qb"]],
    [" log\t\nx ", ["", "log", "x", ""]],
    ["log '' a\"b\"c", ["log", "", "abc"]],
    ["log trailing\\", undefined],
    ["log 'unfinished", undefined],
  ] as const)("splits %j using Git's quote and backslash rules", (value, expected) => {
    expect(splitGitAlias(value)).toEqual(expected === undefined ? undefined : [...expected]);
  });
});

const READS = [
  ["status", "--porcelain=v2"], ["diff", "--cached"], ["log", "--oneline", "-3"],
  ["show", "HEAD:path with spaces"], ["ls-files", "--stage", "-z"], ["rev-parse", "HEAD"],
  ["blame", "--contents", "input.txt", "file"], ["grep", "-n", "needle"],
  ["describe", "--dirty"], ["rev-list", "--objects", "--all"],
  ["cat-file", "--batch-command"], ["show-ref", "--verify", "refs/heads/main"],
  ["show-ref", "--exclude-existing=refs/heads/"], ["for-each-ref", "--format=%(refname)"],
  ["symbolic-ref", "--quiet", "--short", "HEAD"], ["symbolic-ref", "--no-recurse", "HEAD"],
  ["ls-tree", "-rz", "HEAD"], ["merge-base", "--is-ancestor", "HEAD", "main"],
  ["hash-object", "--stdin"], ["hash-object", "-t", "blob", "--", "-w"],
  ["--version"], ["--help"], ["-v"], ["-h"],
  ["branch"], ["branch", "-avv"], ["branch", "--show-current"],
  ["branch", "--list", "feature/*"], ["branch", "-l", "--format=%(refname)", "main"],
  ["branch", "--contains", "HEAD", "feature/*"], ["branch", "--merged=HEAD"],
  ["branch", "--no-merged", "HEAD", "pattern"], ["branch", "--points-at", "HEAD", "pattern"],
  ["tag"], ["tag", "--list", "v*"], ["tag", "-n10", "v*"],
  ["tag", "--contains=HEAD", "v*"], ["tag", "--no-contains", "HEAD", "v*"],
  ["config", "core.bare"], ["config", "--get", "core.bare"],
  ["config", "--get-all", "remote.origin.url"], ["config", "--get-regexp", "^remote\\."],
  ["config", "--get-urlmatch", "http", "https://example.invalid"],
  ["config", "--get-color", "color.ui", "blue"], ["config", "--get-colorbool", "color.ui", "true"],
  ["config", "--global", "--list"], ["config", "-lz", "--show-origin"],
  ["config", "--file", "path with spaces", "--type", "bool", "core.bare"],
  ["config", "get", "--all", "--default", "false", "core.bare"],
  ["config", "list", "--system"], ["config", "get", "--regexp", "^remote"],
  ["remote"], ["remote", "-v"], ["remote", "get-url", "--all", "origin"],
  ["remote", "show", "-n", "origin"], ["stash", "list", "--format=%gd"],
  ["stash", "show", "-p", "stash@{0}"], ["worktree", "list", "--porcelain", "-z"],
  ["diff", "--", "--output=ordinary-file"],
  ["log", "--output-indicator-new=+"],
  ["diff", "-S", "--output=literal-search"],
  ["blame", "--contents", "--output=literal-input", "file"],
  ["diff", "-I", "--output=needle"],
  ["diff", "--ignore-matching-lines", "--output=needle"],
  ["log", "-g", "--grep-reflog", "--output=needle"],
  ["diff", "--out=invalid-option"], ["branch", "--list", "--no-list", "-l", "main"],
  ["tag", "--points-at", "HEAD", "--no-points-at", "--list", "main"],
  ["status", "--invalid-read-option"], ["branch", "--list", "--invalid-read-option"],
  ["symbolic-ref"], ["config", "get"], ["config", "get", "core.bare", "extra"],
] as const;

const WRITES = [
  ["add", "file"], ["commit", "-m", "message"], ["mv", "old", "new"], ["rm", "file"],
  ["checkout", "--", "file"], ["switch", "main"], ["apply", "--check", "patch"],
  ["reset", "--soft", "HEAD~"], ["clean", "-n"], ["merge", "main"], ["rebase", "main"],
  ["cherry-pick", "HEAD"], ["revert", "HEAD"], ["fetch"], ["pull"], ["push"],
  ["init"], ["clone", "url"], ["gc"], ["prune"], ["repack"], ["notes", "list"],
  ["restore", "--source=HEAD", "file"], ["restore", "--help"],
  ["update-ref", "refs/heads/x", "HEAD"], ["update-index", "--refresh"],
  ["read-tree", "HEAD"], ["checkout-index", "-a"], ["commit-tree", "HEAD^{tree}"],
  ["hash-object", "-w", "file"], ["hash-object", "-wt", "blob", "file"],
  ["symbolic-ref", "HEAD", "refs/heads/new"], ["symbolic-ref", "--delete", "HEAD"],
  ["symbolic-ref", "-qd", "HEAD"], ["symbolic-ref", "-mreason", "HEAD", "refs/heads/x"],
  ["branch", "new"], ["branch", "--format=%(refname)", "new"], ["branch", "--sort=refname", "new"],
  ["branch", "-d", "old"], ["branch", "-vD", "old"], ["branch", "-m", "new"],
  ["branch", "-C", "new"], ["branch", "--set-upstream-to=origin/main"],
  ["branch", "--unset-upstream"], ["branch", "--edit-description"],
  ["branch", "--list", "--create-reflog"], ["branch", "--del", "old"],
  ["branch", "--list", "--no-list", "new"], ["branch", "-l", "--no-l", "new"],
  ["branch", "--show-current", "--no-show-current", "new"],
  ["branch", "--points-at", "HEAD", "--no-points-at", "new"],
  ["tag", "v1"], ["tag", "--format=%(refname)", "v1"], ["tag", "-d", "v1"],
  ["tag", "--points-at", "HEAD", "--no-points-at", "new"],
  ["tag", "-a", "v1", "-m", "message"], ["tag", "--list", "--create-reflog"],
  ["config", "core.bare", "true"], ["config", "--global", "user.name", "name"],
  ["config", "-fconfig", "--add", "x.y", "z"], ["config", "--unset", "x.y"],
  ["config", "--remove-section", "section"], ["config", "--rename-section", "old", "new"],
  ["config", "--edit"], ["config", "-el"], ["config", "--list", "--add", "x.y", "z"],
  ["config", "set", "x.y", "z"], ["config", "unset", "x.y"],
  ["config", "edit"], ["config", "rename-section", "old", "new"], ["config", "remove-section", "old"],
  ["remote", "add", "name", "url"], ["remote", "update"], ["remote", "set-url", "origin", "url"],
  ["remote", "prune", "--dry-run", "origin"], ["stash"], ["stash", "push"], ["stash", "pop"],
  ["stash", "clear"], ["worktree", "add", "path"], ["worktree", "prune", "-n"],
  ["diff", "--output", "file"], ["log", "--output=file"], ["show", "--output=file"],
  ["stash", "show", "--output=file"], ["stash", "list", "--output=file"],
  ["log", "--format", "--output=file"], ["diff", "-L", "--output=file"],
  ["stash", "show", "-L", "--output=file"], ["rev-list", "--output=file", "HEAD"],
  ["blame", "--output=file", "file"],
  ["diff", "-I", "pattern", "--output=file"], ["log", "--grep-reflog", "x", "--output=file"],
] as const;

describe("classifyGitArgv", () => {
  it("admits defined read modes without changing their argv or validating Git arguments", () => {
    for (const argv of READS) {
      expect(classifyGitArgv(argv), JSON.stringify(argv)).toEqual({
        kind: "read", contextArgv: [], commandArgv: [...argv],
      });
    }
  });

  it("refuses repository writers and file-output modes with the exact shared refusal", () => {
    for (const argv of WRITES) {
      expect(classifyGitArgv(argv), JSON.stringify(argv)).toMatchObject({
        kind: "refused", exitCode: 97, message: MESSAGE,
      });
    }
  });

  it("preserves context and per-call configuration so trusted overrides can follow them", () => {
    const globals = ["-C", "path with spaces", "-Cchild", "--git-dir=git dir", "--work-tree", "tree",
      "--namespace", "space", "-ccore.fsmonitor=true", "-c", "alias.st=status",
      "--config-env=diff.driver.cachetextconv=CACHE", "--config-env", "core.pager=PAGER", "--no-pager"];
    const argv = [...globals, "status", "--short"];
    expect(classifyGitArgv(argv)).toEqual({
      kind: "read", contextArgv: globals, commandArgv: ["status", "--short"],
    });
    expect(classifyGitArgv([...globals, "config", "--global", "x.y", "z"]).kind).toBe("refused");
  });

  it("exposes unknown command context for the helper to resolve and recursively classify aliases", () => {
    const result = classifyGitArgv(["-C", "repo", "-c", "alias.st=status", "st", "--short"]);
    expect(result).toMatchObject({
      kind: "refused", reason: "unknown-command", contextArgv: ["-C", "repo", "-c", "alias.st=status"],
      commandArgv: ["st", "--short"],
    });
    expect(classifyGitArgv(["unknown-extension"]).kind).toBe("refused");
    expect(classifyGitArgv(["!echo status"]).kind).toBe("refused");
    expect(classifyGitArgv(["-c", "alias.restore=status", "restore", "file"])).toMatchObject({
      kind: "refused", reason: "write-mode",
    });
    const expanded = classifyGitArgv([...result.contextArgv, "status", ...result.commandArgv.slice(1)]);
    expect(expanded).toMatchObject({ kind: "read", commandArgv: ["status", "--short"] });
  });

  it("refuses unsupported globals before an apparently safe command", () => {
    for (const argv of [["--exec-path=other", "status"], ["--unknown", "status"], ["-C"], []]) {
      expect(classifyGitArgv(argv)).toMatchObject({ kind: "refused", exitCode: 97, message: MESSAGE });
    }
  });
});
