import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { healMissingPathInput, missingPathHint, prepareReadOnlyPathInput, resolveToolPath, sessionPathInput } from "../../../../../src/orchestration/agent-runtime/tools/tool-paths.js";
import * as ripgrep from "../../../../../src/orchestration/agent-runtime/tools/ripgrep.js";
import type { ToolAdmissionContext } from "../../../../../src/orchestration/agent-runtime/tools/types.js";

describe("resolveToolPath", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tool-paths-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("unescapes other shell metacharacters in dragged paths", () => {
    const real = path.join(tmpDir, "report (final) [v2].txt");
    fs.writeFileSync(real, "x");
    const dragged = path.join(tmpDir, "report\\ \\(final\\)\\ \\[v2\\].txt");
    expect(resolveToolPath(tmpDir, dragged)).toBe(real);
  });

  // A backslash is a path separator on Windows, so no file there can carry one
  // in its name and this premise cannot be staged.
  it.skipIf(process.platform === "win32")("leaves a legitimately backslashed filename untouched when it exists", () => {
    const literal = path.join(tmpDir, "weird\\ name.txt");
    fs.writeFileSync(literal, "x");
    expect(resolveToolPath(tmpDir, literal)).toBe(path.resolve(literal));
  });

  it("returns the literal resolution when neither variant exists", () => {
    const missing = path.join(tmpDir, "nope\\ here.txt");
    expect(resolveToolPath(tmpDir, missing)).toBe(path.resolve(missing));
  });

  it("reads a leading tilde as the home directory unless the path exists as written", () => {
    expect(resolveToolPath(tmpDir, "~")).toBe(os.homedir());
    expect(resolveToolPath(tmpDir, "~/file.txt")).toBe(path.join(os.homedir(), "file.txt"));
    expect(resolveToolPath(tmpDir, "~//file.txt")).toBe(path.join(os.homedir(), "file.txt"));
    fs.writeFileSync(path.join(tmpDir, "file.txt"), "beside a missing ~");
    expect(resolveToolPath(tmpDir, "~/../file.txt")).toBe(path.resolve(os.homedir(), "..", "file.txt"));
    fs.mkdirSync(path.join(tmpDir, "~"));
    fs.writeFileSync(path.join(tmpDir, "~", "file.txt"), "not home");
    expect(resolveToolPath(tmpDir, "~")).toBe(path.join(tmpDir, "~"));
    expect(resolveToolPath(tmpDir, "~/file.txt")).toBe(path.join(tmpDir, "~", "file.txt"));
  });

  it("recovers a unique Unicode space separator in an existing path", () => {
    const real = path.join(tmpDir, "Screenshot 2026-09-22 at 12.24.53\u202FPM.png");
    fs.writeFileSync(real, "img");

    expect(resolveToolPath(tmpDir, path.join(tmpDir, "Screenshot 2026-09-22 at 12.24.53 PM.png"))).toBe(real);
  });

  it("recovers Unicode space separators in directory segments", () => {
    const directory = path.join(tmpDir, "Visual\u202FAssets");
    fs.mkdirSync(directory);
    const real = path.join(directory, "shot.png");
    fs.writeFileSync(real, "img");

    expect(resolveToolPath(tmpDir, path.join(tmpDir, "Visual Assets", "shot.png"))).toBe(real);
  });

  it("does not choose between ambiguous Unicode space equivalents", () => {
    fs.writeFileSync(path.join(tmpDir, "shot\u202Fone.png"), "narrow");
    fs.writeFileSync(path.join(tmpDir, "shot\u00A0one.png"), "no-break");
    const requested = path.join(tmpDir, "shot one.png");

    expect(resolveToolPath(tmpDir, requested)).toBe(requested);
  });
});

describe("healMissingPathInput", () => {
  let root: string;

  function file(relativePath: string): void {
    const full = path.join(root, relativePath);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, "x");
  }

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "tool-paths-heal-"));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("re-roots a path that is missing one leading directory", async () => {
    file("src/tui/app.ts");

    expect(await healMissingPathInput({ path: "tui" }, { executionCwd: root }, "directory")).toEqual({
      repair: { input: { path: "src/tui" }, notice: "[Path 'tui' does not exist; showing 'src/tui' instead.]" },
    });
  });

  it("finds the one file with the requested name under the nearest existing parent and keeps a selector suffix", async () => {
    file("src/tools/read/read.ts");

    const split = (raw: string) => ({ path: raw.replace(/:\d+-\d+$/, ""), suffix: raw.match(/:\d+-\d+$/)?.[0] ?? "" });
    const result = await healMissingPathInput({ path: "src/tools/read.ts:5-9", limit: 3 }, { executionCwd: root }, "file", split);

    expect(result.repair?.input).toEqual({ path: "src/tools/read/read.ts:5-9", limit: 3 });
  });

  it("does not heal an existing path or a path of the wrong kind", async () => {
    file("src/tui/app.ts");

    expect(await healMissingPathInput({ path: "src/tui" }, { executionCwd: root }, "directory")).toEqual({});
    expect(await healMissingPathInput({ path: "tui" }, { executionCwd: root }, "file")).toEqual({});
  });

  it("expands home paths with a note and never recovers a tilde path inside the project", async () => {
    file("fixtures/flywheel.toml");
    const scope = { executionCwd: root, projectRoot: root };
    const requested = `~/${path.relative(os.homedir(), path.join(root, "fixtures/flywheel.toml")).split(path.sep).join("/")}`;
    const healed = await healMissingPathInput({ path: requested }, scope, "file");
    expect(healed.repair?.input.path).toBe(path.join(root, "fixtures/flywheel.toml"));
    expect(healed.repair?.notice).toContain("home directory");
    const missing = await healMissingPathInput({ path: `~/${path.basename(root)}/flywheel.toml` }, scope, "file");
    expect(missing.repair?.input.path).toBe(path.join(os.homedir(), path.basename(root), "flywheel.toml"));
    expect(await healMissingPathInput({ path: "~somebody/flywheel.toml" }, scope, "file")).toEqual({});
    expect(sessionPathInput({ path: "~/new.txt" }, scope, "new-file").repair?.input.path).toBe(path.join(os.homedir(), "new.txt"));
  });

  it("never chooses between two fits and names both in the miss hint", async () => {
    file("src/tui/app.ts");
    file("web/tui/app.ts");

    expect(await healMissingPathInput({ path: "tui" }, { executionCwd: root }, "directory")).toEqual({ ambiguous: true });
    expect(await missingPathHint({ executionCwd: root }, path.join(root, "tui"), "directory")).toBe("\nDid you mean one of these existing paths? src/tui/, web/tui/");
  });

  it("takes heal targets only from gitignore-aware walks", async () => {
    file("src/tui/app.ts");
    file("out/tui/app.ts");
    file("src/generated/report.txt");
    file("web/generated/report.txt");
    file("src/ignored.tsx");
    fs.writeFileSync(path.join(root, ".gitignore"), "out/\nsrc/generated/\nsrc/ignored.tsx\n");

    expect((await healMissingPathInput({ path: "tui" }, { executionCwd: root }, "directory")).repair?.input).toEqual({ path: "src/tui" });
    expect((await healMissingPathInput({ path: "generated/report.txt" }, { executionCwd: root }, "file")).repair?.input).toEqual({ path: "web/generated/report.txt" });
    expect((await healMissingPathInput({ path: "src/ignored.ts" }, { executionCwd: root }, "file")).repair).toBeUndefined();
  });

  it("never heals to or suggests a path whose link leads outside the execution directory", async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "tool-paths-outside-"));
    try {
      fs.writeFileSync(path.join(outside, "far.txt"), "x");
      fs.mkdirSync(path.join(root, "src"));
      fs.symlinkSync(outside, path.join(root, "src", "link"), "junction");

      expect(await healMissingPathInput({ path: "src/far.txt" }, { executionCwd: root }, "file")).toEqual({});
      expect(await missingPathHint({ executionCwd: root }, path.join(root, "src/far.txt"), "file")).toBe("");
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it("matches a requested name that contains glob syntax literally", async () => {
    file("src/drafts/report{v2.txt");
    file("src/drafts/reportXv2.txt");

    expect((await healMissingPathInput({ path: "src/report{v2.txt" }, { executionCwd: root }, "file")).repair?.input).toEqual({ path: "src/drafts/report{v2.txt" });
  });

  it("heals the requested name with one other extension, but never chooses between siblings", async () => {
    file("src/app.tsx");
    file("src/app.test.ts");
    file("lib/app.js");
    file(`${Array.from({ length: 13 }, (_, index) => `deep${index}`).join("/")}/unrelated.txt`);

    expect((await healMissingPathInput({ path: "src/app.ts" }, { executionCwd: root }, "file")).repair?.input).toEqual({ path: "src/app.tsx" });
    expect(await missingPathHint({ executionCwd: root }, path.join(root, "src/app.ts"), "file")).toBe("\nDid you mean src/app.tsx?");
    const listFiles = ripgrep.listFiles;
    const lookup = spyOn(ripgrep, "listFiles").mockImplementation(options => options.pattern === "**/app.ts"
      ? Promise.resolve({ entries: [], truncated: true, nextOffset: 0, limit: 1000, traversalIssues: 0, entryLimitReached: false })
      : listFiles(options));
    try {
      expect(await healMissingPathInput({ path: "src/app.ts" }, { executionCwd: root }, "file")).toEqual({ ambiguous: true });
    } finally {
      lookup.mockRestore();
    }
    const deepMatch = `${Array.from({ length: 13 }, (_, index) => `deep${index}`).join("/")}/app.ts`;
    file(deepMatch);
    expect(await healMissingPathInput({ path: "src/app.ts" }, { executionCwd: root }, "file")).toEqual({ ambiguous: true });
    expect(await missingPathHint({ executionCwd: root }, path.join(root, "src/app.ts"), "file")).toContain(deepMatch);
    file("src/app.js");
    expect((await healMissingPathInput({ path: "src/app.ts" }, { executionCwd: root }, "file")).repair).toBeUndefined();
    const hint = await missingPathHint({ executionCwd: root }, path.join(root, "src/app.ts"), "file");
    expect(hint).toContain("src/app.js");
    expect(hint).toContain("src/app.tsx");
  });

  it("finds a unique basename anywhere in the execution directory and refuses duplicates", async () => {
    file("src/orchestration/modules/workflows/cli/verify.ts");
    expect((await healMissingPathInput({ path: "src/workflows/cli/verify.ts" }, { executionCwd: root }, "file")).repair?.input).toEqual({ path: "src/orchestration/modules/workflows/cli/verify.ts" });
    file(`${Array.from({ length: 13 }, (_, index) => `deep${index}`).join("/")}/verify.ts`);
    expect((await healMissingPathInput({ path: "src/workflows/cli/verify.ts" }, { executionCwd: root }, "file")).repair).toBeUndefined();
    file("tests/verify.ts");
    expect((await healMissingPathInput({ path: "src/workflows/cli/verify.ts" }, { executionCwd: root }, "file")).repair).toBeUndefined();
    expect(await missingPathHint({ executionCwd: root }, path.join(root, "src/workflows/cli/verify.ts"), "file")).toContain("tests/verify.ts");
  });

  it("recovers project-relative paths from a worktree without following links outside the project or into protected roots", async () => {
    const cwd = path.join(root, "worktree");
    fs.mkdirSync(cwd);
    file(".flywheel/sessions/other/scratch/brief.md");
    const scope = { executionCwd: cwd, projectRoot: root };
    const requested = ".flywheel/sessions/other/scratch/brief.md";
    const target = path.join(root, requested);
    const healed = await healMissingPathInput({ path: requested }, scope, "file");
    expect(healed.repair?.input).toEqual({ path: target });
    expect(healed.repair?.notice).toContain("project root");
    expect(await healMissingPathInput({ path: requested }, { ...scope, protectedTraversalRoots: [fs.realpathSync(path.dirname(target))] }, "file")).toEqual({});
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "tool-paths-project-outside-"));
    try {
      fs.writeFileSync(path.join(outside, "secret.md"), "hidden");
      fs.symlinkSync(outside, path.join(root, "linked"), "junction");
      expect(await healMissingPathInput({ path: "linked/secret.md" }, scope, "file")).toEqual({});
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it("refuses competing project-root and local extension recoveries", async () => {
    file("src/widget.tsx");
    file("worktree/src/widget.ts");
    const scope = { executionCwd: path.join(root, "worktree"), projectRoot: root };
    await expect(healMissingPathInput({ path: "src/widget.tsx" }, scope, "file")).rejects.toThrow("src/widget.ts");
    await expect(healMissingPathInput({ path: "src/widget.tsx" }, scope, "file")).rejects.toThrow(path.join(root, "src/widget.tsx"));
  });

  it("refuses competing literal project or session paths and local path lists", async () => {
    file("a.txt b.txt");
    file("worktree/a.txt");
    file("worktree/b.txt");
    const scope = { executionCwd: path.join(root, "worktree"), projectRoot: root };
    await expect(prepareReadOnlyPathInput({ path: "a.txt b.txt" }, scope, "file", "read")).rejects.toThrow(path.join(root, "a.txt b.txt"));
    await expect(prepareReadOnlyPathInput({ path: "a.txt b.txt" }, scope, "file", "read")).rejects.toThrow("'a.txt', 'b.txt'");
    fs.renameSync(path.join(root, "a.txt b.txt"), path.join(root, "a.txt\u00A0b.txt"));
    const batch = await prepareReadOnlyPathInput({ path: "a.txt b.txt" }, scope, "file", "read");
    expect(batch.repair?.input.path).toEqual(["a.txt", "b.txt"]);
    const scratchDir = path.join(root, ".flywheel/sessions/one/scratch");
    file(".flywheel/sessions/one/scratch/a.txt scratch/b.txt");
    file("worktree/scratch/a.txt");
    file("worktree/scratch/b.txt");
    await expect(prepareReadOnlyPathInput({ path: "scratch/a.txt scratch/b.txt" }, { ...scope, scratchDir }, "file", "read")).rejects.toThrow(path.join(scratchDir, "a.txt scratch/b.txt"));
  });

  it("starts no batch lookups after cancellation", async () => {
    const abort = new AbortController();
    const lookup = spyOn(ripgrep, "listFiles").mockImplementation(async () => {
      abort.abort();
      return { entries: [], truncated: false, nextOffset: 0, limit: 1000, traversalIssues: 0, entryLimitReached: false };
    });
    try {
      const input = { path: ["missing-one", "missing-two", "missing-three"] };
      await expect(prepareReadOnlyPathInput(input, { executionCwd: root }, "any", "read", undefined, abort.signal)).rejects.toThrow();
      expect(lookup).toHaveBeenCalledTimes(3);
      lookup.mockClear();
      await expect(prepareReadOnlyPathInput(input, { executionCwd: root }, "any", "read", undefined, abort.signal)).rejects.toThrow();
      expect(lookup).not.toHaveBeenCalled();
    } finally {
      lookup.mockRestore();
    }
  });

  it("suggests, without healing, a path outside the execution directory rebased under it", async () => {
    const cwd = path.join(root, "project");
    file("project/src/a.ts");

    expect(await healMissingPathInput({ path: path.join(root, "src/a.ts") }, { executionCwd: cwd }, "file")).toEqual({});
    expect(await missingPathHint({ executionCwd: cwd }, path.join(root, "src/a.ts"), "file")).toBe("\nDid you mean src/a.ts?");
    expect(await missingPathHint({ executionCwd: cwd }, path.join(root, "src/b.ts"), "file")).toBe("");
  });

  it("suggests siblings that share a name word when nothing fits", async () => {
    file("src/session-store.ts");
    file("src/unrelated.ts");

    expect(await healMissingPathInput({ path: "src/store.ts" }, { executionCwd: root }, "file")).toEqual({});
    expect(await missingPathHint({ executionCwd: root }, path.join(root, "src/store.ts"), "file")).toBe("\nDid you mean src/session-store.ts?");
  });
});

describe("session-relative paths", () => {
  let project: string;
  let sessionDir: string;
  let scope: ToolAdmissionContext;

  function file(directory: string, relativePath: string): void {
    const full = path.join(directory, relativePath);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, "x");
  }

  beforeEach(() => {
    project = fs.mkdtempSync(path.join(os.tmpdir(), "tool-paths-session-"));
    sessionDir = path.join(project, ".flywheel", "sessions", "s1");
    fs.mkdirSync(sessionDir, { recursive: true });
    scope = { executionCwd: project, scratchDir: path.join(sessionDir, "scratch") };
  });

  afterEach(() => {
    fs.rmSync(project, { recursive: true, force: true });
  });

  it("heals a read of a scratch path that exists only in the session directory and keeps a selector suffix", async () => {
    file(sessionDir, "scratch/workflows/review.workflow.yaml");
    const sessionFile = path.join(sessionDir, "scratch", "workflows", "review.workflow.yaml");
    const split = (raw: string) => ({ path: raw.replace(/:\d+-\d+$/, ""), suffix: raw.match(/:\d+-\d+$/)?.[0] ?? "" });

    expect(await healMissingPathInput({ path: "scratch/workflows/review.workflow.yaml:1-5" }, scope, "file", split)).toEqual({
      repair: {
        input: { path: `${sessionFile}:1-5` },
        notice: `[Path 'scratch/workflows/review.workflow.yaml' does not exist in the execution directory; using '${sessionFile}' in the session directory instead.]`,
      },
    });
  });

  it("keeps a path that exists in the project, and never heals into the session without a scratch directory in context", async () => {
    file(project, "scratch/workflows/review.workflow.yaml");
    file(sessionDir, "scratch/workflows/review.workflow.yaml");
    file(sessionDir, "scratch/notes/plan.md");

    expect(await healMissingPathInput({ path: "scratch/workflows/review.workflow.yaml" }, scope, "file")).toEqual({});
    expect(await healMissingPathInput({ path: "scratch/notes/plan.md" }, { executionCwd: project }, "file")).toEqual({});
  });

  it("places a new file in session scratch only when the project has no scratch entry", () => {
    const repaired = sessionPathInput({ path: "scratch/workflows/draft.workflow.yaml", content: "x" }, scope, "new-file");
    expect(repaired.repair?.input).toEqual({ path: path.join(sessionDir, "scratch", "workflows", "draft.workflow.yaml"), content: "x" });

    fs.mkdirSync(path.join(project, "scratch"));
    expect(sessionPathInput({ path: "scratch/workflows/draft.workflow.yaml", content: "x" }, scope, "new-file")).toEqual({});
  });

  it("leaves absolute paths and paths outside scratch alone", () => {
    file(sessionDir, "scratch/a.txt");
    file(sessionDir, "notes.txt");

    expect(sessionPathInput({ path: path.join(sessionDir, "scratch", "a.txt") }, scope, "file")).toEqual({});
    expect(sessionPathInput({ path: "notes.txt" }, scope, "file")).toEqual({});
    expect(sessionPathInput({ path: "scratch/../notes.txt" }, scope, "file")).toEqual({});
  });
});
