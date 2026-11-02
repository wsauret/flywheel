/**
 * First-search retrieval benchmark (mirrors entire.io's methodology).
 *
 * Drives the real grep engine + the real line-ranked content-output pipeline over
 * a fixed query set against THIS repo, twice (ranking OFF = old baseline,
 * ranking ON), and prints MRR / Hit@1 / avg output chars. Deterministic, no
 * network, no spawn. This is the default-on product gate for search ranking.
 *
 * Gate on targetFile RANK only (no hardcoded target line). Ranking stays
 * default-on iff Hit@1 and MRR improve and average output remains bounded.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { grep } from "../src/orchestration/agent-runtime/tools/ripgrep.js";
import { formatContentOutput, MAX_COLUMN_WIDTH } from "../src/orchestration/agent-runtime/tools/search.js";
import type { RankOptions } from "../src/orchestration/agent-runtime/tools/search-ranking.js";
import { SEARCH_CPU_LIMIT_SECONDS, SEARCH_WALL_BACKSTOP_SECONDS } from "../src/orchestration/agent-runtime/tools/search-rules.js";
import type { ToolContext } from "../src/orchestration/agent-runtime/tools/types.js";

const repoRoot = new URL("..", import.meta.url).pathname.replace(/\/$/, "");

interface BenchQuery {
  readonly query: string;
  readonly path: string;
  readonly glob?: string;
  readonly targetFile: string;
}

interface Metrics {
  readonly mrr: number;
  readonly hitAt1: number;
  readonly avgChars: number;
}

function loadQueries(): BenchQuery[] {
  const file = join(repoRoot, "tests/fixtures/search-benchmark-queries.json");
  const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
  if (!isObject(parsed) || !Array.isArray(parsed.queries)) {
    throw new Error("benchmark fixture missing 'queries'");
  }
  return parsed.queries.map((q): BenchQuery => {
    if (!isObject(q)) throw new Error("benchmark query must be an object");
    const rec = q;
    if (typeof rec.query !== "string" || typeof rec.path !== "string" || typeof rec.targetFile !== "string") {
      throw new TypeError("benchmark query needs string query/path/targetFile");
    }
    return {
      query: rec.query,
      path: rec.path,
      glob: typeof rec.glob === "string" ? rec.glob : undefined,
      targetFile: rec.targetFile,
    };
  });
}

interface JsonObject {
  [key: string]: unknown;
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 1-based rank of the first rendered match line whose file is the target, or
 *  0 if the target file never appears in the rendered window. Walks the model
 *  output: `# <path>` headers set the current file, lines starting with `*`
 *  are match lines. */
function rankOfTarget(content: string, targetFile: string): number {
  let currentFile = "";
  let matchRank = 0;
  for (const line of content.split("\n")) {
    if (line.startsWith("# ")) {
      currentFile = line.slice(2);
      continue;
    }
    if (line.startsWith("*")) {
      matchRank++;
      if (currentFile === targetFile) return matchRank;
    }
  }
  return 0;
}

async function runQuery(q: BenchQuery, rank: RankOptions): Promise<{ rank: number; chars: number }> {
  const searchBase = join(repoRoot, q.path);
  const result = await grep({
    pattern: q.query,
    path: searchBase,
    glob: q.glob,
    maxColumns: MAX_COLUMN_WIDTH,
    mode: "content",
    maxCount: 1000,
    cpuLimitMs: SEARCH_CPU_LIMIT_SECONDS * 1000,
    timeoutMs: SEARCH_WALL_BACKSTOP_SECONDS * 1000,
  });
  if (result.matches.length === 0) return { rank: 0, chars: 0 };
  // grep returns absolute match paths; executionCwd = searchBase shows them
  // relative to the search base, the form the target file is compared in.
  const context: ToolContext = { executionCwd: searchBase, userDataRoot: "/scratch/search-account", projectRoot: searchBase, artifactScopeId: "search-benchmark", retrievalSessionId: "search-benchmark", sessionId: "search-benchmark" };
  const out = formatContentOutput(result.matches, result, context, 200, 0, rank);
  const content = typeof out.content === "string" ? out.content : "";
  // targetFile is repo-relative; strip the search-base prefix to match display.
  const prefix = `${q.path.replace(/\/$/, "")}/`;
  const targetDisplay = q.targetFile.startsWith(prefix) ? q.targetFile.slice(prefix.length) : q.targetFile;
  return { rank: rankOfTarget(content, targetDisplay), chars: content.length };
}

async function measure(queries: BenchQuery[], rank: RankOptions): Promise<Metrics> {
  let reciprocalSum = 0;
  let hits = 0;
  let charSum = 0;
  for (const q of queries) {
    const { rank: r, chars } = await runQuery(q, rank);
    reciprocalSum += r > 0 ? 1 / r : 0;
    if (r === 1) hits++;
    charSum += chars;
  }
  const n = queries.length;
  return { mrr: reciprocalSum / n, hitAt1: hits / n, avgChars: charSum / n };
}

function fmt(m: Metrics): string {
  return `MRR=${m.mrr.toFixed(4)}  Hit@1=${(m.hitAt1 * 100).toFixed(1)}%  avgChars=${m.avgChars.toFixed(0)}`;
}

async function main(): Promise<void> {
  const queries = loadQueries();
  console.log(`Running first-search retrieval benchmark over ${queries.length} queries against ${repoRoot}\n`);

  const off = await measure(queries, { rankingEnabled: false, preferTests: false });
  const on = await measure(queries, { rankingEnabled: true, preferTests: false });

  console.log("mode      | metrics");
  console.log("----------+--------------------------------------------------");
  console.log(`ranking off | ${fmt(off)}`);
  console.log(`ranking on  | ${fmt(on)}`);
  console.log("");

  const mrrUp = on.mrr >= off.mrr;
  const hitUp = on.hitAt1 >= off.hitAt1;
  const charsOk = on.avgChars <= off.avgChars * 1.15;
  const flip = mrrUp && hitUp && charsOk;
  console.log(
    `Default-on gate: MRR ${mrrUp ? "OK" : "REGRESS"}, Hit@1 ${hitUp ? "OK" : "REGRESS"}, ` +
      `chars ${charsOk ? "BOUNDED" : "INFLATED"} => ${flip ? "KEEP DEFAULT ON" : "KEEP OFF (opt-in)"}`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
