import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { listDefinition } from "../../../../../src/orchestration/agent-runtime/tools/list.js";
import { executePreparedTool, prepareToolCall } from "../../../../../src/orchestration/agent-runtime/tools/tool-dispatch.js";
import { makeContext, pathLines } from "./_fixtures.js";

describe("list tool", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-tools-list-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("lists several directories in order without replacing an existing spaced directory", async () => {
    for (const name of ["src", "tests", "src tests"]) {
      fs.mkdirSync(path.join(tmpDir, name));
      fs.writeFileSync(path.join(tmpDir, name, "a.ts"), name);
    }
    const dispatch = (target: string) => executePreparedTool(
      prepareToolCall({ id: "list", name: "list", input: { path: target } }, new Map([["list", listDefinition]])),
      makeContext({ executionCwd: tmpDir, projectRoot: tmpDir }),
    );
    expect((await dispatch("src tests")).content).toBe("src tests/a.ts");
    const result = await dispatch("tests,src");
    expect(result.outcome).toBe("ok");
    expect(result.content).toBe("[Path 'tests,src' names several paths; listed each in order.]\n### tests\ntests/a.ts\n\n### src\nsrc/a.ts");
    fs.mkdirSync(path.join(tmpDir, "tests,"));
    const ambiguous = await dispatch("tests, src");
    expect(ambiguous.outcome).toBe("error");
    expect(ambiguous.content).toContain("can name different path lists");
  });

  it("returns directories first, then files, with directory suffixes", async () => {
    fs.mkdirSync(path.join(tmpDir, "zeta"));
    fs.mkdirSync(path.join(tmpDir, "alpha"));
    fs.writeFileSync(path.join(tmpDir, "b.txt"), "b");
    fs.writeFileSync(path.join(tmpDir, "a.txt"), "a");

    const result = await listDefinition.execute({ path: "." }, makeContext({ executionCwd: tmpDir }));

    expect(result.outcome).toBe("ok");
    expect(pathLines(result.content)).toEqual(["alpha/", "zeta/", "a.txt", "b.txt"]);
  });

  it("discovers matching paths recursively without file contents", async () => {
    fs.mkdirSync(path.join(tmpDir, "src"), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, "tests"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "src", "a.ts"), "SECRET_A");
    fs.writeFileSync(path.join(tmpDir, "src", "b.js"), "SECRET_B");
    fs.writeFileSync(path.join(tmpDir, "tests", "c.ts"), "SECRET_C");

    const result = await listDefinition.execute(
      { path: ".", pattern: "**/*.ts" },
      makeContext({ executionCwd: tmpDir }),
    );

    expect(result.outcome).toBe("ok");
    expect(pathLines(result.content)).toEqual(["src/a.ts", "tests/c.ts"]);
    expect(result.content).not.toContain("SECRET_A");
    expect(result.content).not.toContain("SECRET_C");
  });

  it("lists the nearest existing parent of a missing path inside the execution directory and says so", async () => {
    fs.mkdirSync(path.join(tmpDir, "src", "tui"), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, "web", "tui"), { recursive: true });
    const ctx = makeContext({ executionCwd: tmpDir });

    const widened = await listDefinition.prepareAdmission?.({ path: "src/docs" }, ctx);
    expect(widened?.repair).toEqual({ input: { path: "src" }, notice: "[Path 'src/docs' does not exist; listed its nearest existing parent 'src' instead.]" });
    // Two `tui` directories leave the missing path for execution to refuse.
    expect((await listDefinition.prepareAdmission?.({ path: "tui" }, ctx))?.repair).toBeUndefined();
    expect(await listDefinition.prepareAdmission?.({ path: "../outside-the-root" }, ctx)).toEqual({});
  });

  it("shows paths below a subdirectory root relative to the execution directory", async () => {
    fs.mkdirSync(path.join(tmpDir, "src", "tui", "hooks"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "src", "tui", "app.ts"), "a");
    const ctx = makeContext({ executionCwd: tmpDir });

    expect(pathLines((await listDefinition.execute({ path: "src/tui" }, ctx)).content)).toEqual(["src/tui/hooks/", "src/tui/app.ts"]);
    expect(pathLines((await listDefinition.execute({ path: "src", pattern: "**/*.ts" }, ctx)).content)).toEqual(["src/tui/app.ts"]);
  });

  it("filters include modes", async () => {
    fs.mkdirSync(path.join(tmpDir, "dir"));
    fs.writeFileSync(path.join(tmpDir, "file.txt"), "file");

    const ctx = makeContext({ executionCwd: tmpDir });
    const all = await listDefinition.execute({ path: ".", include: "all" }, ctx);
    const files = await listDefinition.execute({ path: ".", include: "files" }, ctx);
    const directories = await listDefinition.execute({ path: ".", include: "directories" }, ctx);

    expect(pathLines(all.content)).toEqual(["dir/", "file.txt"]);
    expect(pathLines(files.content)).toEqual(["file.txt"]);
    expect(pathLines(directories.content)).toEqual(["dir/"]);
    for (const include of ["directories,files", "files directories", "directories, files"]) {
      const call = prepareToolCall({ id: "list", name: "list", input: { path: ".", include } }, new Map([["list", listDefinition]]));
      const result = await executePreparedTool(call, ctx);
      expect(result.outcome).toBe("ok");
      expect(result.content).toBe(`Note: include '${include}' was read as 'all'.\ndir/\nfile.txt`);
    }
  });

  it("includes hidden paths by default and excludes them when hidden is false", async () => {
    fs.mkdirSync(path.join(tmpDir, ".config"));
    fs.writeFileSync(path.join(tmpDir, ".env"), "secret");
    fs.writeFileSync(path.join(tmpDir, "visible.txt"), "visible");

    const ctx = makeContext({ executionCwd: tmpDir });
    const defaultResult = await listDefinition.execute({ path: "." }, ctx);
    const hiddenFalse = await listDefinition.execute({ path: ".", hidden: false }, ctx);

    expect(pathLines(defaultResult.content)).toEqual([".config/", ".env", "visible.txt"]);
    expect(pathLines(hiddenFalse.content)).toEqual(["visible.txt"]);
  });

  it("includes ignored paths by default and excludes them when respect_gitignore is true", async () => {
    fs.writeFileSync(path.join(tmpDir, ".gitignore"), "ignored/\n*.log\n");
    fs.mkdirSync(path.join(tmpDir, "ignored"));
    fs.writeFileSync(path.join(tmpDir, "debug.log"), "debug");
    fs.writeFileSync(path.join(tmpDir, "kept.txt"), "kept");

    const ctx = makeContext({ executionCwd: tmpDir });
    const defaultResult = await listDefinition.execute({ path: "." }, ctx);
    const respected = await listDefinition.execute({ path: ".", respect_gitignore: true }, ctx);

    expect(pathLines(defaultResult.content)).toContain("ignored/");
    expect(pathLines(defaultResult.content)).toContain("debug.log");
    expect(pathLines(respected.content)).not.toContain("ignored/");
    expect(pathLines(respected.content)).not.toContain("debug.log");
    expect(pathLines(respected.content)).toContain("kept.txt");
  });

  it("lists artifact and git-ignored directories without entering them unless the path names one", async () => {
    fs.mkdirSync(path.join(tmpDir, ".git"));
    fs.writeFileSync(path.join(tmpDir, ".gitignore"), "results/\n");
    for (const directory of ["results", "node_modules", "src"]) {
      fs.mkdirSync(path.join(tmpDir, directory));
      fs.writeFileSync(path.join(tmpDir, directory, "inner.txt"), directory);
    }

    const ctx = makeContext({ executionCwd: tmpDir });
    const deep = await listDefinition.execute({ path: ".", depth: 2 }, ctx);
    expect(pathLines(deep.content)).toEqual([".git/", "node_modules/", "results/", "src/", ".gitignore", "src/inner.txt"]);
    expect(deep.content).toContain("[Did not enter 3 artifact or ignored directories: .git/, node_modules/, results/; name one in 'path' to look inside it.]");
    // At depth 1 nothing below a directory is in reach, so nothing was skipped.
    expect((await listDefinition.execute({ path: "." }, ctx)).content).not.toContain("Did not enter");
    expect(pathLines((await listDefinition.execute({ path: "results" }, ctx)).content)).toEqual(["results/inner.txt"]);
  });

  it("applies shallow and recursive depth defaults and clamps recursive depth", async () => {
    const writeNested = (relativeFile: string): void => {
      const filePath = path.join(tmpDir, relativeFile);
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, "x");
    };
    writeNested("one/two/three/four/five/six/seven/file.ts");
    writeNested("one/two/three/four/five/six/seven/eight/file.ts");
    writeNested("one/two/three/four/five/six/seven/eight/nine/ten/eleven/file.ts");
    writeNested("one/two/three/four/five/six/seven/eight/nine/ten/eleven/twelve/file.ts");

    const ctx = makeContext({ executionCwd: tmpDir });
    const shallow = await listDefinition.execute({ path: "." }, ctx);
    const recursiveDefault = await listDefinition.execute({ path: ".", pattern: "**/*.ts" }, ctx);
    const clamped = await listDefinition.execute({ path: ".", pattern: "**/*.ts", depth: 99 }, ctx);

    expect(pathLines(shallow.content)).toEqual(["one/"]);
    expect(pathLines(recursiveDefault.content)).toContain("one/two/three/four/five/six/seven/file.ts");
    expect(pathLines(recursiveDefault.content)).not.toContain("one/two/three/four/five/six/seven/eight/file.ts");
    expect(pathLines(clamped.content)).toContain("one/two/three/four/five/six/seven/eight/nine/ten/eleven/file.ts");
    expect(pathLines(clamped.content)).not.toContain("one/two/three/four/five/six/seven/eight/nine/ten/eleven/twelve/file.ts");
  });

  it("paginates stably with continuation guidance", async () => {
    for (const name of ["a.txt", "b.txt", "c.txt", "d.txt", "e.txt"]) {
      fs.writeFileSync(path.join(tmpDir, name), name);
    }

    const result = await listDefinition.execute(
      { path: ".", limit: 2, offset: 1 },
      makeContext({ executionCwd: tmpDir }),
    );

    expect(pathLines(result.content)).toEqual(["b.txt", "c.txt"]);
    expect(result.content).toContain("Results truncated");
    expect(result.content).toContain("offset=3");
  });

  it("sorts newest-first with sort mtime and paginates coherently (ls -lat | head analogue)", async () => {
    const times: Array<[string, Date]> = [
      ["old.txt", new Date("2020-01-01T00:00:00Z")],
      ["mid.txt", new Date("2021-01-01T00:00:00Z")],
      ["new.txt", new Date("2022-01-01T00:00:00Z")],
    ];
    for (const [name, time] of times) {
      const filePath = path.join(tmpDir, name);
      fs.writeFileSync(filePath, name);
      fs.utimesSync(filePath, time, time);
    }

    const ctx = makeContext({ executionCwd: tmpDir });
    const sorted = await listDefinition.execute({ path: ".", sort: "mtime" }, ctx);
    expect(pathLines(sorted.content)).toEqual(["new.txt", "mid.txt", "old.txt"]);

    const newest = await listDefinition.execute({ path: ".", sort: "mtime", limit: 1 }, ctx);
    expect(pathLines(newest.content)).toEqual(["new.txt"]);
    expect(newest.content).toContain("Results truncated");

    // Pagination happens after the sort, so offsets stay coherent.
    const second = await listDefinition.execute({ path: ".", sort: "mtime", limit: 1, offset: 1 }, ctx);
    expect(pathLines(second.content)).toEqual(["mid.txt"]);
  });

  it("rejects invalid sort values", async () => {
    fs.writeFileSync(path.join(tmpDir, "a.txt"), "a");
    const result = await listDefinition.execute({ path: ".", sort: "size" }, makeContext({ executionCwd: tmpDir }));
    expect(result.outcome).toBe("error");
    expect(result.content).toContain("sort must be one of: name, mtime.");
  });

  it("follows linked directories and preserves each logical alias", async () => {
    const externalDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-list-outside-"));
    try {
      fs.writeFileSync(path.join(externalDir, "outside.txt"), "outside");
      const linkType = process.platform === "win32" ? "junction" : "dir";
      fs.symlinkSync(externalDir, path.join(tmpDir, "external-link"), linkType);
      fs.symlinkSync(externalDir, path.join(tmpDir, "second-link"), linkType);

      const result = await listDefinition.execute(
        { path: ".", depth: 2 },
        makeContext({ executionCwd: tmpDir }),
      );

      expect(result.outcome).toBe("ok");
      if (typeof result.content !== "string") throw new Error("expected string content");
      expect(pathLines(result.content)).toEqual(expect.arrayContaining([
        "external-link/",
        "external-link/outside.txt",
        "second-link/",
        "second-link/outside.txt",
      ]));
    } finally {
      fs.rmSync(externalDir, { recursive: true, force: true });
    }
  });
  it("lists linked regular files without traversing their targets", async () => {
    if (process.platform === "win32") return;
    const target = path.join(tmpDir, "target.txt");
    fs.writeFileSync(target, "needle");
    fs.symlinkSync(target, path.join(tmpDir, "file-link"), "file");
    const result = await listDefinition.execute(
      { path: ".", depth: 2 },
      makeContext({ executionCwd: tmpDir }),
    );
    expect(result.content).toContain("file-link");
    expect(result.content).not.toContain("file-link/");
  });

  it("rejects credential roots below a linked ancestor but permits an explicit credential root", async () => {
    const linkedParent = fs.mkdtempSync(path.join(os.tmpdir(), "agent-list-protected-"));
    const protectedRoot = path.join(linkedParent, "auth");
    try {
      fs.mkdirSync(protectedRoot);
      fs.writeFileSync(path.join(linkedParent, "public.txt"), "public");
      fs.writeFileSync(path.join(protectedRoot, "secret.txt"), "secret");
      const nestedProtectedRoot = path.join(protectedRoot, "nested");
      fs.mkdirSync(nestedProtectedRoot);
      fs.writeFileSync(path.join(nestedProtectedRoot, "nested-secret.txt"), "nested secret");
      const linkType = process.platform === "win32" ? "junction" : "dir";
      const alias = path.join(tmpDir, "home-link");
      fs.symlinkSync(linkedParent, alias, linkType);
      const context = makeContext({ executionCwd: tmpDir, protectedTraversalRoots: [fs.realpathSync.native(protectedRoot)] });
      const discovered = await listDefinition.execute({ path: ".", depth: 3 }, context);
      expect(discovered.content).toContain("home-link/public.txt");
      expect(discovered.content).not.toContain("home-link/auth/secret.txt");
      expect(discovered.content).not.toContain("home-link/auth/nested/nested-secret.txt");
      expect(discovered.content).toContain("linked directory branch");
      const explicit = await listDefinition.execute({ path: "home-link/auth", depth: 2 }, context);
      expect(explicit.content).toContain("secret.txt");
      expect(explicit.content).toContain("nested/nested-secret.txt");
    } finally {
      fs.rmSync(linkedParent, { recursive: true, force: true });
    }
  });

  it("tells the model to use read when called on a file path", async () => {
    fs.writeFileSync(path.join(tmpDir, "file.txt"), "contents");

    const result = await listDefinition.execute(
      { path: "file.txt" },
      makeContext({ executionCwd: tmpDir }),
    );

    expect(result.outcome).toBe("error");
    expect(result.content).toContain("not a directory");
  });

  it("rejects a non-positive depth instead of forwarding nonsense to the native walk", async () => {
    fs.writeFileSync(path.join(tmpDir, "a.txt"), "a");
    const result = await listDefinition.execute(
      { path: ".", pattern: "**/*.txt", depth: 0 },
      makeContext({ executionCwd: tmpDir }),
    );
    expect(result.outcome).toBe("error");
    expect(result.content).toContain("depth must be at least 1");
  });

  it("rejects a zero limit and a negative offset", async () => {
    fs.writeFileSync(path.join(tmpDir, "a.txt"), "a");
    const ctx = makeContext({ executionCwd: tmpDir });

    const zeroLimit = await listDefinition.execute({ path: ".", limit: 0 }, ctx);
    expect(zeroLimit.outcome).toBe("error");
    expect(zeroLimit.content).toContain("limit must be at least 1");

    const negativeOffset = await listDefinition.execute({ path: ".", offset: -1 }, ctx);
    expect(negativeOffset.outcome).toBe("error");
    expect(negativeOffset.content).toContain("offset must be at least 0");
  });
});
