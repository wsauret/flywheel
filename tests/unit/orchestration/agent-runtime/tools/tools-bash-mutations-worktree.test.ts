/** Bash `mutates` commands whose cwd selects the copied tree: the project, or the
 *  Git work tree that contains a cwd outside it, through any path alias. */

import { afterEach, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

import { loadBashParser } from "../../../../../src/orchestration/agent-runtime/tools/bash-parser.js";
import { privateCopyRemovals, readPrivateProjectCopy } from "../../../../../src/orchestration/agent-runtime/tools/bash-private-copy.js";
import type { ToolContext } from "../../../../../src/orchestration/agent-runtime/tools/types.js";
import { temporaryDirectories } from "../../../../helpers/directories.js";
import { mutationSpawnProbe, makeMockOwnedProcess, streamOf } from "./_bash-fixtures.js";
import { bashMutationHarness } from "./_bash-mutations-harness.js";

const createDirectory = temporaryDirectories();

beforeAll(async () => {
  await loadBashParser();
});

describe("bash tool: the tree a mutating command copies", () => {
  afterEach(privateCopyRemovals);

  const { project, runMutation } = bashMutationHarness(createDirectory);

  it.each(["file-only", "changed-index", "unverified-index"] as const)("keeps linked-index ownership through a cwd alias for a %s copy", async state => {
    const parent = project([]);
    const root = path.join(parent, "main");
    const worktree = path.join(parent, "linked");
    const alias = path.join(parent, "alias");
    const gitDir = path.join(root, ".git", "worktrees", "linked");
    fs.mkdirSync(gitDir, { recursive: true });
    fs.mkdirSync(path.join(worktree, "sub"), { recursive: true });
    fs.symlinkSync(worktree, alias, process.platform === "win32" ? "junction" : "dir");
    fs.mkdirSync(path.join(root, "sub"));
    for (const tree of [root, worktree]) {
      fs.writeFileSync(path.join(tree, "sub", "a.txt"), "old\n");
      fs.writeFileSync(path.join(tree, "sub", "gone.txt"), "gone\n");
    }
    fs.writeFileSync(path.join(worktree, ".git"), `gitdir: ${gitDir}\n`);
    fs.writeFileSync(path.join(root, ".git", "index"), "main index");
    const linkedIndex = `100644 ${"1".repeat(40)} 0\tsub/gone.txt\0`;
    fs.writeFileSync(path.join(gitDir, "index"), linkedIndex);
    fs.writeFileSync(path.join(gitDir, "HEAD"), "ref: refs/heads/linked\n");
    let privateIndex = "";
    let launched = false;
    const probe = mutationSpawnProbe(cwd => {
      expect(cwd).not.toStartWith(alias);
      expect(cwd).not.toStartWith(worktree);
      fs.writeFileSync(path.join(cwd, "a.txt"), "new\n");
      fs.rmSync(path.join(cwd, "gone.txt"));
      if (state === "changed-index") fs.writeFileSync(privateIndex, "");
      launched = true;
      expect(fs.readFileSync(path.join(worktree, "sub", "a.txt"), "utf8")).toBe("old\n");
      expect(fs.existsSync(path.join(worktree, "sub", "gone.txt"))).toBe(true);
    });
    const spawnOwned: NonNullable<ToolContext["spawnOwned"]> = async (cmd, options) => {
      const answer = (stdout: string) => makeMockOwnedProcess({ stdout: streamOf(stdout) });
      if (cmd[0] === "git") {
        if (cmd.includes("--verify")) return answer(`${"1".repeat(40)}\n`);
        if (cmd.includes("--show-object-format") && !cmd.includes("--show-toplevel")) return answer("sha1\nfiles\n");
        if (cmd.includes("rev-parse")) {
          const tree = fs.realpathSync(cmd[2]!).startsWith(worktree) ? worktree : root;
          return answer(cmd.includes("--absolute-git-dir") ? `${tree}\n${tree === worktree ? gitDir : path.join(root, ".git")}\n${path.join(root, ".git")}\n` : `${tree}\n`);
        }
        if (cmd.includes("--get-regexp")) return answer("core.repositoryformatversion 0\n");
        if (cmd.includes("symbolic-ref")) return answer("refs/heads/linked\n");
        if (cmd.includes("init") || cmd.includes("update-ref") || cmd.includes("reflog")) return answer("");
        if (cmd.includes("for-each-ref")) return answer("");
        if (cmd.includes("worktree")) return answer(`worktree ${root}\0\0worktree ${worktree}\0\0`);
        if (cmd.includes("ls-files")) {
          if (cmd.includes("--ignored")) expect(cmd[2]).toBe(worktree);
          if (cmd.includes("--stage")) {
            if (launched && state === "unverified-index") return makeMockOwnedProcess({ exited: Promise.resolve({ code: 128, signal: null, statusOf: "payload", ownership: "surrendered" }) });
            const directory = cmd.find(arg => arg.startsWith("--git-dir="))!.slice("--git-dir=".length);
            return answer(fs.readFileSync(path.join(directory, "index"), "utf8"));
          }
          const index = options?.env?.GIT_INDEX_FILE;
          return answer(index && fs.existsSync(index) ? fs.readFileSync(index, "utf8") : "");
        }
        if (cmd.includes("update-index")) {
          if (cmd.includes("--no-split-index")) return answer("");
          expect(cmd[2]).toBe(worktree);
          fs.writeFileSync(options!.env!.GIT_INDEX_FILE!, "");
          return answer("");
        }
        return probe.spawnOwned(cmd, options);
      }
      if (options?.cwd) {
        const privateGitDir = fs.readFileSync(path.join(path.dirname(options.cwd), ".git"), "utf8").trim().slice(8);
        privateIndex = path.join(privateGitDir, "index");
        const home = path.dirname(privateGitDir);
        expect(options.env!.GIT_DIR).toBeUndefined();
        expect(options.env!.GIT_INDEX_FILE).toBeUndefined();
        expect(fs.readFileSync(privateIndex, "utf8")).toBe(linkedIndex);
        expect(await readPrivateProjectCopy(home)).toMatchObject({ kind: "recorded", copy: { realRoot: worktree, git: { kind: "repository", gitDir } } });
      }
      return probe.spawnOwned(cmd, options);
    };
    const { result, store } = await runMutation(root, () => {}, { cwd: path.join(alias, "sub") }, { spawnOwned });
    if (state === "file-only") {
      expect(result.content).toContain(`Updated ${path.join("sub", "a.txt")}`);
      expect(result.content).toContain(`Deleted ${path.join("sub", "gone.txt")}`);
      expect(store.changes.map(change => change.path)).toEqual([path.join(worktree, "sub", "a.txt"), path.join(worktree, "sub", "gone.txt")]);
    } else {
      const home = path.dirname(path.dirname(privateIndex));
      expect(result.content).toContain(`${state === "changed-index" ? "A Git command changed the repository inside this mutating command" : "Flywheel could not verify the private copy's repository state"}. None of the command's changes were applied to the project. The changed files remain in the copy at ${home}. Run Git commands as separate calls without mutates. Inspect the copy and apply the file changes you need.`);
      expect(fs.existsSync(path.join(home, "copy.json"))).toBe(true);
      expect(store.facts).toEqual([]);
    }
    expect(fs.readFileSync(path.join(worktree, "sub", "a.txt"), "utf8")).toBe(state === "file-only" ? "new\n" : "old\n");
    expect(fs.existsSync(path.join(worktree, "sub", "gone.txt"))).toBe(state !== "file-only");
    expect(fs.readFileSync(path.join(root, "sub", "a.txt"), "utf8")).toBe("old\n");
    expect(fs.existsSync(path.join(root, "sub", "gone.txt"))).toBe(true);
    expect(fs.readFileSync(path.join(root, ".git", "index"), "utf8")).toBe("main index");
    expect(fs.readFileSync(path.join(gitDir, "index"), "utf8")).toBe(linkedIndex);
    expect(fs.existsSync(path.join(gitDir, "index.lock"))).toBe(false);
  });

  it("keeps a project below the Git top level as the copy authority through a cwd alias", async () => {
    const tree = project([["pkg/a.txt", "old\n"], ["outside.txt", "outside\n"]]);
    const root = path.join(tree, "pkg");
    const alias = path.join(project([]), "alias");
    fs.symlinkSync(tree, alias, process.platform === "win32" ? "junction" : "dir");
    const gitDir = path.join(tree, ".git");
    fs.mkdirSync(gitDir);
    fs.writeFileSync(path.join(gitDir, "HEAD"), "ref: refs/heads/main\n");
    const probe = mutationSpawnProbe(cwd => {
      expect(fs.existsSync(path.join(cwd, "..", "outside.txt"))).toBe(false);
      fs.writeFileSync(path.join(cwd, "a.txt"), "new\n");
      expect(fs.readFileSync(path.join(root, "a.txt"), "utf8")).toBe("old\n");
    });
    const spawnOwned: NonNullable<ToolContext["spawnOwned"]> = async (cmd, options) => {
      if (cmd[0] === "git") {
        if (cmd.includes("--verify")) return makeMockOwnedProcess({ exited: Promise.resolve({ code: 1, signal: null, statusOf: "payload", ownership: "surrendered" }) });
        if (cmd.includes("--show-object-format") && !cmd.includes("--show-toplevel")) return makeMockOwnedProcess({ stdout: streamOf("sha1\nfiles\n") });
        if (cmd.includes("symbolic-ref")) return makeMockOwnedProcess({ stdout: streamOf("refs/heads/main\n") });
        return makeMockOwnedProcess({ stdout: streamOf(cmd.includes("rev-parse") ? `${tree}\n${gitDir}\n${gitDir}\n` : cmd.includes("--get-regexp") ? "core.repositoryformatversion 0\n" : "") });
      }
      if (options?.cwd) {
        expect(options.env?.GIT_INDEX_FILE).toBeUndefined();
        const privateGitDir = fs.readFileSync(path.join(path.dirname(options.cwd), ".git"), "utf8").trim().slice(8);
        expect(await readPrivateProjectCopy(path.dirname(privateGitDir))).toMatchObject({
          kind: "recorded", copy: { realRoot: root },
        });
      }
      return probe.spawnOwned(cmd, options);
    };
    const { result, store } = await runMutation(root, () => {}, { cwd: path.join(alias, "pkg") }, { spawnOwned });
    expect(result.outcome).not.toBe("error");
    expect(fs.readFileSync(path.join(root, "a.txt"), "utf8")).toBe("new\n");
    expect(store.changes.map(change => change.path)).toEqual([path.join(root, "a.txt")]);
  });

  it("refuses an mutation cwd outside the project and every Git worktree before running the command", async () => {
    const root = project([]);
    const outside = project([]);
    const { result, launches } = await runMutation(root, () => { throw new Error("the command must not run"); }, { cwd: outside });
    expect(result.outcome).toBe("error");
    expect(result.content).toContain(outside);
    expect(launches).toEqual([]);
  });
});
