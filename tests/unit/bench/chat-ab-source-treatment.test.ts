import { expect, test } from "bun:test";
import { cp, mkdir, readFile, symlink, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { prepareSourceTreatment, resolveSourceTreatment, validatePreparedTreatment } from "../../../bench/chat-ab/source-treatment.js";
import { temporaryDirectories } from "../../helpers/directories.js";
import { ownedCommandResult } from "../../helpers/owned-command-fake.js";
import type { OwnedCommandRunner } from "../../../src/infra/owned-command.js";
import { structuredIdentity } from "../../../src/orchestration/modules/development/benchmark/content-identity.js";

const temporary = temporaryDirectories();

async function fixture(beforePreparation?: (repo: string, harness: string) => Promise<void>, patches?: readonly string[], rejectPatch = false) {
  const root = temporary("source-treatment-");
  const repo = join(root, "repo");
  const harness = join(root, "harness");
  const paths = ["package.json", "bun.lock", "src/value.ts"];
  for (const directory of [join(repo, "src"), join(harness, "bench/chat-ab"), join(harness, "bench/shared"), join(harness, "bench/tasks")]) {
    await mkdir(directory, { recursive: true });
  }
  await writeFile(join(repo, "package.json"), '{"name":"fixture"}');
  await writeFile(join(repo, "bun.lock"), "lock");
  await writeFile(join(repo, "src/value.ts"), 'export const value = "pinned";');
  await writeFile(join(harness, "bench/chat-ab/probe.ts"), 'export { value } from "../../src/value";');
  await mkdir(join(harness, "bench/chat-ab/results"), { recursive: true });
  await writeFile(join(harness, "bench/chat-ab/results/private.txt"), "do not copy");
  const calls: string[][] = [];
  const run: OwnedCommandRunner = async (command, options) => {
    calls.push([...command]);
    const args = command.slice(1);
    let stdout = "";
    if (command[0] === "git" && args[0] === "rev-parse") stdout = args.at(-1)?.endsWith("^{tree}") ? "tree\n" : "commit\n";
    else if (args[0] === "show") stdout = await readFile(join(repo, String(args[1]).split(":")[1]!), "utf8");
    else if (args[0] === "ls-tree" || args[0] === "ls-files") stdout = `${paths.join("\0")}\0`;
    else if (args[0] === "worktree") await cp(repo, String(args[3]), { recursive: true });
    else if (args[0] === "apply") return rejectPatch ? { ...ownedCommandResult(""), exitCode: 1, stderr: "patch does not apply" } : ownedCommandResult("");
    else if (command[0] === "bun") {
      await mkdir(join(options!.cwd!, "node_modules/package"), { recursive: true });
      await writeFile(join(options!.cwd!, "node_modules/package/index.js"), "package");
    } else throw new Error(`Unexpected command ${command.join(" ")}`);
    return ownedCommandResult(stdout);
  };
  await beforePreparation?.(repo, harness);
  const source = await resolveSourceTreatment(repo, "branch", run, patches);
  const directory = join(root, "prepared");
  const prepared = await prepareSourceTreatment({ repoRoot: repo, harnessRoot: harness, source, directory, run });
  return { repo, harness, source, prepared, run, calls, directory };
}

test("pins source and a fixed harness, excludes results, and reuses only the exact preparation", async () => {
  const f = await fixture();
  expect(f.calls).toContainEqual(["git", "worktree", "add", "--detach", f.directory, "commit"]);
  expect(f.calls).toContainEqual(["bun", "install", "--frozen-lockfile"]);
  expect(await readFile(join(f.directory, "src/value.ts"), "utf8")).toContain("pinned");
  await expect(readFile(join(f.directory, "bench/chat-ab/results/private.txt"))).rejects.toThrow();
  expect(await prepareSourceTreatment({ repoRoot: f.repo, harnessRoot: f.harness, source: f.source, directory: f.directory, run: f.run })).toEqual(f.prepared);
  await writeFile(join(f.harness, "bench/chat-ab/probe.ts"), "changed harness");
  await expect(prepareSourceTreatment({ repoRoot: f.repo, harnessRoot: f.harness, source: f.source, directory: f.directory, run: f.run })).rejects.toThrow("different source treatment");
});

test("pins ordered patch bytes, refuses drift, and surfaces application failures before install", async () => {
  const paths = ["bench/chat-ab/first.patch", "bench/chat-ab/second.patch"];
  const setup = async (repo: string, harness: string) => {
    for (const path of paths) {
      await mkdir(join(repo, path, ".."), { recursive: true });
      await writeFile(join(repo, path), path);
      await writeFile(join(harness, path), path);
    }
  };
  const f = await fixture(setup, paths);
  const application = f.calls.filter((call) => call[1] === "apply");
  expect(application).toEqual(paths.map((path) => ["git", "apply", "--", join(f.repo, path)]));
  const install = f.calls.findIndex((call) => call[0] === "bun");
  expect(f.calls.indexOf(application[1]!)).toBeLessThan(install);
  await writeFile(join(f.repo, paths[0]!), "edited patch");
  const changed = await resolveSourceTreatment(f.repo, "branch", f.run, paths);
  expect(structuredIdentity(changed)).not.toBe(structuredIdentity(f.source));
  await expect(prepareSourceTreatment({ repoRoot: f.repo, harnessRoot: f.harness, source: changed, directory: f.directory, run: f.run })).rejects.toThrow("different source treatment");
  await expect(fixture(setup, paths, true)).rejects.toThrow("patch does not apply");
});

test.each([
  ["src/value.ts", "source"],
  ["src/added.ts", "source"],
  ["bench/chat-ab/probe.ts", "harness"],
  ["package.json", "dependency declarations"],
  ["node_modules/package/index.js", "installed dependencies"],
] as const)("rejects changed execution bytes at %s", async (path, reason) => {
  const f = await fixture();
  await writeFile(join(f.directory, path), "mutation");
  await expect(validatePreparedTreatment(f.prepared, f.run)).rejects.toThrow(reason);
});

test("ignores generated skill locks and compiler caches", async () => {
  const f = await fixture();
  for (const path of ["src/skill/.locks/holder", "node_modules/.cache/compiled"]) {
    await mkdir(join(f.directory, path, ".."), { recursive: true });
    await writeFile(join(f.directory, path), "generated");
  }
  await validatePreparedTreatment(f.prepared, f.run);
});

test.each(["bench", "bench/shared", "tsconfig.bench.json"])(
  "rejects a symlink destination at %s before any harness replacement",
  async (path) => {
    const external = temporary("source-treatment-external-");
    await mkdir(join(external, "chat-ab"), { recursive: true });
    await writeFile(join(external, "chat-ab/sentinel"), "external");
    await writeFile(join(external, "config"), "external config");
    let preparedDirectory = "";
    await expect(fixture(async (repo, harness) => {
      preparedDirectory = join(repo, "../prepared");
      if (path !== "bench") {
        await mkdir(join(repo, "bench/chat-ab"), { recursive: true });
        await writeFile(join(repo, "bench/chat-ab/original"), "original harness");
      }
      if (path === "tsconfig.bench.json") await writeFile(join(harness, path), "{}");
      await symlink(path === "tsconfig.bench.json" ? join(external, "config") : external, join(repo, path));
    })).rejects.toThrow("Harness destination contains a symlink");
    expect(await readFile(join(external, "chat-ab/sentinel"), "utf8")).toBe("external");
    expect(await readFile(join(external, "config"), "utf8")).toBe("external config");
    if (path !== "bench") {
      expect(await readFile(join(preparedDirectory, "bench/chat-ab/original"), "utf8")).toBe("original harness");
    }
  },
);

test("keeps ordinary source symlinks in the hashed source identity", async () => {
  const f = await fixture(async (repo) => {
    await symlink("value.ts", join(repo, "src/link.ts"));
  });
  await validatePreparedTreatment(f.prepared, f.run);
  await unlink(join(f.directory, "src/link.ts"));
  await symlink("added.ts", join(f.directory, "src/link.ts"));
  await expect(validatePreparedTreatment(f.prepared, f.run)).rejects.toThrow("source changed");
});
