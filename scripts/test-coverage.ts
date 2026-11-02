import { mkdtemp, open, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { assertCoverageBaseline, assertCoverageSources, coverageDecision, coverageReportSchema, coverageSummary, mergeLcov, productionPath, productionRoots } from "./coverage-lines.js";

const root = fileURLToPath(new URL("..", import.meta.url));
type Lane = "unit" | "integration" | "combined";

async function sourceHashes() {
  const sources: { [path: string]: string } = {};
  for (const dir of productionRoots) {
    for await (const file of new Bun.Glob("**/*").scan({ cwd: join(root, dir), onlyFiles: true })) {
      const path = productionPath(join(dir, file), root);
      if (path) sources[path] = createHash("sha256").update(await readFile(join(root, path))).digest("hex");
    }
  }
  return Object.fromEntries(Object.entries(sources).sort(([a], [b]) => a.localeCompare(b)));
}

async function lcovFiles(dir: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...await lcovFiles(path));
    else if (entry.name === "lcov.info") files.push(path);
  }
  return files;
}

function usage(): never {
  throw new Error("Usage: bun run test:coverage -- baseline|compare --output <new-report.json> [--against <baseline.json>] [--lane unit|integration|combined]. Output must not exist.");
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const mode = args.shift();
  if (mode !== "baseline" && mode !== "compare") usage();
  let output: string | undefined;
  let against: string | undefined;
  let lane: Lane = "unit";
  while (args.length) {
    const flag = args.shift();
    const value = args.shift();
    if (!value) usage();
    if (flag === "--output") output = value;
    else if (flag === "--against") against = value;
    else if (flag === "--lane" && (value === "unit" || value === "integration" || value === "combined")) lane = value;
    else usage();
  }
  if (!output || (mode === "compare") !== Boolean(against)) usage();
  const sources = await sourceHashes();
  const baseline = against ? coverageReportSchema.parse(JSON.parse(await readFile(against, "utf8"))) : undefined;
  if (baseline) assertCoverageBaseline(baseline, { sources, lane, bunVersion: Bun.version });
  const destination = await open(output, "wx");
  let dir: string | undefined;
  let child: Bun.Subprocess | undefined;
  let interrupted: NodeJS.Signals | undefined;
  const cancel = (signal: NodeJS.Signals) => {
    interrupted = signal;
    child?.kill(signal);
  };
  process.on("SIGINT", cancel);
  process.on("SIGTERM", cancel);
  try {
    dir = await mkdtemp(join(tmpdir(), "flywheel-coverage-"));
    let passed = 0;
    let failed = 0;
    const incompleteScopes: ("unit" | "integration")[] = [];
    const scopes: ("unit" | "integration")[] = lane === "combined" ? ["unit", "integration"] : [lane];
    for (const selected of scopes) {
      if (interrupted) throw new Error(`Coverage interrupted by ${interrupted}`);
      const summary = coverageSummary(selected);
      const proc = Bun.spawn([process.execPath, join(root, "scripts", selected === "unit" ? "test-parallel.ts" : "test-integration.ts")], {
        cwd: root,
        env: { ...process.env, FLYWHEEL_COVERAGE_DIR: join(dir, selected), FORCE_COLOR: "0", NO_COLOR: "1" },
        stdout: "pipe",
        stderr: "pipe",
        windowsHide: true,
      });
      child = proc;
      const stream = async (input: ReadableStream<Uint8Array>, outputStream: NodeJS.WriteStream, count: boolean) => {
        const decoder = new TextDecoder();
        for await (const chunk of input) {
          outputStream.write(chunk);
          if (count) summary.push(decoder.decode(chunk, { stream: true }));
        }
        if (count) summary.push(decoder.decode());
      };
      const [exit] = await Promise.all([
        proc.exited,
        stream(proc.stdout, process.stdout, selected === "unit"),
        stream(proc.stderr, process.stderr, selected === "integration"),
      ]);
      child = undefined;
      const counts = summary.finish();
      passed += counts.passed;
      failed += counts.failed;
      if (exit !== 0) incompleteScopes.push(selected);
    }
    if (interrupted) throw new Error(`Coverage interrupted by ${interrupted}`);
    assertCoverageSources(sources, await sourceHashes());
    const files = await lcovFiles(dir);
    if (!files.length) throw new Error("No LCOV shards were produced; coverage cannot be measured");
    const lines = mergeLcov(await Promise.all(files.map((file) => readFile(file, "utf8"))), root);
    const report = coverageReportSchema.parse({
      version: 1, kind: mode === "baseline" ? "baseline" : "candidate", bunVersion: Bun.version, lane, sources, lines,
      unmeasured: Object.keys(sources).filter((path) => !Object.hasOwn(lines, path)),
      incompleteScopes, tests: { passed, failed }, failed: incompleteScopes.length > 0 || failed > 0,
    });
    const decision = coverageDecision(report, baseline);
    report.failed = decision.failed;
    await destination.writeFile(JSON.stringify(report, null, 2) + "\n");
    process.stdout.write(`Coverage lane: ${lane}; incomplete scopes: ${incompleteScopes.join(", ") || "none"}; Bun ${Bun.version}; ${passed} pass, ${failed} fail; ${Object.keys(lines).length} measured production files, ${report.unmeasured.length} unmeasured production files\n`);
    if (decision.comparison) {
      const result = decision.comparison;
      process.stdout.write(`Frozen baseline: ${result.baselinePercent.toFixed(2)}%; candidate: ${result.candidatePercent.toFixed(2)}%; loss: ${result.lossPoints.toFixed(2)} percentage points\n`);
      for (const [path, missing] of Object.entries(result.missing)) {
        process.stdout.write(`Missing: ${path}: ${missing.join(",")}\n`);
      }
      if (baseline?.failed) process.stderr.write("Baseline recorded failures; comparison is not a passing result\n");
    }
    if (report.failed) process.exitCode = 1;
  } finally {
    if (child) { child.kill(interrupted ?? "SIGTERM"); await child.exited; }
    if (dir) await rm(dir, { recursive: true, force: true });
    await destination.close();
    process.off("SIGINT", cancel);
    process.off("SIGTERM", cancel);
    if (interrupted) process.exitCode = interrupted === "SIGINT" ? 130 : 143;
  }
}

if (import.meta.main) await main().catch((error: unknown) => {
  process.stderr.write(`test-coverage: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode ||= 1;
});
