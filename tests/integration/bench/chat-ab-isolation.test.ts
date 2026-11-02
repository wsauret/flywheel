import { describe, expect, test } from "bun:test";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { cellIsolation, inheritedCellEnvironment } from "../../../bench/chat-ab/isolation.js";
import { createCliLauncher } from "../../../src/cli/runtime-launch.js";
import { ownedCommandRunner } from "../../../src/infra/owned-command.js";
import { fakeOwnedCommandRunner, ownedCommandResult } from "../../helpers/owned-command-fake.js";
import { temporaryDirectories } from "../../helpers/directories.js";

const temporary = temporaryDirectories();

describe.if(process.platform === "darwin")("Chat campaign OS confinement", () => {
  test("keeps Claude configuration and the current cell readable without exposing a prior cell's transcript or session work", async () => {
    const root = await realpath(temporary("claude-confinement-"));
    const home = join(root, "home");
    // A decomposed accent stays decomposed on disk; Claude Code names the project from the NFC form.
    const workspace = join(root, "workspace-cafe\u0301");
    const claude = join(home, ".claude");
    const sessionId = "10000000-0000-4000-8000-000000000001";
    const currentProject = workspace.normalize("NFC").replace(/[^a-zA-Z0-9]/g, "-");
    const files = [
      { path: join(claude, "projects", "-prior-cell", "prior.jsonl"), allowed: false },
      { path: join(claude, "projects", currentProject, `${sessionId}.jsonl`), allowed: true },
      { path: join(claude, "settings.json"), allowed: true },
      { path: join(claude, "shell-snapshots", "snapshot-zsh.sh"), allowed: true },
      { path: join(home, "Library", "Keychains", "login.keychain-db"), allowed: true },
      ...["file-history", "session-env", "tasks", "uploads"].flatMap((store) => [
        { path: join(claude, store, "prior-session", "entry"), allowed: false },
        { path: join(claude, store, sessionId, "entry"), allowed: true },
      ]),
      { path: join(claude, "todos", "prior-agent-prior.json"), allowed: false },
      { path: join(claude, "todos", `${sessionId}-agent-${sessionId}.json`), allowed: true },
      { path: join(claude, "history.jsonl"), allowed: false },
      { path: join(claude, "plans", "prior.md"), allowed: false },
    ];
    await mkdir(workspace, { recursive: true });
    for (const { path } of files) {
      await mkdir(join(path, ".."), { recursive: true });
      await writeFile(path, "synthetic sentinel");
    }
    const { run: setup } = fakeOwnedCommandRunner((command) => Promise.resolve(ownedCommandResult(command.includes("--git-common-dir") ? `${root}/.git\n` : "")));
    const oldHome = process.env.HOME;
    let isolation;
    try {
      process.env.HOME = home;
      isolation = await (await cellIsolation(root, root, setup, { kind: "claude-code" })).confine({
        hidden: [join(root, "results")], own: [workspace], claudeCode: { projectRoot: workspace, sessionId },
      });
    } finally {
      if (oldHome === undefined) delete process.env.HOME;
      else process.env.HOME = oldHome;
    }
    const launcher = await createCliLauncher();
    try {
      const run = ownedCommandRunner(launcher.scope);
      for (const file of files) {
        const result = await run(isolation.wrap([process.execPath, "-e", `require("node:fs").readFileSync(${JSON.stringify(file.path)});`]), {
          cwd: workspace, env: inheritedCellEnvironment(process.env),
        });
        expect({ path: file.path, allowed: result.exitCode === 0 }).toEqual(file);
        if (!file.allowed) expect(result.stderr).toContain("EPERM");
      }
      // A rename names only the source and destination, so a recorded store, or ~/.claude itself, moved to a readable
      // path would expose prior work; each move must fail while the cell's own transcript stays writable.
      const moves = [
        { from: join(claude, "projects", "-prior-cell", "prior.jsonl"), to: join(claude, "relocated.jsonl") },
        { from: join(claude, "projects"), to: join(workspace, "projects") },
        { from: claude, to: join(home, "claude-moved") },
        { from: join(claude, "projects", currentProject, `${sessionId}.jsonl`), to: join(claude, "projects", currentProject, "renamed.jsonl"), allowed: true },
      ];
      for (const move of moves) {
        const result = await run(isolation.wrap([process.execPath, "-e", `require("node:fs").renameSync(${JSON.stringify(move.from)}, ${JSON.stringify(move.to)});`]), {
          cwd: workspace, env: inheritedCellEnvironment(process.env),
        });
        expect({ from: move.from, allowed: result.exitCode === 0 }).toEqual({ from: move.from, allowed: move.allowed ?? false });
      }
    } finally {
      await launcher.dispose();
    }
  });

  test("denies hidden task copies and controller writes while allowing the selected workspace and treatment cache", async () => {
    const root = await realpath(temporary("chat-confinement-"));
    const results = join(root, "results");
    const treatment = join(results, "sources", "selected");
    const workspace = join(results, "cell", "workspace");
    const hidden = [join(root, "tasks"), join(treatment, "tasks")];
    const controllerCache = join(root, "node_modules", ".cache");
    const treatmentCache = join(treatment, "node_modules", ".cache");
    const controllerLocks = join(root, "skills", ".locks");
    const treatmentLocks = join(treatment, "skills", ".locks");
    for (const path of [workspace, controllerCache, treatmentCache, controllerLocks, treatmentLocks, ...hidden.map((task) => join(task, "acceptance"))]) await mkdir(path, { recursive: true });
    for (const path of hidden) {
      await writeFile(join(path, "task.json"), "{}");
      await writeFile(join(path, "acceptance", "hidden.test.ts"), "hidden");
    }
    const { run: setup } = fakeOwnedCommandRunner((command) => Promise.resolve(ownedCommandResult(command.includes("--git-common-dir") ? `${root}/.git\n` : command.includes("worktree") ? `worktree ${root}\0` : "")));
    const isolation = await (await cellIsolation(root, results, setup, { kind: "flywheel", authProfile: "Personal" })).confine({
      hidden: [results, ...hidden], own: [workspace, treatmentCache, treatmentLocks], readonly: [treatment], writeDenied: [controllerCache, controllerLocks],
    });
    const launcher = await createCliLauncher();
    try {
      const run = ownedCommandRunner(launcher.scope);
      const checks = [
        ...hidden.flatMap((path) => ["task.json", "acceptance/hidden.test.ts"].map((file) => ({
          path: join(path, file), operation: "readFileSync", allowed: false,
        }))),
        { path: join(controllerCache, "probe"), operation: "writeFileSync", allowed: false },
        { path: join(controllerLocks, "probe"), operation: "writeFileSync", allowed: false },
        { path: join(treatmentCache, "probe"), operation: "writeFileSync", allowed: true },
        { path: join(treatmentLocks, "probe"), operation: "writeFileSync", allowed: true },
        { path: join(workspace, "probe"), operation: "writeFileSync", allowed: true },
      ];
      for (const check of checks) {
        const result = await run(isolation.wrap([process.execPath, "-e", `const fs=require("node:fs");fs.${check.operation}(${JSON.stringify(check.path)},${JSON.stringify(check.operation === "readFileSync" ? "utf8" : "probe")});`]), {
          cwd: workspace, env: inheritedCellEnvironment(process.env),
        });
        expect({ path: check.path, allowed: result.exitCode === 0 }).toEqual({ path: check.path, allowed: check.allowed });
        if (!check.allowed) expect(result.stderr).toContain("EPERM");
      }
    } finally {
      await launcher.dispose();
    }
  });
});
