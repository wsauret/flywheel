import { describe, expect, it } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { collectBenchPins } from "../../../scripts/check-bench-pins.js";
import { RESEARCH_SNAPSHOT } from "../../../src/orchestration/modules/development/benchmark/catalog.js";
import { temporaryDirectories } from "../../helpers/directories.js";

const temporaryDirectory = temporaryDirectories();

function write(root: string, path: string, content: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
}

const sha = (digit: string) => digit.repeat(40);

describe("check-bench-pins", () => {
  it("collects the commit of every fixture source and skips vendored projects, retained campaign sources, and the empty tree", async () => {
    const root = temporaryDirectory("flywheel-bench-pins-");
    write(root, "bench/tasks/planning/subtree/task.json", JSON.stringify({ sandbox: { commit: `${sha("a")}:flywheel-tui`, paths: ["src"] } }));
    write(root, "bench/tasks/planning/greenfield/task.json", JSON.stringify({ sandbox: { commit: "4b825dc642cb6eb9a060e54bf8d69288fbee4904", paths: [] } }));
    write(root, "bench/tasks/coding-development/vendored/task.json", JSON.stringify({ sandbox: { fixtureRepo: "project" } }));
    write(root, "bench/tasks/coding-development/vendored/project/task.json", JSON.stringify({ sandbox: { commit: sha("9") } }));
    write(root, "bench/chat-ab/tasks/patched/task.json", JSON.stringify({ sandbox: { commit: sha("b"), paths: ["src"] } }));
    write(root, "bench/chat-ab/results/campaign/sources/control/bench/chat-ab/tasks/retired/task.json", JSON.stringify({ sandbox: { commit: sha("8"), paths: ["src"] } }));

    const pins = await collectBenchPins(root);

    expect(pins.map(({ source, commit }) => `${source} ${commit}`).sort()).toEqual([
      `bench/chat-ab/tasks/patched/task.json ${sha("b")}`,
      `bench/tasks/planning/subtree/task.json ${sha("a")}`,
      `src/orchestration/modules/development/benchmark/catalog.ts RESEARCH_SNAPSHOT ${RESEARCH_SNAPSHOT.commit}`,
    ]);
  });
});
