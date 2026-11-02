/** Two processes writing one memory store.
 *
 *  Disk is the single source of truth for a bounded memory store, and every
 *  mutation re-reads it. The in-process mutation queue orders the runners of one
 *  process only, so the invariant that matters here is the cross-process one:
 *  two writers that interleave their read-modify-write windows compose instead
 *  of clobbering, and no entry either of them reported as written is missing. */

import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { temporaryDirectories } from "../../helpers/directories.js";

const REPO = join(import.meta.dir, "..", "..", "..");
const MEMORY_STORE_URL = new URL("../../../src/orchestration/modules/learning/memory-store.ts", import.meta.url).href;
const WRITES_PER_PROCESS = 60;

const temporaryDirectory = temporaryDirectories();

/** Each worker waits on the barrier file so both are inside their write loops
 *  at the same time; process startup alone would let one finish before the
 *  other begins, and then nothing would be concurrent to prove. Paths reach the
 *  worker as JSON string literals so that a Windows path keeps its separators. */
function workerSource(dir: string, go: string): string {
  return `
import { existsSync } from "node:fs";
import { applyMemoryOperation } from ${JSON.stringify(MEMORY_STORE_URL)};

const label = process.argv[2];
const config = {
  locations: {
    project: { baseDir: ${JSON.stringify(dir)}, relativePath: "MEMORY.json" },
    global: { baseDir: ${JSON.stringify(dir)}, relativePath: "USER.json" },
  },
  limits: { project: 1_000_000, global: 1_000_000 },
};

while (!existsSync(${JSON.stringify(go)})) await Bun.sleep(1);

for (let index = 0; index < ${WRITES_PER_PROCESS}; index += 1) {
  const result = await applyMemoryOperation(config, "project", { action: "add", content: \`\${label} entry \${index}\` });
  if (result.kind !== "written") {
    console.error(JSON.stringify(result));
    process.exit(1);
  }
}
`;
}

function entriesOnDisk(store: string): string[] {
  if (!existsSync(store)) return [];
  const document: { entries: { content: string }[] } = JSON.parse(readFileSync(store, "utf8"));
  return document.entries.map((entry) => entry.content);
}

describe("two processes writing one memory store", () => {
  it("keeps every entry both processes wrote", async () => {
    const dir = temporaryDirectory("flywheel-memory-concurrent-write-");
    const go = join(dir, "go");
    const script = join(dir, "memory-worker.ts");
    writeFileSync(script, workerSource(dir, go));

    const children = ["alpha", "beta"].map((label) =>
      Bun.spawn([process.execPath, script, label], { cwd: REPO, stdout: "pipe", stderr: "pipe", windowsHide: true }));
    writeFileSync(go, "");
    const runs = await Promise.all(children.map(async (child) => ({
      code: await child.exited,
      err: await new Response(child.stderr).text(),
    })));

    // The worker reports a refused mutation on stderr, so its exit code is the
    // outcome and a failure surfaces the refusal.
    for (const run of runs) expect(run.code === 0 ? "" : run.err).toBe("");

    const expected = ["alpha", "beta"].flatMap((label) =>
      Array.from({ length: WRITES_PER_PROCESS }, (_, index) => `${label} entry ${index}`));
    expect(entriesOnDisk(join(dir, "MEMORY.json")).toSorted()).toEqual(expected.toSorted());
  }, 60_000);
});
