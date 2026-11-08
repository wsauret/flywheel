import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import { mkdirSync, realpathSync } from "node:fs";
import { join, sep } from "node:path";
import { Parser } from "web-tree-sitter";

import * as treeSitter from "../../../../../src/infra/tree-sitter-parser.js";
import { interceptBashCommand, isYieldPlaceholderToolCall, refusedShellWrite } from "../../../../../src/orchestration/agent-runtime/tools/bash-command-policy.js";
import { loadBashParser } from "../../../../../src/orchestration/agent-runtime/tools/bash-parser.js";
import { fileTemporaryDirectory } from "../../../../helpers/directories.js";

const NON_INTERACTIVE_VIM = [
  "vim -Nu NONE -n -Es data.txt -S edit.vim",
  "vim -e -s file < cmds",
  "vim --version",
  "nvim --headless -c 'q'",
  "cd /repo && vim -es file.txt -c 'wq'",
  "vim \"a;b.txt\" -Es -c q",
  "vim \"a|b\" --version",
];

// No preload: the policy awaits the shared parser load itself, so the first
// command in this file runs against a cold parser.
describe("interceptBashCommand (direct)", () => {
  it("loads analysis on first use and runs file inspection commands as written", async () => {
    // Only parsed analysis can name this write's target, so the first, cold call proves the load was awaited.
    const coldWrite = await interceptBashCommand("printf 'x' > /repo/src/a.ts", { scope: { userDataRoot: "/scratch/test-account", projectRoot: "/repo", cwd: "/repo", env: {}, readOnly: true } });
    expect(coldWrite?.message).toContain("`/repo/src/a.ts`");
    for (const command of ["cat a.txt", "ls src", "rg needle .", "grep foo bar.txt | cat", "x=$(head -1 a.txt); cat b.txt", "find . -name '*.ts'"]) {
      expect(await interceptBashCommand(command)).toBeNull();
    }
  });

  it("leaves target checks to the scoped execution boundary, whatever tools the dispatcher offers", async () => {
    const writes = [
      "cat > src/probe.ts <<'EOF'\nconsole.log(1)\nEOF",
      "cat > \"$TMPDIR/probe.ts\" <<'EOF'\nconsole.log(1)\nEOF",
      "cat > \"$PWD/.flywheel/sessions/s1/scratch/probe.ts\" <<'EOF'\nconsole.log(1)\nEOF",
      "dir=$(mktemp -d) && cat > \"$dir/probe.ts\" <<'EOF'\nconsole.log(1)\nEOF",
      "cat > /tmp/probe.ts <<'EOF'\nconsole.log(1)\nEOF",
      "printf 'x' > created.txt",
      "sed -i 's/a/b/' file.txt",
      "perl -pi -e 's/a/b/' file.txt",
      "awk -i inplace '{print}' file.txt",
      "apply_patch <<'PATCH'\n*** Begin Patch\n*** Update File: src/math.ts\n*** End Patch\nPATCH",
    ];
    for (const command of writes) {
      expect(await interceptBashCommand(command)).toBeNull();
    }
    // The tree-safety and sleep blocks still apply beside a write.
    expect(await interceptBashCommand("sed -i 's/a/b/' file.txt && sleep 240")).not.toBeNull();
    expect(await interceptBashCommand("sed -i 's/a/b/' file.txt && git stash")).not.toBeNull();
  });

  it("does not intercept inline scripts or script-driven file I/O", async () => {
    // Scripts are a licensed way to work.
    expect(await interceptBashCommand("bun -e 'console.log(Bun.file(\"x.json\").size)'")).toBeNull();
    expect(await interceptBashCommand("node -e 'require(\"fs\").writeFileSync(\"/tmp/x\", \"hi\")'")).toBeNull();
    expect(await interceptBashCommand("python3 -c 'open(\"/tmp/x\", \"w\").write(\"hi\")'")).toBeNull();
    expect(await interceptBashCommand(
      "python3 - <<'PY'\nfrom pathlib import Path\nPath('created.txt').write_text('x')\nPY",
    )).toBeNull();
    expect(await interceptBashCommand("bun scratch.ts")).toBeNull();
  });

  describe("a read-only agent", () => {
    // The temporary root is not canonical on macOS (/var is a link to
    // /private/var), so the cwd and the environment spell the project
    // differently from its canonical root.
    const base = fileTemporaryDirectory("bash-read-only-");
    const project = join(base, "project");
    mkdirSync(project);
    const readOnly = {
      userDataRoot: join(base, "account"), projectRoot: realpathSync(project),
      cwd: project,
      scratchDir: join(project, ".flywheel", "sessions", "s1", "scratch"),
      env: { TMPDIR: join(base, "tmp"), HOME: join(base, "home") },
    };
    const policy = (command: string) => interceptBashCommand(command, { scope: { ...readOnly, readOnly: true } });

    it("is refused a command that writes a project file, which the refusal names", async () => {
      const heredoc = await policy("cat > src/probe.ts <<'EOF'\nconsole.log(1)\nEOF");
      expect(heredoc).not.toBeNull();
      expect(heredoc?.message).toContain("This agent is read-only");
      expect(heredoc?.message).toContain("`src/probe.ts`");
      for (const command of [
        "cat > \"$PWD/src/probe.ts\" <<'EOF'\nx\nEOF",
        `echo hi > ${realpathSync(project)}/notes.txt`,
        "grep -rn needle src > notes.txt",
        "echo hi > /tmp/a.txt 2> errors.log",
        "sed -i '' 's/a/b/' src/x.ts",
        "sed -i -e 's/a/b/' src/x.ts",
        "perl -pi.bak -e 's/a/b/' src/x.ts",
        "awk -i inplace '{print}' src/x.ts",
        "apply_patch <<'PATCH'\n*** Begin Patch\n*** Update File: src/math.ts\n*** End Patch\nPATCH",
      ]) {
        expect((await policy(command))).not.toBeNull();
      }
    });

    it("runs only scratchpad writes and device sinks", async () => {
      for (const command of [
        "cat > \"$PWD/.flywheel/sessions/s1/scratch/probe.ts\" <<'EOF'\nx\nEOF",
        "cat > .flywheel/sessions/s1/scratch/probe.ts <<'EOF'\nx\nEOF",
        "echo hi > /dev/null 2>&1",
      ]) {
        expect(await policy(command)).toBeNull();
      }
      for (const command of [
        "cat > \"$TMPDIR/probe.ts\" <<'EOF'\nconsole.log(1)\nEOF",
        `cat > \${TMPDIR}/probe.ts <<'EOF'\nx\nEOF`,
        `cat > "\${FLYWHEEL_UNSET_DIR:-/tmp}/probe.ts" <<'EOF'\nx\nEOF`,
        "dir=$(mktemp -d) && cat > \"$dir/probe.ts\" <<'EOF'\nx\nEOF",
        "cat > \"$SCRATCH/probe.ts\" <<'EOF'\nx\nEOF",
        "cat > /tmp/probe.ts <<'EOF'\nx\nEOF",
        "echo hi > ~/notes.txt",
        "echo hi > ../outside.txt",
        "sed -i 's/a/b/' \"$TMPDIR/x.txt\"",
        "sed -i 's/a/b/' \"$FILE\"",
      ]) {
        expect(await policy(command)).not.toBeNull();
      }
    });
  });

  it("blocks sleeps longer than 30 seconds", async () => {
    expect(await interceptBashCommand("sleep 240")).not.toBeNull();
    expect(await interceptBashCommand("sleep 31")).not.toBeNull();
    expect(await interceptBashCommand("sleep 5m")).not.toBeNull();
    expect(await interceptBashCommand("sleep 240; tail -5 build.log")).not.toBeNull();
    expect(await interceptBashCommand("nohup dbt build > out.log 2>&1 & sleep 900")).not.toBeNull();
    const message = (await interceptBashCommand("sleep 240"))?.message;
    expect(message).toContain("use `process` with `{ action: \"wait\" }`");
    // The refusal teaches only patterns the bash tool contract allows, and its
    // condition loop must itself pass this policy.
    expect(message).not.toContain("trailing `&`");
    expect(message).toContain("`until <check>; do sleep 5; done`");
    expect(await interceptBashCommand("until [ -e gate.flag ]; do sleep 5; done")).toBeNull();
  });

  it("allows sleeps at or under 30 seconds", async () => {
    expect(await interceptBashCommand("sleep 2")).toBeNull();
    expect(await interceptBashCommand("sleep 0.5")).toBeNull();
    expect(await interceptBashCommand("sleep 30")).toBeNull();
    expect(await interceptBashCommand("sleep 5 && curl localhost:3000/healthz")).toBeNull();
  });

  it("blocks git stash unconditionally, regardless of available tools", async () => {
    for (const command of [
      "git stash", "git stash pop", "git stash -u", "git -C /tmp/repo stash", "git -c core.editor=vim stash", "git stash && bun run test",
      "git stash push -m wip", "git stash apply", "git stash drop", "git stash clear", "git stash branch topic", "git stash list && git stash pop",
    ]) {
      const result = await interceptBashCommand(command);
      expect(result).not.toBeNull();
      expect(result?.message).toContain("git stash");
    }
  });

  it("runs the stash subcommands that only report stashes", async () => {
    for (const command of ["git stash list", "git -C /tmp/repo stash list --format=%gs", "git stash show", "git stash show -p stash@{1}"]) {
      expect(await interceptBashCommand(command)).toBeNull();
    }
  });

  it("blocks git reset --hard and forced git clean unconditionally", async () => {
    for (const command of ["git reset --hard", "git reset --hard HEAD~1", "git -C /tmp/repo reset --hard origin/main"]) {
      const result = await interceptBashCommand(command);
      expect(result).not.toBeNull();
      expect(result?.message).toContain("git reset --hard");
    }
    for (const command of ["git clean -f", "git clean -fd", "git clean -dfx", "git clean --force", "git clean -f -d"]) {
      const result = await interceptBashCommand(command);
      expect(result).not.toBeNull();
      expect(result?.message).toContain("git clean");
    }
  });

  it("blocks a push of a raw commit id and runs a push of a branch", async () => {
    for (const command of ["git push origin 74e930ab3eca06711845d14f60c1def5b36ae11c:refs/heads/main", "git push origin 74e930a:main", "git push origin 74e9:main", "git -C /scratch/repo push --no-verify origin +74e930ab3:main"]) {
      const result = await interceptBashCommand(command);
      expect(result?.message).toContain("pushing a raw commit id is disallowed");
    }
    for (const command of ["git push", "git push origin main", "git push origin HEAD:main", "git push -u origin feature/add-ship-check", "git push origin refs/heads/deadbeef:main"]) {
      expect(await interceptBashCommand(command)).toBeNull();
    }
  });

  it("allows non-destructive reset and clean forms", async () => {
    expect(await interceptBashCommand("git reset HEAD~1")).toBeNull();
    expect(await interceptBashCommand("git reset --soft HEAD~1")).toBeNull();
    expect(await interceptBashCommand("git clean -n")).toBeNull();
    expect(await interceptBashCommand("git clean --dry-run")).toBeNull();
  });

  it("does not block git commands that merely mention stash", async () => {
    expect(await interceptBashCommand('git commit -m "avoid git stash"')).toBeNull();
    expect(await interceptBashCommand("git log --oneline")).toBeNull();
    expect(await interceptBashCommand("git status")).toBeNull();
  });

  it("requires the worktree lifecycle skill only for parsed git worktree commands", async () => {
    const unloaded = { effectiveBundledSkillIds: new Set<string>() };
    const loaded = { effectiveBundledSkillIds: new Set(["worktree-lifecycle"]) };

    for (const command of [
      "git worktree add ../feature feature",
      "git worktree remove ../feature",
      "git -C /repo worktree prune",
      "env git worktree add ../feature feature",
      "command git worktree remove ../feature",
      "exec git worktree move ../a ../b",
      "sudo -u root git worktree lock ../feature",
      "git worktree",
      "bash -c 'git worktree add ../feature feature'",
      // A nested shell string is matched by text, which cannot tell a listing from a change.
      "bash -c 'git worktree list'",
    ]) {
      const blocked = await interceptBashCommand(command, unloaded);
      expect(blocked).not.toBeNull();
      expect(blocked?.message).toContain('action:"load"');
      expect(blocked?.message).toContain('skill_id:"worktree-lifecycle"');
      expect(await interceptBashCommand(command, loaded)).toBeNull();
    }

    for (const command of ["git worktree list", "git -C /repo worktree list --porcelain", "exec git worktree list", "sudo -u root git worktree list"]) {
      expect(await interceptBashCommand(command, unloaded)).toBeNull();
    }
    expect(await interceptBashCommand('git commit -m "document worktree lifecycle"', unloaded)).toBeNull();
    expect(await interceptBashCommand("printf worktree", unloaded)).toBeNull();
  });

  it("gates worktree changes only while the worktree-lifecycle skill is available to the agent (D3)", async () => {
    const availableNotLoaded = { effectiveBundledSkillIds: new Set<string>(), capabilities: () => true };
    const unavailable = { effectiveBundledSkillIds: new Set<string>(), capabilities: (term: string) => term !== "skill:worktree-lifecycle" };
    expect((await interceptBashCommand("git worktree add ../feature feature", availableNotLoaded))?.message).toContain('skill_id:"worktree-lifecycle"');
    expect(await interceptBashCommand("git worktree add ../feature feature", unavailable)).toBeNull();
  });

  it("names in an interactive refusal only the file tools that the agent holds", async () => {
    const message = async (held: readonly string[], command: string) => (await interceptBashCommand(command, { capabilities: (term) => held.includes(term) }))?.message;
    expect(await message(["edit", "write", "read"], "vim notes.txt")).toContain("use the file edit tool for existing files, `write` for new files");
    expect(await message([], "vim notes.txt")).toContain("use a non-interactive command");
    expect(await message([], "vim notes.txt")).not.toMatch(/edit tool|`write`/);
    expect(await message(["read"], "less notes.txt")).toContain("or use the read tool");
    expect(await message([], "less notes.txt")).not.toContain("read tool");
  });
});

describe("isYieldPlaceholderToolCall", () => {
  const bash = (command: string) => ({ id: "tc", name: "bash", input: { command } });

  it("never drops anything without pending background work -- there is nothing to wake the loop", () => {
    for (const command of ["true", ":", "true; true", "echo waiting", "sleep 1", `printf "standing by"`, "echo waiting; sleep 1", ":  # idle"]) {
      expect(isYieldPlaceholderToolCall(bash(command), false)).toBe(false);
    }
  });

  it("with pending background work, matches pure no-op commands that express wait/yield intent", () => {
    for (const command of ["echo waiting", `echo "I'll wait for the subagent"`, "echo yielding turn", "echo waiting; sleep 1", `printf "standing by"`, "sleep 5 # waiting", ":  # idle"]) {
      expect(isYieldPlaceholderToolCall(bash(command), true)).toBe(true);
    }
  });

  it("with pending background work, matches bare true/colon/sleep ticks without any wait-intent text", () => {
    for (const command of ["true", "true # tick", ":", "true; true", "true && :", "sleep 1", "sleep 0.5", "sleep 5s # tick", "sleep 1; sleep 2", "sleep 1 && true"]) {
      expect(isYieldPlaceholderToolCall(bash(command), true)).toBe(true);
    }
  });

  it("does not treat true with arguments or trailing real work as a tick", () => {
    for (const command of ["true foo", "true && bun run build", "truecmd"]) {
      expect(isYieldPlaceholderToolCall(bash(command), true)).toBe(false);
    }
  });

  it("does not treat sleep with trailing real work as a tick", () => {
    for (const command of ["sleep 1 && curl localhost:3000", "sleep 2; bun run test", "sleep"]) {
      expect(isYieldPlaceholderToolCall(bash(command), true)).toBe(false);
    }
  });

  it("leaves harmless or real commands alone even with pending background work", () => {
    for (const command of ["echo hello world", "echo bg-test", "echo done", "bun run test"]) {
      expect(isYieldPlaceholderToolCall(bash(command), true)).toBe(false);
    }
  });

  it("applies to the bash tool, including a recorded exec call, and to no other tool", () => {
    expect(isYieldPlaceholderToolCall({ id: "tc", name: "exec", input: { command: "echo waiting" } }, true)).toBe(true);
    expect(isYieldPlaceholderToolCall({ id: "tc", name: "read", input: { command: "echo waiting" } }, true)).toBe(false);
    expect(isYieldPlaceholderToolCall({ id: "tc", name: "bash", input: {} }, true)).toBe(false);
  });

  it("with pending background work, a leading no-op + wait intent is enough even with junk trailing", () => {
    for (const command of ["echo waiting is not allowed; yielding", "echo standing by && some-junk", "sleep 1 # holding; foo"]) {
      expect(isYieldPlaceholderToolCall(bash(command), true)).toBe(true);
      // Without pending background work the trailing non-no-op must run.
      expect(isYieldPlaceholderToolCall(bash(command), false)).toBe(false);
    }
  });

  it("does not relax for a leading real command even with pending background work", () => {
    // Leading segment is real work; never a yield regardless of background work.
    expect(isYieldPlaceholderToolCall(bash("bun run build # waiting"), true)).toBe(false);
    // No wait intent: a leading no-op alone is not a yield.
    expect(isYieldPlaceholderToolCall(bash("echo hi; some-junk"), true)).toBe(false);
  });
});

describe("refusedShellWrite", () => {
  const base = realpathSync(fileTemporaryDirectory("refused-shell-write-"));
  mkdirSync(join(base, "guarded"));
  // A placed target uses the platform separator, and on Windows it is in
  // lower case, because the shell there is PowerShell and its paths ignore case.
  const placed = (path: string) => process.platform === "win32" ? path.toLowerCase() : path;
  const guarded = placed(join(base, "guarded"));
  const admits = (path: string) => path !== guarded && !path.startsWith(`${guarded}${sep}`);

  afterEach(() => {
    mock.restore();
  });

  it("returns the first placed target that the caller's rule refuses", async () => {
    expect(await refusedShellWrite("echo x > guarded/a", base, admits)).toBe(join(guarded, "a"));
    expect(await refusedShellWrite("echo x > a", join(base, "guarded"), admits)).toBe(join(guarded, "a"));
    expect(await refusedShellWrite("rm -rf guarded", base, admits)).toBe(guarded);
    expect(await refusedShellWrite("cat guarded/a; echo x > other", base, admits)).toBeNull();
  });

  it("returns a refused target that only one of several working directories reaches", async () => {
    expect(await refusedShellWrite("if test -e q; then cd guarded; fi; echo x > a", base, admits)).toBe(join(guarded, "a"));
  });

  it("leaves a target that cannot be placed to the shell's own rule", async () => {
    expect(await refusedShellWrite("rm -rf \"$(cat dirs.txt)\"", base, admits)).toBeNull();
  });

  // Analysis that cannot complete shares the coalesced `targets` failure record,
  // which the write target policy test asserts once per process.
  it("fails open when analysis cannot parse", async () => {
    await loadBashParser();
    spyOn(Parser.prototype, "parse").mockReturnValue(null);
    expect(await refusedShellWrite("echo x > guarded/a", base, admits)).toBeNull();
  });
});

describe("interactive command detection (parsed)", () => {

  it("blocks an interactive program invoked as a command", async () => {
    const cases = ["ftp ftp.example.com", "telnet host 23", "vim notes.txt", "less README.md", "top", "man ls"];

    for (const command of cases) {
      const hit = await interceptBashCommand(command);
      expect(hit).not.toBeNull();
      expect(hit?.message).toContain("Interactive command");
    }
  });

  it("runs vim and nvim in a mode without a terminal, and refuses a plain editor launch", async () => {
    for (const command of NON_INTERACTIVE_VIM) {
      expect(await interceptBashCommand(command)).toBeNull();
    }
    // A dash-shaped file name after `--` or an option value is not a mode flag.
    for (const command of ["vim file.txt", "nvim", "vim -n file.txt", "vim -s keys.txt file.txt", "vim -- -es", "nvim -- --headless", "vim -u -es file", "nano file"]) {
      expect((await interceptBashCommand(command))?.message).toContain("editors can't run interactively");
    }
  });

  it("blocks a bare interpreter that would open a REPL, but not inline execution", async () => {
    expect(await interceptBashCommand("python3")).not.toBeNull();
    expect(await interceptBashCommand("node -i")).not.toBeNull();
    expect(await interceptBashCommand("python3 -c 'print(1)'")).toBeNull();
    expect(await interceptBashCommand("python3 script.py")).toBeNull();
  });

  it("allows a heredoc interpreter only when the redirect belongs to that command", async () => {
    for (const interpreter of ["python", "python3"]) {
      const heredoc = `${interpreter} - <<'PY'\nprint(1)\nPY`;
      expect(await interceptBashCommand(heredoc)).toBeNull();
      expect(await interceptBashCommand(`echo ready && ${heredoc}`)).toBeNull();
    }

    expect(await interceptBashCommand("python && cat <<'EOF'\ntext\nEOF")).not.toBeNull();
    expect(await interceptBashCommand("echo \"$(python)\" <<'EOF'\ntext\nEOF")).not.toBeNull();
    expect(await interceptBashCommand("{ exec < /dev/tty; python; } <<'EOF'\nprint(1)\nEOF")).not.toBeNull();
  });

  it("never matches an interactive name inside quoted text or patterns", async () => {
    const falsePositives = [
      "curl -sS 'https://example.com' | grep -Ei 'pov|archive|ftp|github' | head -5",
      "echo 'use vim or nano to edit'",
      "printf '%s\\n' 'man ls prints the manual'",
      "grep -r 'telnet' src/",
    ];

    for (const command of falsePositives) {
      expect(await interceptBashCommand(command)).toBeNull();
    }
  });

  it("still blocks an interactive program behind a quiet prefix in a chain", async () => {
    expect(await interceptBashCommand("cd /tmp && ftp mirror.example.org")).not.toBeNull();
  });
})

describe("interceptBashCommand when parser analysis is unavailable", () => {
  // Every role fails open on analysis-dependent checks, including one whose
  // only shell is bash; independently recognized rules still apply.
  const analysisDependent = "printf 'x' > created.txt";
  const readOnly = { scope: { userDataRoot: "/scratch/test-account", projectRoot: "/repo", cwd: "/repo", env: {}, readOnly: true } };

  afterEach(() => {
    mock.restore();
  });

  it("allows analysis-dependent commands when the parse is null", async () => {
    await loadBashParser();
    spyOn(Parser.prototype, "parse").mockReturnValue(null);
    expect(await interceptBashCommand(analysisDependent, readOnly)).toBeNull();
    expect(await interceptBashCommand("cat a.txt")).toBeNull();
  });

  it("allows analysis-dependent commands when parsing throws", async () => {
    await loadBashParser();
    spyOn(Parser.prototype, "parse").mockImplementation(() => {
      throw new Error("wasm trap");
    });
    expect(await interceptBashCommand(analysisDependent, readOnly)).toBeNull();
  });

  it("allows analysis-dependent commands when the parser fails to load", async () => {
    spyOn(treeSitter, "loadTreeSitterParser").mockRejectedValue(new Error("no wasm"));
    expect(await interceptBashCommand(analysisDependent, readOnly)).toBeNull();
  });

  it("still applies independently recognized restrictions", async () => {
    spyOn(Parser.prototype, "parse").mockReturnValue(null);
    expect(await interceptBashCommand("git stash")).not.toBeNull();
    // Without a parse, the text cannot tell a read-only subcommand from a change.
    expect(await interceptBashCommand("git stash list")).not.toBeNull();
    expect(await interceptBashCommand("sleep 240")).not.toBeNull();
    expect(await interceptBashCommand("vim notes.txt")).not.toBeNull();
    expect(await interceptBashCommand("git worktree list", { effectiveBundledSkillIds: new Set<string>() })).not.toBeNull();
  });

  it("runs every vim command that the parsed rule runs", async () => {
    spyOn(Parser.prototype, "parse").mockReturnValue(null);
    for (const command of NON_INTERACTIVE_VIM) {
      expect(await interceptBashCommand(command)).toBeNull();
    }
    expect(await interceptBashCommand("nvim")).not.toBeNull();
  });
})
