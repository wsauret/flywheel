import { describe, expect, it } from "bun:test";
import { mkdir, symlink } from "node:fs/promises";
import { join } from "node:path";
import { createBenchmarkCatalog } from "../../../src/orchestration/modules/development/benchmark/catalog.js";
import { loadImplementTasks } from "../../../src/orchestration/modules/development/benchmark/implement-task.js";
import { temporaryDirectories } from "../../helpers/directories.js";

const temporaryDirectory = temporaryDirectories();

describe("native implementation task loading", () => {
  it("discovers native tasks without a plan and preserves exact instructions and adapter identity", async () => {
    const root = temporaryDirectory("bench-native-");
    const nativeCatalog = createBenchmarkCatalog(root);
    const taskDir = join(nativeCatalog.implementTasksDir, "native");
    await mkdir(taskDir, { recursive: true });
    const instruction = "  Fix the original bug.\r\nDo not rewrite tests.";
    await Bun.write(join(taskDir, "instruction.txt"), instruction);
    await Bun.write(join(taskDir, "adapter.py"), "# original grader\n");
    await Bun.write(join(taskDir, "original-source.txt"), "source bytes");
    await Bun.write(join(taskDir, "task.json"), JSON.stringify({
      kind: "native", id: "native", stratum: "small", instruction: "instruction.txt",
      family: "original-python", split: "development",
      native: { command: ["python3", "adapter.py"], timeoutMs: 3_600_000 },
    }));
    const [task] = await nativeCatalog.implementTasks();
    expect(task?.prompt).toBe(instruction);
    expect(task?.manifest).toEqual({ traps: [], judgment: [] });
    expect(task).not.toHaveProperty("plan");
    await Bun.write(join(taskDir, "adapter.py"), "# changed original grader\n");
    const [changed] = await nativeCatalog.implementTasks();
    expect(changed?.contentIdentity).not.toBe(task?.contentIdentity);
    const identity = changed?.contentIdentity;
    await Bun.write(join(taskDir, "instruction.txt"), `${instruction}\n`);
    const [changedInstruction] = await nativeCatalog.implementTasks();
    expect(changedInstruction?.prompt).toBe(`${instruction}\n`);
    expect(changedInstruction?.contentIdentity).not.toBe(identity);
    await Bun.write(join(taskDir, "original-source.txt"), "changed source bytes");
    const [changedSource] = await nativeCatalog.implementTasks();
    expect(changedSource?.contentIdentity).not.toBe(changedInstruction?.contentIdentity);
    const config = JSON.parse(await Bun.file(join(taskDir, "task.json")).text());
    const path = [".bench-home/python/bin", ".bench-home/bin"];
    await Bun.write(join(taskDir, "task.json"), JSON.stringify({ ...config, native: { ...config.native, path } }));
    const [withPath] = await loadImplementTasks(nativeCatalog.implementTasksDir);
    expect(withPath).toMatchObject({ native: { path } });
    expect(withPath?.contentIdentity).not.toBe(changedSource?.contentIdentity);
    for (const invalidPath of [["/usr/bin"], ["C:\\tools"], ["C:tools"], ["../tools"], ["tools/../bin"], ["tools\\..\\bin"], [""], ["   "], [42], "tools"]) {
      await Bun.write(join(taskDir, "task.json"), JSON.stringify({ ...config, native: { ...config.native, path: invalidPath } }));
      await expect(loadImplementTasks(nativeCatalog.implementTasksDir)).rejects.toThrow("native/task.json.native.path");
    }
    const environment = "\uFEFFSource is in workspace/src.\r\nRun python3 locally.";
    await Bun.write(join(taskDir, "environment.txt"), environment);
    await Bun.write(join(taskDir, "task.json"), JSON.stringify({ ...config, environment: "environment.txt" }));
    const [withEnvironment] = await loadImplementTasks(nativeCatalog.implementTasksDir);
    expect(withEnvironment).toMatchObject({ instruction: `${instruction}\n`, environment });
    expect(withEnvironment?.contentIdentity).not.toBe(changedSource?.contentIdentity);
    await Bun.write(join(taskDir, "environment.txt"), `${environment}\n`);
    const [changedEnvironment] = await loadImplementTasks(nativeCatalog.implementTasksDir);
    expect(changedEnvironment?.contentIdentity).not.toBe(withEnvironment?.contentIdentity);
    const compressedInstruction = "\uFEFF  Fix the original café bug.\r\nDo not rewrite tests.\r\n";
    const compressedConfig = { ...config, instruction: "original.txt.gz", environment: "environment.txt" };
    await Bun.write(join(taskDir, "original.txt.gz"), Bun.gzipSync(new TextEncoder().encode(compressedInstruction)));
    await Bun.write(join(taskDir, "task.json"), JSON.stringify(compressedConfig));
    const [compressed] = await nativeCatalog.implementTasks();
    expect(compressed).toMatchObject({ instruction: compressedInstruction, environment: `${environment}\n` });
    expect(compressed?.prompt).toBe(`${compressedInstruction}\n\n## Native environment context\n${environment}\n`);
    await Bun.write(join(taskDir, "original.txt.gz"), Bun.gzipSync(new TextEncoder().encode(`${compressedInstruction}\n`)));
    const [changedCompressed] = await nativeCatalog.implementTasks();
    expect(changedCompressed).toMatchObject({ instruction: `${compressedInstruction}\n` });
    expect(changedCompressed?.contentIdentity).not.toBe(compressed?.contentIdentity);
    await Bun.write(join(taskDir, "original.txt.gz"), "not gzip");
    await expect(nativeCatalog.implementTasks()).rejects.toThrow();
    await Bun.write(join(taskDir, "original.txt.gz"), Bun.gzipSync(new Uint8Array([0xff])));
    await expect(nativeCatalog.implementTasks()).rejects.toThrow();
    for (const environmentPath of ["../outside.txt", 42, "missing.txt"]) {
      await Bun.write(join(taskDir, "task.json"), JSON.stringify({ ...config, environment: environmentPath }));
      await expect(loadImplementTasks(nativeCatalog.implementTasksDir)).rejects.toThrow();
    }
    await symlink(join(taskDir, "instruction.txt"), join(taskDir, "linked.txt"));
    await Bun.write(join(taskDir, "task.json"), JSON.stringify({ ...config, environment: "linked.txt" }));
    await expect(loadImplementTasks(nativeCatalog.implementTasksDir)).rejects.toThrow("symlink");
    await Bun.write(join(taskDir, "environment.txt"), new Uint8Array([0xff]));
    await Bun.write(join(taskDir, "task.json"), JSON.stringify({ ...config, environment: "environment.txt" }));
    await expect(loadImplementTasks(nativeCatalog.implementTasksDir)).rejects.toThrow();
    await Bun.write(join(taskDir, "task.json"), JSON.stringify({ ...config, sandbox: { fixtureRepo: "project", setup: [["python3", "setup.py"]] } }));
    await expect(nativeCatalog.implementTasks()).rejects.toThrow("native adapter owns source and runtime preparation");
  });
});
