import { describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OwnedCommandRunner } from "../../../src/infra/owned-command.js";
import {
  captureImplementation,
  loadImplementTasks,
  PLAN_FILE,
  provisionTaskSandbox,
} from "../../../src/orchestration/modules/development/benchmark/implement-task.js";
import { withSnapshotWorkspace } from "../../../src/orchestration/modules/development/benchmark/snapshot-workspace.js";
import { syntheticCommands, writeSyntheticTaskDir } from "./_implement-task-fixtures.js";

describe("implementation fixture containment", () => {
  it("rejects an arbitrary nested archive symlink before patch, baseline, or trial work and cleans the workspace", async () => {
    const taskDir = await mkdtemp(join(tmpdir(), "bench-implement-task-"));
    const target = join(taskDir, "outside");
    await writeFile(target, "outside");
    await writeFile(join(taskDir, "change.patch"), "declared patch");
    const task = {
      id: "archive-link",
      taskDir,
      sandbox: {
        commit: "0123456789abcdef0123456789abcdef01234567",
        paths: ["src"],
        patch: "change.patch",
      },
    } as const;
    const commands: string[][] = [];
    let sandboxDir: string | undefined;
    const runner: OwnedCommandRunner = async (command, options) => {
      commands.push([...command]);
      if (command[0] === "tar" && options?.cwd) {
        sandboxDir = options.cwd;
        await mkdir(join(options.cwd, "src", "nested"), { recursive: true });
        await symlink(target, join(options.cwd, "src", "nested", "link"));
      }
      return { exitCode: 0, timedOut: false, stdoutBytes: new Uint8Array(), stdout: "", stderr: "" };
    };

    try {
      await expect(provisionTaskSandbox(process.cwd(), task, runner)).rejects.toThrow("Commit archive contains a symlink or unsupported entry");
      expect(commands.some((command) => command[0] === "git" && command[1] === "apply")).toBe(false);
      expect(commands.some((command) => command[0] === "git" && command[1] === "init")).toBe(false);
      if (!sandboxDir) throw new Error("expected archive sandbox");
      expect(await stat(sandboxDir).then(() => true, () => false)).toBe(false);

      // Research and review workspaces read the project through the same snapshot owner.
      sandboxDir = undefined;
      let used = false;
      await expect(withSnapshotWorkspace(process.cwd(), task.sandbox, runner, async () => { used = true; })).rejects.toThrow("Commit archive contains a symlink or unsupported entry");
      expect(used).toBe(false);
      if (!sandboxDir) throw new Error("expected snapshot workspace");
      expect(await stat(sandboxDir).then(() => true, () => false)).toBe(false);
    } finally {
      await rm(taskDir, { recursive: true, force: true });
    }
  });

  for (const archiveName of [PLAN_FILE, ".gitignore"]) {
    it(`rejects an archive symlink at ${archiveName} before harness access`, async () => {
      const outside = await mkdtemp(join(tmpdir(), "bench-implement-outside-"))
      const target = join(outside, "target")
      const sentinel = "OUTSIDE_MUST_STAY_UNREAD_AND_UNCHANGED"
      await writeFile(target, sentinel)
      const task = {
        id: "archive-link",
        taskDir: outside,
        sandbox: {
          commit: "0123456789abcdef0123456789abcdef01234567",
          paths: ["src"],
        },
        plan: { schema_version: 1, phases: ["one"] },
      } as const
      const runner: OwnedCommandRunner = async (command, options) => {
        if (command[0] === "tar" && options?.cwd) await symlink(target, join(options.cwd, archiveName))
        return { exitCode: 0, timedOut: false, stdoutBytes: new Uint8Array(), stdout: "", stderr: "" }
      }

      try {
        const failure = await provisionTaskSandbox(process.cwd(), task, runner).then(
          () => undefined,
          (error) => error,
        )
        expect(failure).toBeInstanceOf(Error)
        expect(failure instanceof Error ? failure.message : "").not.toContain(sentinel)
        expect(await readFile(target, "utf8")).toBe(sentinel)
      } finally {
        await rm(outside, { recursive: true, force: true })
      }
    })
  }

  it("refuses a task whose project fixture is a symlink out of the task directory", async () => {
    const tasksDir = await writeSyntheticTaskDir();
    const outside = await mkdtemp(join(tmpdir(), "bench-implement-outside-"));
    await Bun.write(join(outside, "stolen.ts"), "export const stolen = true;\n");
    await rm(join(tasksDir, "synthetic", "project"), { recursive: true, force: true });
    await symlink(outside, join(tasksDir, "synthetic", "project"));
    try {
      await expect(loadImplementTasks(tasksDir)).rejects.toThrow(/resolves through the symlink/);
    } finally {
      await rm(tasksDir, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("refuses a task whose acceptance suite is swapped for a symlink after the load", async () => {
    const tasksDir = await writeSyntheticTaskDir();
    const outside = await mkdtemp(join(tmpdir(), "bench-implement-outside-"));
    const [task] = await loadImplementTasks(tasksDir);
    if (!task) throw new Error("expected one synthetic task");
    const sandbox = await provisionTaskSandbox(process.cwd(), task, syntheticCommands);
    await rm(join(tasksDir, "synthetic", "acceptance"), { recursive: true, force: true });
    await symlink(outside, join(tasksDir, "synthetic", "acceptance"));
    try {
      await expect(captureImplementation(task, sandbox, syntheticCommands)).rejects.toThrow(/resolves through the symlink/);
    } finally {
      await rm(sandbox, { recursive: true, force: true });
      await rm(tasksDir, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  }, 30_000);
});
