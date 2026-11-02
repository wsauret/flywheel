import { describe, test, expect, beforeEach, afterEach, spyOn } from "bun:test";
import * as fs from "node:fs";
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { chmod, mkdtemp, writeFile, mkdir, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadAgentInstructions } from "../../../../src/orchestration/agent-runtime/project-instructions.js";
import { globalAgentsFile } from "../../../../src/infra/paths.js";
import { Log } from "../../../../src/infra/log.js";
import type { OwnedCommandRunner } from "../../../../src/infra/owned-command.js";

/** The temp directory each case owns. It is both the project root and the
 *  account home, so `~/.agents/AGENTS.md` lives inside the case's own tree. */
let root: string;
let globalAgentsPath: string;

function loadInstructions(executionCwd: string, projectRoot: string = root): string | undefined {
  return loadAgentInstructions({
    executionCwd,
    projectRoot,
    accountHome: root,
    userDataRoot: join(root, ".flywheel-user"),
  });
}

/** Whether `agents.md` and `AGENTS.md` can name two files here. */
const caseSensitiveFileSystem = (() => {
  const probe = mkdtempSync(join(tmpdir(), "proj-instr-case-"));
  try {
    writeFileSync(join(probe, "case"), "");
    return !existsSync(join(probe, "CASE"));
  } finally {
    rmSync(probe, { recursive: true, force: true });
  }
})();

function unreadableSection(path: string, reason: string): string {
  return repositorySection(path, `[UNREADABLE: ${reason}. These instructions are unavailable until the file is repaired; tell the person when it matters.]`);
}

function globalSection(content: string): string {
  return `## User-global instructions (~/.agents/AGENTS.md)\n\n${content}`;
}

function repositorySection(path: string, content: string): string {
  return `## Repository instructions (${path})\n\n${content}`;
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "proj-instr-"));
  await mkdir(join(root, ".git"));
  globalAgentsPath = globalAgentsFile(root);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("global rules", () => {
  test("loads global rules before root and child rules with source labels", async () => {
    const child = join(root, "sub");
    await mkdir(join(root, ".agents"));
    await mkdir(child);
    await writeFile(globalAgentsPath, "global rules");
    await writeFile(join(root, "AGENTS.md"), "root rules");
    await writeFile(join(child, "AGENTS.md"), "child rules");

    const result = loadInstructions(child);

    expect(result).toBe([
      globalSection("global rules"),
      repositorySection("AGENTS.md", "root rules"),
      repositorySection("sub/AGENTS.md", "child rules"),
    ].join("\n\n---\n\n"));
  });
});

describe("safe file loading", () => {
  test("follows a symlinked global instruction file", async () => {
    await mkdir(join(root, ".agents"));
    await writeFile(join(root, "shared-global.md"), "global symlink content");
    await symlink(join(root, "shared-global.md"), globalAgentsPath);

    expect(loadInstructions(root)).toBe(globalSection("global symlink content"));
  });

  test("follows a symlinked repository instruction file", async () => {
    await writeFile(join(root, "shared-project.md"), "project symlink content");
    await symlink(join(root, "shared-project.md"), join(root, "AGENTS.md"));

    expect(loadInstructions(root)).toBe(repositorySection("AGENTS.md", "project symlink content"));
  });

  test("rejects a project instruction symlink into the account home", async () => {
    const home = await mkdtemp(join(tmpdir(), "proj-instr-home-"));
    await mkdir(join(home, ".aws"), { recursive: true });
    await writeFile(join(home, ".aws", "credentials"), "AWS_SECRET_ACCESS_KEY=secret");
    await symlink(join(home, ".aws", "credentials"), join(root, "AGENTS.md"));

    const result = loadAgentInstructions({
      executionCwd: root,
      projectRoot: root,
      accountHome: home,
      userDataRoot: join(home, ".flywheel"),
    });

    expect(result).toBeUndefined();
    await rm(home, { recursive: true, force: true });
  });

  test("rejects a project import alias whose canonical target is a dotenv file", async () => {
    const home = await mkdtemp(join(tmpdir(), "proj-instr-home-"));
    await writeFile(join(home, ".env"), "SECRET_VALUE");
    await symlink(join(home, ".env"), join(root, "shared-rules.md"));
    await writeFile(join(root, "AGENTS.md"), "See @shared-rules.md");

    const result = loadAgentInstructions({
      executionCwd: root,
      projectRoot: root,
      accountHome: home,
      userDataRoot: join(home, ".flywheel"),
    });

    expect(result).not.toContain("SECRET_VALUE");
    await rm(home, { recursive: true, force: true });
  });

  test("keeps an @-mention inside a code fence literal", async () => {
    await writeFile(join(root, ".env"), "SECRET_VALUE");
    await writeFile(join(root, "AGENTS.md"), "Example:\n\n```\ncat @.env\n```\n\nand inline `@.env` too.");

    const result = loadInstructions(root);

    expect(result).toContain("cat @.env");
    expect(result).not.toContain("SECRET_VALUE");
  });
});

describe("directory walk", () => {
  test("returns undefined when no instruction file exists", async () => {
    expect(loadInstructions(root)).toBeUndefined();
  });

  test("stops at .git boundary", async () => {
    const child = join(root, "pkg");
    await mkdir(child, { recursive: true });
    await writeFile(join(root, "agents.md"), "repo root");
    await writeFile(join(child, "agents.md"), "package");

    const result = loadInstructions(child);
    expect(result).toContain("repo root");
    expect(result).toContain("package");
    expect(result!.split("---")).toHaveLength(2);
  });

  test("an explicit project boundary stops the walk below the enclosing repository", async () => {
    const sandbox = join(root, "sandbox");
    await mkdir(sandbox, { recursive: true });
    await writeFile(join(root, "AGENTS.md"), "outer repository rules");
    await writeFile(join(sandbox, "AGENTS.md"), "sandbox rules");

    const result = loadInstructions(sandbox, sandbox);

    expect(result).toBe(repositorySection("AGENTS.md", "sandbox rules"));
  });

  test("a launch directory outside the project boundary cannot load the enclosing repository", async () => {
    const sandbox = join(root, "sandbox");
    await mkdir(sandbox, { recursive: true });
    await writeFile(join(root, "AGENTS.md"), "outer repository rules");
    await writeFile(join(sandbox, "AGENTS.md"), "sandbox rules");

    const result = loadInstructions(root, sandbox);

    expect(result).toBe(repositorySection("AGENTS.md", "sandbox rules"));
    expect(result).not.toContain("outer repository rules");
  });

  test("collects files from multiple ancestor levels", async () => {
    const a = join(root, "a");
    const b = join(a, "b");
    const c = join(b, "c");
    await mkdir(c, { recursive: true });
    await writeFile(join(root, "agents.md"), "L0");
    await writeFile(join(b, "agents.md"), "L2");
    await writeFile(join(c, "AGENTS.md"), "L3");

    const result = loadInstructions(c);
    expect(result).toContain("L0");
    expect(result).toContain("L2");
    expect(result).toContain("L3");
    expect(result!.indexOf("L0")).toBeLessThan(result!.indexOf("L2"));
    expect(result!.indexOf("L2")).toBeLessThan(result!.indexOf("L3"));
  });

});

describe("complete instruction loading", () => {
  test("keeps the complete root and imported graph when it exceeds 48KB", async () => {
    const imports = Array.from({ length: 8 }, (_, index) => `area-${index + 1}/AGENTS.md`);
    await writeFile(join(root, "AGENTS.md"), ["ROOT RULES " + "r".repeat(15_000), ...imports.map((path) => `@${path}`)].join("\n"));
    for (const [index, path] of imports.entries()) {
      await mkdir(join(root, `area-${index + 1}`), { recursive: true });
      await writeFile(join(root, path), `AREA ${index + 1} ` + String(index + 1).repeat(6_000));
    }

    const result = loadInstructions(root);

    expect(Buffer.byteLength(result!, "utf-8")).toBeGreaterThan(49_152);
    expect(result).toContain("ROOT RULES");
    for (let index = 1; index <= imports.length; index++) expect(result).toContain(`AREA ${index}`);
    expect(result).not.toContain("[AGENTS.md instructions truncated]");
  });

  test("reads one instruction file completely when it exceeds 48KB", async () => {
    const source = "🙂".repeat(20_000);
    await writeFile(join(root, "AGENTS.md"), source);

    const result = loadInstructions(root);

    expect(result).toBe(repositorySection("AGENTS.md", source));
  });
});

describe("@-mention expansion", () => {
  function importedSection(display: string, content: string): string {
    return `## Imported instructions (${display})\n\n${content}`;
  }

  test("inlines a mentioned file as its own labeled section", async () => {
    await writeFile(join(root, "style.md"), "style rules");
    await writeFile(join(root, "AGENTS.md"), "See @style.md for style.");

    const result = loadInstructions(root);

    expect(result).toContain(repositorySection("AGENTS.md", "See @style.md for style."));
    expect(result).toContain(importedSection("style.md", "style rules"));
  });

  test("inlines a file named by its absolute path through a directory whose name starts with an underscore", async () => {
    // On Windows the path reads `...\_shared\style.md`, where Markdown sees an escaped underscore.
    await mkdir(join(root, "_shared"));
    await writeFile(join(root, "_shared", "style.md"), "shared style rules");
    await writeFile(join(root, "AGENTS.md"), `See @${join(root, "_shared", "style.md")} for style.`);

    expect(loadInstructions(root)).toContain("shared style rules");
  });

  test("resolves a mention relative to the mentioning file's directory", async () => {
    const child = join(root, "sub");
    await mkdir(child, { recursive: true });
    await writeFile(join(child, "local.md"), "local content");
    await writeFile(join(child, "AGENTS.md"), "Read @./local.md first.");

    const result = loadInstructions(child);

    expect(result).toContain(importedSection("sub/local.md", "local content"));
  });

  test("falls back to the project root for a nested bare mention", async () => {
    await mkdir(join(root, "sub"), { recursive: true });
    await mkdir(join(root, "docs"), { recursive: true });
    await writeFile(join(root, "docs", "guide.md"), "root guide");
    await writeFile(join(root, "sub", "AGENTS.md"), "Read @docs/guide.md");
    await writeFile(join(root, "AGENTS.md"), "Read @sub/AGENTS.md");

    const result = loadInstructions(root);

    expect(result).toContain(importedSection("docs/guide.md", "root guide"));
  });

  test("prefers the importing directory for a nested bare mention", async () => {
    await mkdir(join(root, "sub", "docs"), { recursive: true });
    await mkdir(join(root, "docs"), { recursive: true });
    await writeFile(join(root, "sub", "docs", "guide.md"), "local guide");
    await writeFile(join(root, "docs", "guide.md"), "root guide");
    await writeFile(join(root, "sub", "AGENTS.md"), "Read @docs/guide.md");
    await writeFile(join(root, "AGENTS.md"), "Read @sub/AGENTS.md");

    const result = loadInstructions(root);

    expect(result).toContain("local guide");
    expect(result).not.toContain("root guide");
  });

  test("does not apply the project-root fallback to an explicit relative mention", async () => {
    await mkdir(join(root, "sub"), { recursive: true });
    await mkdir(join(root, "docs"), { recursive: true });
    await writeFile(join(root, "docs", "guide.md"), "root guide");
    await writeFile(join(root, "sub", "AGENTS.md"), "Read @./docs/guide.md");
    await writeFile(join(root, "AGENTS.md"), "Read @sub/AGENTS.md");

    expect(loadInstructions(root)).not.toContain("root guide");
  });

  test.skipIf(process.platform !== "win32")("does not apply the project-root fallback to a Windows explicit relative mention", async () => {
    await mkdir(join(root, "sub"), { recursive: true });
    await mkdir(join(root, "docs"), { recursive: true });
    await writeFile(join(root, "docs", "guide.md"), "root guide");
    await writeFile(join(root, "sub", "AGENTS.md"), "Read @.\\docs\\guide.md");
    await writeFile(join(root, "AGENTS.md"), "Read @sub/AGENTS.md");

    expect(loadInstructions(root)).not.toContain("root guide");
  });

  test("does not apply the project-root fallback to global instructions", async () => {
    await mkdir(join(root, ".agents"), { recursive: true });
    await writeFile(join(root, "guide.md"), "project guide");
    await writeFile(globalAgentsPath, "Read @guide.md");

    expect(loadInstructions(root)).not.toContain("project guide");
  });

  test("expands mentions recursively and includes a cycle only once", async () => {
    await writeFile(join(root, "a.md"), "A content, see @b.md");
    await writeFile(join(root, "b.md"), "B content, see @a.md");
    await writeFile(join(root, "AGENTS.md"), "Start at @a.md");

    const result = loadInstructions(root);

    expect(result!.split("A content").length - 1).toBe(1);
    expect(result!.split("B content").length - 1).toBe(1);
  });

  test("stops expanding beyond the depth limit", async () => {
    for (let level = 1; level <= 6; level++) {
      const next = level < 6 ? ` next @d${level + 1}.md` : "";
      await writeFile(join(root, `d${level}.md`), `depth-${level}${next}`);
    }
    await writeFile(join(root, "AGENTS.md"), "chain @d1.md");

    const result = loadInstructions(root);

    expect(result).toContain("depth-4");
    expect(result).not.toContain("depth-5");
  });

  test("leaves npm scopes and non-path tokens literal", async () => {
    await writeFile(join(root, "AGENTS.md"), "Use @types/react and email me@example.com wait no, ping @alice");

    const result = loadInstructions(root);

    expect(result).toBe(repositorySection("AGENTS.md", "Use @types/react and email me@example.com wait no, ping @alice"));
  });

  test("strips a #fragment before resolving the mention", async () => {
    await writeFile(join(root, "guide.md"), "guide content");
    await writeFile(join(root, "AGENTS.md"), "See @guide.md#setup");

    const result = loadInstructions(root);

    expect(result).toContain(importedSection("guide.md", "guide content"));
  });

  test("skips a mention that resolves outside the project boundary", async () => {
    const outside = `${root}-outside.md`;
    await writeFile(outside, "outside content");
    await writeFile(join(root, "AGENTS.md"), `Read @${outside}`);

    const result = loadInstructions(root);

    expect(result).not.toContain("outside content");
    await rm(outside, { force: true });
  });

  test("a project mention cannot reach the account home outside the project", async () => {
    const home = await mkdtemp(join(tmpdir(), "proj-instr-home-"));
    await writeFile(join(home, "secret.md"), "home secret");
    await writeFile(join(root, "AGENTS.md"), `Read @${join(home, "secret.md")}`);

    const result = loadAgentInstructions({
      executionCwd: root,
      projectRoot: root,
      accountHome: home,
      userDataRoot: join(home, ".flywheel-user"),
    });

    expect(result).not.toContain("home secret");
    await rm(home, { recursive: true, force: true });
  });

  test("the user-global file may mention files inside the account home", async () => {
    const home = await mkdtemp(join(tmpdir(), "proj-instr-home-"));
    await mkdir(join(home, ".agents"), { recursive: true });
    await writeFile(join(home, "prefs.md"), "home prefs");
    await writeFile(globalAgentsFile(home), "Global rules, see @~/prefs.md");

    const result = loadAgentInstructions({
      executionCwd: root,
      projectRoot: root,
      accountHome: home,
      userDataRoot: join(home, ".flywheel-user"),
    });

    expect(result).toContain("home prefs");
    await rm(home, { recursive: true, force: true });
  });

  test("imports a strict UTF-8 file regardless of its extension", async () => {
    await writeFile(join(root, "guidance.custom"), "custom guidance");
    await writeFile(join(root, "AGENTS.md"), "See @guidance.custom");

    const result = loadInstructions(root);

    expect(result).toContain(importedSection("guidance.custom", "custom guidance"));
  });

  test("follows a symlinked mentioned file", async () => {
    await writeFile(join(root, "real.md"), "real target");
    await symlink(join(root, "real.md"), join(root, "link.md"));
    await writeFile(join(root, "AGENTS.md"), "See @link.md");

    const result = loadInstructions(root);

    expect(result).toContain(importedSection("link.md", "real target"));
  });

  test("resolves nested imports from a symlink target's real directory", async () => {
    const external = await mkdtemp(join(tmpdir(), "proj-instr-external-"));
    await writeFile(join(external, "rules.md"), "external rules, see @nested.md");
    await writeFile(join(external, "nested.md"), "nested external rules");
    await symlink(external, join(root, "linked"), process.platform === "win32" ? "junction" : "dir");
    await writeFile(join(root, "AGENTS.md"), "See @linked/rules.md");

    const result = loadInstructions(root);

    expect(result).toContain("external rules");
    expect(result).toContain("nested external rules");
    await rm(external, { recursive: true, force: true });
  });

  test("deduplicates symlink aliases by canonical target", async () => {
    await writeFile(join(root, "shared.md"), "shared imported rules");
    await symlink(join(root, "shared.md"), join(root, "first.md"));
    await symlink(join(root, "shared.md"), join(root, "second.md"));
    await writeFile(join(root, "AGENTS.md"), "See @first.md and @second.md");

    const result = loadInstructions(root);

    expect(result!.split("shared imported rules")).toHaveLength(2);
  });

  test("treats a broken symlink import as a non-fatal omission", async () => {
    await symlink(join(root, "missing-target.md"), join(root, "broken.md"));
    await writeFile(join(root, "AGENTS.md"), "See @broken.md");

    expect(loadInstructions(root)).toBe(repositorySection("AGENTS.md", "See @broken.md"));
  });

  test("rejects a symlink whose canonical target is Flywheel-owned state", async () => {
    const userDataRoot = join(root, ".flywheel-user");
    await mkdir(userDataRoot);
    await writeFile(join(userDataRoot, "secret.md"), "protected secret");
    await symlink(join(userDataRoot, "secret.md"), join(root, "secret-link.md"));
    await writeFile(join(root, "AGENTS.md"), "See @secret-link.md");

    const result = loadAgentInstructions({ executionCwd: root, projectRoot: root, accountHome: root, userDataRoot });

    expect(result).not.toContain("protected secret");
  });

  test("skips a missing mention without failing the load and reports it", async () => {
    await writeFile(join(root, "AGENTS.md"), "See @missing.md");
    const warn = spyOn(Log.create({ service: "project-instructions" }), "warn").mockImplementation(() => {});
    try {
      expect(loadInstructions(root)).toBe(repositorySection("AGENTS.md", "See @missing.md"));
      expect(warn).toHaveBeenCalledWith("AGENTS.md inputs omitted", {
        omissions: [{ path: join(realpathSync(root), "missing.md"), reason: "missing-target" }],
      });
    } finally {
      warn.mockRestore();
    }
  });

  /** Answers `git check-ignore -q -- <path>` as git would for a checkout that
   *  ignores exactly `ignoredPath`; any other command fails as git would. */
  function gitIgnoring(ignoredPath: string): OwnedCommandRunner {
    return async (command) => {
      const asked = command.join(" ");
      const exitCode = asked === `git check-ignore -q -- ${ignoredPath}` ? 0 : asked.startsWith("git check-ignore -q -- ") ? 1 : 128;
      return { exitCode, stdoutBytes: new Uint8Array(), stdout: "", stderr: "", timedOut: false };
    };
  }

  async function loadReported(content: string, runCommand: OwnedCommandRunner): Promise<{ result: string | undefined; warnings: unknown[][] }> {
    await writeFile(join(root, "AGENTS.md"), content);
    const warn = spyOn(Log.create({ service: "project-instructions" }), "warn").mockImplementation(() => {});
    try {
      const result = loadAgentInstructions({ executionCwd: root, projectRoot: root, accountHome: root, userDataRoot: join(root, ".flywheel-user"), runCommand });
      // The ignore check answers after the load returns.
      await Bun.sleep(0);
      return { result, warnings: warn.mock.calls };
    } finally {
      warn.mockRestore();
    }
  }

  test("does not report a missing mention that git ignores", async () => {
    const { result, warnings } = await loadReported("See @private/notes.md", gitIgnoring(join(realpathSync(root), "private", "notes.md")));
    expect(result).toBe(repositorySection("AGENTS.md", "See @private/notes.md"));
    expect(warnings).toEqual([]);
  });

  test("reports a missing mention that git does not ignore or cannot judge", async () => {
    const missing = join(realpathSync(root), "missing.md");
    const omitted = [["AGENTS.md inputs omitted", { omissions: [{ path: missing, reason: "missing-target" }] }]];
    expect((await loadReported("See @missing.md", gitIgnoring(join(root, "other.md")))).warnings).toEqual(omitted);
    expect((await loadReported("See @missing.md", async () => { throw new Error("spawn git ENOENT"); })).warnings).toEqual(omitted);
  });

  test("refuses a dotenv mention in prose", async () => {
    await writeFile(join(root, ".env"), "SECRET_VALUE");
    await writeFile(join(root, ".env.local"), "LOCAL_SECRET");
    await writeFile(join(root, "AGENTS.md"), "Check @.env and @.env.local first.");

    const result = loadInstructions(root);

    expect(result).toContain("Check @.env and @.env.local first.");
    expect(result).not.toContain("SECRET_VALUE");
    expect(result).not.toContain("LOCAL_SECRET");
  });

  test("a project file imported by the global file cannot reach the account home", async () => {
    const home = await mkdtemp(join(tmpdir(), "proj-instr-home-"));
    await mkdir(join(home, ".agents"), { recursive: true });
    await writeFile(join(home, "secret.md"), "home secret");
    await writeFile(join(root, "rules.md"), "project rules, see @~/secret.md");
    await writeFile(globalAgentsFile(home), `Global rules, see @${join(root, "rules.md")}`);

    const result = loadAgentInstructions({
      executionCwd: root,
      projectRoot: root,
      accountHome: home,
      userDataRoot: join(home, ".flywheel-user"),
    });

    expect(result).toContain("project rules");
    expect(result).not.toContain("home secret");
    await rm(home, { recursive: true, force: true });
  });

  test("an unauthorized mention cannot suppress a later authorized import", async () => {
    const home = await mkdtemp(join(tmpdir(), "proj-instr-home-"));
    await mkdir(join(home, ".agents"), { recursive: true });
    await writeFile(join(home, "prefs.md"), "home prefs");
    await writeFile(join(root, "rules.md"), "project rules, see @~/prefs.md");
    await writeFile(globalAgentsFile(home), `First @${join(root, "rules.md")} then @~/prefs.md`);

    const result = loadAgentInstructions({
      executionCwd: root,
      projectRoot: root,
      accountHome: home,
      userDataRoot: join(home, ".flywheel-user"),
    });

    expect(result).toContain("project rules");
    expect(result).toContain("home prefs");
    await rm(home, { recursive: true, force: true });
  });

  test("falls back to the trailing-period-stripped path when the verbatim mention is missing", async () => {
    await writeFile(join(root, "codename.md"), "codename content");
    await writeFile(join(root, "AGENTS.md"), "For the codename, see @codename.md.");

    const result = loadInstructions(root);

    expect(result).toContain(importedSection("codename.md", "codename content"));
  });

  test("the verbatim mention wins over the trailing-period-stripped fallback", async () => {
    await writeFile(join(root, "notes.md"), "plain notes");
    await writeFile(join(root, "notes.md."), "dotted notes");
    await writeFile(join(root, "AGENTS.md"), "See @notes.md.");

    const result = loadInstructions(root);

    expect(result).not.toContain("plain notes");
    expect(result).toContain(importedSection("notes.md.", "dotted notes"));
  });
});

describe("unreadable and shadowed instruction files", () => {
  test.each([
    ["UTF-16LE", Buffer.from("\ufeffrules", "utf16le")],
    ["Latin-1", Buffer.from("caf\u00e9 rules", "latin1")],
  ])("a %s root file renders as an unreadable section instead of failing the load", async (_encoding, bytes) => {
    await writeFile(join(root, "AGENTS.md"), bytes);
    await mkdir(join(root, "pkg"));
    await writeFile(join(root, "pkg", "AGENTS.md"), "package rules");

    expect(loadInstructions(join(root, "pkg"))).toBe([
      unreadableSection("AGENTS.md", "AGENTS.md must contain valid UTF-8 text"),
      repositorySection("pkg/AGENTS.md", "package rules"),
    ].join("\n\n---\n\n"));
  });

  test.skipIf(process.platform === "win32" || process.getuid?.() === 0)("a root file without read permission renders as an unreadable section", async () => {
    await writeFile(join(root, "AGENTS.md"), "secret rules");
    await chmod(join(root, "AGENTS.md"), 0o000);

    expect(loadInstructions(root)).toBe(unreadableSection("AGENTS.md", "AGENTS.md could not be read safely (EACCES)"));
  });

  test("a directory named AGENTS.md renders as an unreadable section and is reported with its logical path", async () => {
    await mkdir(join(root, "AGENTS.md"));
    const warn = spyOn(Log.create({ service: "project-instructions" }), "warn").mockImplementation(() => {});
    try {
      expect(loadInstructions(root)).toBe(unreadableSection("AGENTS.md", "AGENTS.md must resolve to a regular file"));
      expect(warn).toHaveBeenCalledWith("AGENTS.md inputs omitted", {
        omissions: [{ path: join(root, "AGENTS.md"), reason: "unreadable", error: "AGENTS.md must resolve to a regular file" }],
      });
    } finally {
      warn.mockRestore();
    }
  });

  test("two instruction links to one unreadable file render one unreadable section", async () => {
    await writeFile(join(root, "shared.md"), Buffer.from("café rules", "latin1"));
    await mkdir(join(root, "pkg"));
    await symlink(join(root, "shared.md"), join(root, "AGENTS.md"));
    await symlink(join(root, "shared.md"), join(root, "pkg", "AGENTS.md"));

    expect(loadInstructions(join(root, "pkg"))).toBe(unreadableSection("pkg/AGENTS.md", "shared.md must contain valid UTF-8 text"));
  });

  test.each([
    ["is removed", (path: fs.PathLike) => { throw Object.assign(new Error(`ENOENT: ${String(path)}`), { code: "ENOENT" }); }, "AGENTS.md could not be read safely (ENOENT)"],
    ["is replaced", () => join(root, "replacement.md"), "AGENTS.md changed before it could be opened safely"],
  ] as const)("a root file that %s after its identity is authorized renders as an unreadable section without its bytes", async (_change, swap, reason) => {
    await writeFile(join(root, "AGENTS.md"), "authorized rules");
    await writeFile(join(root, "replacement.md"), "replacement rules");
    const realOpen = fs.openSync;
    // The race window: another writer removes or replaces AGENTS.md between
    // the loader's identity check and its open.
    const open = spyOn(fs, "openSync").mockImplementation((path: fs.PathLike, flags: fs.OpenMode, mode?: fs.Mode | null) =>
      realOpen(String(path).endsWith("AGENTS.md") ? swap(path) : path, flags, mode));
    const warn = spyOn(Log.create({ service: "project-instructions" }), "warn").mockImplementation(() => {});
    try {
      expect(loadInstructions(root)).toBe(unreadableSection("AGENTS.md", reason));
      expect(warn.mock.calls[0]?.[1]).toMatchObject({ omissions: [{ path: join(root, "AGENTS.md"), reason: "unreadable" }] });
    } finally {
      open.mockRestore();
      warn.mockRestore();
    }
  });

  test("a symlink-loop import is an omission, not a failure", async () => {
    await symlink(join(root, "loop-b.md"), join(root, "loop-a.md"));
    await symlink(join(root, "loop-a.md"), join(root, "loop-b.md"));
    await writeFile(join(root, "AGENTS.md"), "See @loop-a.md");

    expect(loadInstructions(root)).toBe(repositorySection("AGENTS.md", "See @loop-a.md"));
  });

  test.skipIf(!caseSensitiveFileSystem)("a lowercase-only agents.md is labelled with its own name", async () => {
    await writeFile(join(root, "agents.md"), "lowercase rules");

    expect(loadInstructions(root)).toBe(repositorySection("agents.md", "lowercase rules"));
  });

  test.skipIf(!caseSensitiveFileSystem)("AGENTS.md wins over a distinct agents.md, which is reported as shadowed", async () => {
    await writeFile(join(root, "AGENTS.md"), "documented rules");
    await writeFile(join(root, "agents.md"), "shadowed rules");
    const warn = spyOn(Log.create({ service: "project-instructions" }), "warn").mockImplementation(() => {});
    try {
      expect(loadInstructions(root)).toBe(repositorySection("AGENTS.md", "documented rules"));
      expect(warn).toHaveBeenCalledWith("AGENTS.md inputs omitted", {
        omissions: [{ path: join(root, "agents.md"), reason: "shadowed-by-AGENTS.md" }],
      });
    } finally {
      warn.mockRestore();
    }
  });
});
