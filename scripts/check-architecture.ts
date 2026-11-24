// `bun run check:architecture`: the architecture rules of ARCH-STRUCTURE-045
// ("Modules are deep and depend in one direction") over the four source
// trees. Six rules ported from deslop-please (MIT): module-cycle, tangle,
// field-leak, shallow-module, wide-directory, and long-file.
//
// Fails on a finding that scripts/architecture-allowlist.ts does not list,
// and on a list entry that no finding matches, so the list only shrinks
// when debt is paid. Prints each such finding and entry; a clean run prints
// one summary line.
//
// The model asks the TypeScript 7 compiler (`typescript/unstable/async`),
// which runs in its own process that the `typescript` package starts. Its
// API takes no spawn options, so that launch cannot state `windowsHide`.
import * as path from "node:path";
import { KNOWN_ARCHITECTURE_FINDINGS } from "./architecture-allowlist.ts";
import { buildModel } from "./architecture/build-model.ts";
import { reconcile } from "./architecture/known-findings.ts";
import { layOut } from "./architecture/layout.ts";
import { renderFinding } from "./architecture/render.ts";
import { check } from "./architecture/rules.ts";
import { counted } from "./architecture/graph.ts";

const REPO_ROOT = path.resolve(import.meta.dir, "..");
const SOURCE_ROOTS = [
  { name: "flywheel", dir: "src" },
  { name: "webview", dir: "webview/src" },
  { name: "vscode", dir: "vscode/src" },
  { name: "relay", dir: "relay" },
];

const started = performance.now();
const laid = layOut(REPO_ROOT, SOURCE_ROOTS);
const model = await buildModel(REPO_ROOT, laid, path.join(import.meta.dir, "architecture", "tsconfig.json"));
const findings = check(model);
const { unknown, stale } = reconcile(findings, KNOWN_ARCHITECTURE_FINDINGS);
const seconds = ((performance.now() - started) / 1000).toFixed(1);

for (const finding of unknown) process.stdout.write(renderFinding(finding));
for (const entry of stale) {
  process.stdout.write(`stale[${entry.lint}]: no finding matches the known finding \`${entry.key}\`; remove its entry from scripts/architecture-allowlist.ts\n\n`);
}
const summary = `check:architecture: ${counted(laid.files.length, "file")}, ${counted(findings.length, "finding")}, ${KNOWN_ARCHITECTURE_FINDINGS.length} known; ${seconds}s`;
if (unknown.length || stale.length) {
  console.error(`${summary}\n${counted(unknown.length, "new finding")}, ${stale.length} stale ${stale.length === 1 ? "entry" : "entries"}. Fix a new finding, or list it with a reason in scripts/architecture-allowlist.ts.`);
  process.exit(1);
}
console.log(summary);
