import { afterEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { createBenchmarkCatalog, DEFAULT_IMPLEMENTER_TIMEOUT_MS, resolveReviewFixture } from "../../../src/orchestration/modules/development/benchmark/catalog.js";
import { PLAN_FILE } from "../../../src/orchestration/modules/development/benchmark/implement-task.js";

const catalog = createBenchmarkCatalog(process.cwd());

// A catalog path is built with the host separator, so the expectation is too.


describe("benchmark catalog", () => {
  it("refuses a relative project root, because every path it names hangs off that root", () => {
    expect(() => createBenchmarkCatalog("bench")).toThrow("absolute project root");
  });

  it("loads the implementation corpus with bounded runtime and each task's authoritative prompt", async () => {
    const tasks = await catalog.implementTasks();
    expect(tasks.length).toBeGreaterThan(0);
    for (const task of tasks) {
      if (task.kind === "native") {
        const config = JSON.parse(await Bun.file(join(task.taskDir, "task.json")).text());
        const instructionBytes = await Bun.file(join(task.taskDir, config.instruction)).bytes();
        const instruction = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
          config.instruction.endsWith(".gz") ? gunzipSync(instructionBytes) : instructionBytes,
        );
        expect(task.instruction).toBe(instruction);
        if (task.environment === undefined) {
          expect(task.prompt).toBe(instruction);
        } else {
          expect(task.prompt).toBe(`${instruction}\n\n## Native environment context\n${task.environment}`);
        }
      } else {
        expect(task.prompt).toContain(PLAN_FILE);
      }
      expect(task.timeoutMs).toBeGreaterThanOrEqual(1);
      expect(task.taskDir.startsWith(catalog.implementTasksDir)).toBe(true);
    }
    expect(tasks.some((task) => task.timeoutMs === DEFAULT_IMPLEMENTER_TIMEOUT_MS)).toBe(true);
  });

  it("keeps every review fixture directory inside the fixtures directory", async () => {
    const tasks = await catalog.reviewTasks();
    for (const task of tasks) {
      expect(task.fixtureDir).toBe(join(catalog.reviewFixturesDir, task.id));
    }
  });

  it("appends native environment context without changing the original instruction bytes", async () => {
    syntheticRoot = await mkdtemp(join(tmpdir(), "flywheel-native-context-"));
    const nativeCatalog = createBenchmarkCatalog(syntheticRoot);
    const taskDir = join(nativeCatalog.implementTasksDir, "native");
    await mkdir(taskDir, { recursive: true });
    const instruction = "\uFEFF  Original request.\r\n";
    const environment = "The source root is src/.\r\n";
    const config = {
      kind: "native", id: "native", stratum: "small", family: "synthetic", split: "development",
      instruction: "instruction.txt", native: { command: ["python3", "adapter.py"], timeoutMs: 1000 },
    };
    await Bun.write(join(taskDir, "instruction.txt"), instruction);
    await Bun.write(join(taskDir, "adapter.py"), "# synthetic adapter");
    await Bun.write(join(taskDir, "environment.txt"), environment);
    await Bun.write(join(taskDir, "task.json"), JSON.stringify(config));
    const [original] = await nativeCatalog.implementTasks();
    expect(original?.prompt).toBe(instruction);
    await Bun.write(join(taskDir, "task.json"), JSON.stringify({ ...config, environment: "environment.txt" }));
    const [contextual] = await nativeCatalog.implementTasks();
    expect(contextual).toMatchObject({ instruction, environment });
    expect(contextual?.prompt).toBe(`${instruction}\n\n## Native environment context\n${environment}`);
  });

});

let syntheticRoot: string | undefined;
let outsideDir: string | undefined;

afterEach(async () => {
  for (const directory of [syntheticRoot, outsideDir]) {
    if (directory) await rm(directory, { recursive: true, force: true });
  }
  syntheticRoot = undefined;
  outsideDir = undefined;
});

/** One review fixture with the members a reviewer cell copies. */
async function syntheticReviewFixture(): Promise<{ fixturesDir: string; fixtureDir: string; outside: string }> {
  const root = await mkdtemp(join(tmpdir(), "flywheel-bench-catalog-"));
  syntheticRoot = root;
  outsideDir = await mkdtemp(join(tmpdir(), "flywheel-bench-outside-"));
  await Bun.write(join(outsideDir, "secret.txt"), "not a fixture\n");
  const catalogOf = createBenchmarkCatalog(root);
  const fixtureDir = join(catalogOf.reviewFixturesDir, "ledger");
  await mkdir(join(fixtureDir, "project"), { recursive: true });
  await Bun.write(join(fixtureDir, "project", "ledger.ts"), "export const total = 1;\n");
  await Bun.write(join(fixtureDir, "diff.patch"), "diff --git a/ledger.ts b/ledger.ts\n");
  await Bun.write(join(fixtureDir, "manifest.json"), JSON.stringify({
    title: "Ledger",
    review_prompt_hint: "Read the ledger",
    defects: [{ id: "drift", title: "Drift", category: "correctness", files: ["ledger.ts"], catch_criteria: "Names the drift" }],
  }));
  return { fixturesDir: catalogOf.reviewFixturesDir, fixtureDir, outside: outsideDir };
}

describe("review fixture containment", () => {
  it("loads a fixture whose members are all real files and directories", async () => {
    const { fixturesDir } = await syntheticReviewFixture();
    const tasks = await createBenchmarkCatalog(syntheticRoot ?? "").reviewTasks();
    expect(tasks.map((task) => task.id)).toEqual(["ledger"]);
    const fixture = await resolveReviewFixture(fixturesDir, tasks[0]!);
    expect(fixture.artifactPath.endsWith(join("reviews", "ledger", "diff.patch"))).toBe(true);
  });

  it("identifies the exact review artifact and project tree", async () => {
    const { fixtureDir } = await syntheticReviewFixture();
    const reviewCatalog = createBenchmarkCatalog(syntheticRoot ?? "");
    const identity = async (): Promise<string> => {
      const [task] = await reviewCatalog.reviewTasks();
      if (!task) throw new Error("expected one review task");
      return task.contentIdentity;
    };
    const original = await identity();

    await Bun.write(join(fixtureDir, "project", "ledger.ts"), "export const total = 2;\n");
    expect(await identity()).not.toBe(original);

    await Bun.write(join(fixtureDir, "project", "ledger.ts"), "export const total = 1;\n");
    await Bun.write(join(fixtureDir, "diff.patch"), "diff --git a/ledger.ts b/ledger.ts\n+changed\n");
    expect(await identity()).not.toBe(original);
  });

  it("refuses a mutable Git ref as a review snapshot selector", async () => {
    const { fixtureDir } = await syntheticReviewFixture();
    await Bun.write(join(fixtureDir, "manifest.json"), JSON.stringify({
      title: "Ledger",
      review_prompt_hint: "Read the ledger",
      commit: "HEAD",
      paths: ["ledger.ts"],
      defects: [],
    }));

    await expect(createBenchmarkCatalog(syntheticRoot ?? "").reviewTasks())
      .rejects.toThrow("commit must be a hexadecimal Git object ID");
  });

  it("refuses a fixture whose project directory is a symlink out of the fixtures root", async () => {
    const { fixtureDir, outside } = await syntheticReviewFixture();
    await rm(join(fixtureDir, "project"), { recursive: true, force: true });
    await symlink(outside, join(fixtureDir, "project"));
    await expect(createBenchmarkCatalog(syntheticRoot ?? "").reviewTasks()).rejects.toThrow(/resolves through the symlink/);
  });

  it("refuses a fixture whose reviewed artifact is a symlink out of the fixtures root", async () => {
    const { fixtureDir, outside } = await syntheticReviewFixture();
    await symlink(join(outside, "secret.txt"), join(fixtureDir, "plan.md"));
    await expect(createBenchmarkCatalog(syntheticRoot ?? "").reviewTasks()).rejects.toThrow(/resolves through the symlink/);
  });

  it("refuses an artifact that was swapped for a symlink after the catalog loaded it", async () => {
    const { fixturesDir, fixtureDir, outside } = await syntheticReviewFixture();
    const [task] = await createBenchmarkCatalog(syntheticRoot ?? "").reviewTasks();
    if (!task) throw new Error("expected one review task");
    await rm(join(fixtureDir, "diff.patch"));
    await symlink(join(outside, "secret.txt"), join(fixtureDir, "diff.patch"));
    await expect(resolveReviewFixture(fixturesDir, task)).rejects.toThrow(/resolves through the symlink/);
  });
});