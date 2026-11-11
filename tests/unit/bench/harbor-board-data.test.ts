import { afterEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { fetchBoard, loadBoard } from "../../../bench/harbor/analysis/board-data.js";
import { harborBenchmark } from "../../../bench/harbor/benchmarks.js";
import { temporaryDirectories } from "../../helpers/directories.js";

const tempDir = temporaryDirectories();
const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

const BENCHMARK = harborBenchmark("terminal-bench-2.1");
const HUB = "https://huggingface.co";
const SPACE_FILES = `${HUB}/spaces/joelniklaus/harness-leaderboard/resolve/rev-1/hlb/data`;
const BUCKET_TREE = `${HUB}/api/buckets/joelniklaus/harness-leaderboard/tree`;
const BRIDGE_FIRST_LINE = "// bridge build 2\n";
const PACKAGE_LOCK = JSON.stringify({ packages: {
  "node_modules/tool": { version: "1.2.0", dependencies: { "lib-a": "^1.2.0", "lib-b": "1.0.0", "lib-c": "~2.0.0" } },
  "node_modules/lib-a": { version: "1.5.0" },
  "node_modules/tool/node_modules/lib-a": { version: "1.3.0" },
  "node_modules/lib-b": { version: "1.0.0" },
  "node_modules/lib-c": { version: "2.0.4" },
} });

/** The Hub as the board fetch reads it: a Space whose harness registry names
 *  one adapter by name, pins the public board's adapter by recorded id, and
 *  installs one harness from a lock, and a bucket with only the published
 *  board. Any other URL is a 404. */
function serveHub(requested: string[]): void {
  const routes = new Map<string, unknown>([
    [`${HUB}/api/spaces/joelniklaus/harness-leaderboard/revision/main`, { sha: "rev-1" }],
    [`${SPACE_FILES}/benchmarks.json`, { benchmarks: { "terminal-bench-2.1": { commit: "c1", strata: "difficulty", subsets: {} } } }],
    [`${SPACE_FILES}/harnesses.json`, { harnesses: {
      pinned: { version: "1.0", adapter: "bridge", public_adapter: "bridge@7011f496679d" },
      current: { version: "2.0", adapter: "bridge" },
      locked: { version: "1.2.0", lock: "tool", public_lock: null },
    } }],
    [`${SPACE_FILES}/models.json`, { models: {} }],
    [`${SPACE_FILES}/staged_releases.json`, { _doc: "registry notes", "release-a": { version: null }, "release-b": { version: "0.1.3" } }],
    [`${SPACE_FILES}/locks/tool/package.json`, { dependencies: { tool: "1.2.0" } }],
    [`${SPACE_FILES}/locks/tool/package-lock.json`, PACKAGE_LOCK],
    [`${SPACE_FILES}/bridge.cjs`, `${BRIDGE_FIRST_LINE}module.exports = {};\n`],
    [`${BUCKET_TREE}/index?recursive=false`, [{ type: "file", path: "index/public.json" }]],
    [`${BUCKET_TREE}/runs?recursive=false`, []],
    [`${HUB}/buckets/joelniklaus/harness-leaderboard/resolve/index/public.json`, { version: "0.1.5" }],
  ]);
  globalThis.fetch = Object.assign(async (input: string | URL | Request) => {
    const url = input instanceof Request ? input.url : String(input);
    requested.push(url);
    const body = routes.get(url);
    if (body === undefined) return new Response("not found", { status: 404 });
    return new Response(typeof body === "string" ? body : JSON.stringify(body));
  }, { preconnect: originalFetch.preconnect });
}

describe("board fetch", () => {
  it("identifies a named adapter by its bundle's first line and keeps a pinned public adapter id as the registry records it", async () => {
    const requested: string[] = [];
    serveHub(requested);
    const cache = tempDir("harbor-board-");
    await fetchBoard(BENCHMARK, cache);
    const { config } = await loadBoard(BENCHMARK, cache);
    expect(requested.filter((url) => url.endsWith(".cjs"))).toEqual([`${SPACE_FILES}/bridge.cjs`]);
    expect(config.adapterIds).toEqual({ bridge: `bridge@${createHash("sha256").update(BRIDGE_FIRST_LINE).digest("hex").slice(0, 12)}` });
    expect(config.harnesses.pinned?.publicAdapter).toBe("bridge@7011f496679d");
  });

  it("records a lock as runs record it and reads the staged releases against the published board's version", async () => {
    serveHub([]);
    const cache = tempDir("harbor-board-");
    await fetchBoard(BENCHMARK, cache);
    const { config } = await loadBoard(BENCHMARK, cache);
    // The pinned package's own copy of a dependency wins, and an exact version is no range an install could move.
    expect(config.lockRecords).toEqual({ tool: { sha256: createHash("sha256").update(PACKAGE_LOCK).digest("hex").slice(0, 12), packages: { "lib-a": "1.3.0", "lib-c": "2.0.4" } } });
    expect(config.harnesses.locked).toMatchObject({ lock: "tool", publicLock: null });
    expect(config.stagedReleases).toEqual({ "release-a": null, "release-b": "0.1.3" });
    expect(config.boardVersion).toBe("0.1.5");
  });

  it("names the cache it read in the fetch command that replaces missing board data", async () => {
    const cache = tempDir("harbor-board-");
    await expect(loadBoard(BENCHMARK, cache)).rejects.toThrow(`board fetch --benchmark ${BENCHMARK.id} --cache ${JSON.stringify(cache)}`);
  });
});
