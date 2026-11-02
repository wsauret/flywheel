import { describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

import type { OwnedCommandResult, OwnedCommandRunner } from "../../../../../src/infra/owned-command.js";
import { deniedWriteNote, guardedArgv, probeMutationGuard, seatbeltProfile } from "../../../../../src/orchestration/agent-runtime/tools/bash-mutation-guard.js";
import { temporaryDirectories } from "../../../../helpers/directories.js";

const createDirectory = temporaryDirectories();

function exited(exitCode: number): OwnedCommandResult {
  return { exitCode, stdout: "", stdoutBytes: new Uint8Array(), stderr: "", timedOut: false };
}

function recording(answer: () => Promise<OwnedCommandResult>) {
  const commands: string[][] = [];
  const run: OwnedCommandRunner = async (command) => { commands.push([...command]); return answer(); };
  return { commands, run };
}

describe("bash mutation guard selection", () => {
  it("selects the platform guard only when its launcher runs a no-op cleanly", async () => {
    const seatbelt = recording(async () => exited(0));
    expect(await probeMutationGuard(seatbelt.run, "darwin")).toEqual({ kind: "seatbelt", pidNamespace: false });
    expect(seatbelt.commands).toEqual([["/usr/bin/sandbox-exec", "-p", "(version 1)(allow default)", "/usr/bin/true"]]);

    const namespace = recording(async () => exited(0));
    expect(await probeMutationGuard(namespace.run, "linux")).toEqual({ kind: "mount-namespace", pidNamespace: true });
    expect(namespace.commands).toEqual([["bwrap", "--dev-bind", "/", "/", "--unshare-pid", "--die-with-parent", "--proc", "/proc", "true"]]);
  });

  it("keeps the plain Linux guard without a process namespace on a host that refuses one", async () => {
    // A container that masks /proc refuses the namespace's own /proc mount but allows the plain guard.
    const masked = recording(async () => exited(masked.commands.length === 1 ? 1 : 0));
    expect(await probeMutationGuard(masked.run, "linux")).toEqual({ kind: "mount-namespace", pidNamespace: false });
    expect(masked.commands.at(-1)).toEqual(["bwrap", "--dev-bind", "/", "/", "true"]);
  });

  it("falls back to no guard when the launcher is refused, missing, or absent on the platform", async () => {
    // sandbox-exec exits 71 when Flywheel already runs inside a restrictive sandbox.
    const none = { kind: "none", pidNamespace: false } as const;
    expect(await probeMutationGuard(recording(async () => exited(71)).run, "darwin")).toEqual(none);
    expect(await probeMutationGuard(recording(async () => { throw Object.assign(new Error("spawn bwrap ENOENT"), { code: "ENOENT" }); }).run, "linux")).toEqual(none);
    const windows = recording(async () => exited(0));
    expect(await probeMutationGuard(windows.run, "win32")).toEqual(none);
    expect(windows.commands).toEqual([]);
  });
});

describe("bash mutation guard launch", () => {
  it("denies writes to every related tree and Git directory while keeping shared entries, scratch, and the copy writable", () => {
    const real = fs.realpathSync(createDirectory("bash-mutation-guard-"));
    // Parentheses end an SBPL form outside a string, so they must stay inside the quoted path.
    const root = path.join(real, "project with spaces (v2)");
    fs.mkdirSync(path.join(root, "node_modules"), { recursive: true });
    fs.mkdirSync(path.join(root, ".git"));
    const home = path.join(root, ".flywheel", "mutations");
    const sibling = path.join(root, "node_modules", "sibling");
    const missing = path.join(real, "vanished-parent", "worktree");
    fs.mkdirSync(home, { recursive: true });
    fs.mkdirSync(sibling);
    const alias = path.join(real, "alias");
    fs.symlinkSync(root, alias, process.platform === "win32" ? "junction" : "dir");

    const git = { kind: "repository" as const, gitDir: path.join(root, ".git"), commonDir: path.join(root, ".git"), privateGitDir: path.join(home, "git"), workTrees: [alias, sibling, missing] };
    const profile = seatbeltProfile({ home, realRoot: alias, copyRoot: "/copy", shared: ["node_modules"], git, scratchDir: home });

    expect(profile.split("\n").slice(0, 9)).toEqual([
      "(version 1)",
      "(allow default)",
      `(deny file-write* (subpath ${JSON.stringify(root)}))`,
      `(deny file-write* (subpath ${JSON.stringify(sibling)}))`,
      `(deny file-write* (subpath ${JSON.stringify(path.join(root, ".git"))}))`,
      `(allow file-write* (subpath ${JSON.stringify(path.join(root, "node_modules"))}))`,
      `(deny file-write* (subpath ${JSON.stringify(sibling)}))`,
      `(deny file-write* (subpath ${JSON.stringify(path.join(root, ".git"))}))`,
      `(allow file-write* (subpath ${JSON.stringify(home)}) (subpath ${JSON.stringify(home)}))`,
    ]);
    expect(profile.split("\n").slice(9).every(rule => rule.startsWith("(deny file-write-unlink (literal "))).toBe(true);
    expect(profile).not.toContain(missing);
    expect(profile).not.toContain(path.dirname(missing));
    expect(() => seatbeltProfile({ home, realRoot: missing, copyRoot: "/copy", shared: [], git: { ...git, workTrees: [missing] } })).toThrow();
    expect(() => seatbeltProfile({ home, realRoot: root, copyRoot: "/copy", shared: [], git: { ...git, gitDir: missing, workTrees: [missing] } })).toThrow();
    expect(() => seatbeltProfile({ home: missing, realRoot: root, copyRoot: "/copy", shared: [] })).toThrow();
    expect(() => seatbeltProfile({ home, scratchDir: missing, realRoot: root, copyRoot: "/copy", shared: [] })).toThrow();
    // Without shared entries an allow rule would have no filter and allow every write.
    expect(seatbeltProfile({ home, realRoot: root, copyRoot: "/copy", shared: [] }).split("\n").slice(0, 4)).toEqual([
      "(version 1)", "(allow default)", `(deny file-write* (subpath ${JSON.stringify(root)}))`,
      `(allow file-write* (subpath ${JSON.stringify(home)}))`,
    ]);

    // Windows cannot create quoted names, but SBPL must encode them on every host.
    const resolvedRoot = '/project "quoted" (v2)\\root';
    const realpath = spyOn(fs, "realpathSync").mockReturnValue(resolvedRoot);
    try {
      expect(seatbeltProfile({ home, realRoot: alias, copyRoot: "/copy", shared: [] }).split("\n").slice(0, 4)).toEqual([
        "(version 1)",
        "(allow default)",
        `(deny file-write* (subpath ${JSON.stringify(resolvedRoot)}))`,
        `(allow file-write* (subpath ${JSON.stringify(resolvedRoot)}))`,
      ]);
    } finally {
      realpath.mockRestore();
    }
  });

  it("makes the real root read-only before reopening shared entries and the copy home", () => {
    const home = path.resolve("/home");
    const realRoot = path.resolve("/work/project");
    const copyRoot = path.join(home, "tree", "project");
    const nested = path.join(realRoot, "node_modules", "sibling");
    const missing = path.resolve("/vanished-parent/worktree");
    const gitDir = path.join(realRoot, ".git");
    const wrap = guardedArgv({ kind: "mount-namespace", pidNamespace: false }, { home, realRoot, copyRoot, shared: ["node_modules"], git: { kind: "repository", gitDir, commonDir: gitDir, privateGitDir: path.join(home, "git"), workTrees: [realRoot, nested, missing, gitDir] } });

    expect(wrap(["/bin/bash", "/scratch/script.sh"])).toEqual([
      "bwrap", "--dev-bind", "/", "/",
      "--ro-bind", realRoot, realRoot,
      "--ro-bind-try", nested, nested,
      "--ro-bind-try", missing, missing,
      "--ro-bind", gitDir, gitDir,
      "--bind", path.join(realRoot, "node_modules"), path.join(realRoot, "node_modules"),
      "--ro-bind-try", nested, nested,
      "--ro-bind-try", missing, missing,
      "--ro-bind", gitDir, gitDir,
      "--bind", home, home,
      "--bind", path.join(realRoot, "node_modules"), path.join(copyRoot, "node_modules"),
      "--ro-bind-try", nested, path.join(copyRoot, "node_modules", "sibling"),
      "--", "/bin/bash", "/scratch/script.sh",
    ]);
    expect(guardedArgv({ kind: "mount-namespace", pidNamespace: true }, { home, realRoot, copyRoot, shared: [] })(["sh"]).slice(0, 8)).toEqual(["bwrap", "--dev-bind", "/", "/", "--unshare-pid", "--die-with-parent", "--proc", "/proc"]);
    expect(guardedArgv({ kind: "none", pidNamespace: false }, { home: "/home", realRoot: "/work/project", copyRoot: "/copy", shared: [] })(["sh", "x"])).toEqual(["sh", "x"]);
  });

  it("explains a Seatbelt denial of a write under the real root, but not a denial inside the copy's home or under another guard", () => {
    const copy = { home: "/work/project/.flywheel/mutations/one", realRoot: "/work/project", copyRoot: "/work/project/.flywheel/mutations/one/tree/project", shared: [], env: undefined };

    expect(deniedWriteNote("seatbelt", copy, "ok\nsh: /work/project/escaped.txt: Operation not permitted\n")).toContain("runs in a private copy of the project");
    expect(deniedWriteNote("seatbelt", copy, "Error: EPERM: operation not permitted, open '/work/project/x'")).toBeDefined();
    expect(deniedWriteNote("seatbelt", copy, "touch: /work/project/.flywheel/mutations/one/tree/project/locked: Operation not permitted")).toBeUndefined();
    expect(deniedWriteNote("seatbelt", copy, `mv: rename ${copy.home}/tree/project/source to ${copy.realRoot}/moved: Operation not permitted`)).toContain("Set cwd");
    expect(deniedWriteNote("seatbelt", copy, `mv: rename ${copy.home}/tree/project/source to .flywheel/scratch/protected/moved: Operation not permitted`)).toContain("Set cwd");
    const nested = path.join(copy.home, "protected");
    const protectedCopy = { ...copy, git: { kind: "repository" as const, gitDir: nested, commonDir: nested, privateGitDir: "/private/git", workTrees: [nested] } };
    expect(deniedWriteNote("seatbelt", protectedCopy, `touch: ${nested}/a: Operation not permitted`)).toContain(nested);
    expect(deniedWriteNote("mount-namespace", copy, "sh: /work/project/escaped.txt: Read-only file system")).toContain("Set cwd");
    expect(deniedWriteNote("seatbelt", copy, "error: could not lock config file .git/config: Operation not permitted")).toContain(copy.realRoot);
  });
});
