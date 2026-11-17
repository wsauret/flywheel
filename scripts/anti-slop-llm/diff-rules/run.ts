// oxlint-disable flywheel/no-record, typescript/consistent-indexed-object-style, typescript/consistent-type-assertions -- vendored upstream source keeps its own style; see UPSTREAM.md
// Judges the current change set with diff rules: smells that span files or need git history.
//
// Usage: bun run scripts/anti-slop-llm/diff-rules/run.ts [--base <ref>] [--committed|--staged|--working]
//          [--fail] [--json] [--config <path>] [--backend decision-model|command]
//          [--command <shell command>] [--purpose <text>]
//
// Exit status: 0 when nothing fails, 1 when an error-severity rule fires (or any rule with
// --fail), 2 for usage, git, or config errors, and for a failing backend or a command backend
// without a command under --fail or `ci: "fail"` with CI set. A missing decision credential warns
// and skips with status 0.
//
// The decision-model backend asks TypeSafe Jev or OpenAI Decisions, as ANTI_SLOP_DECISION_MODEL,
// TYPESAFE_API_KEY, and OPENAI_API_KEY select; the command backend pipes the prompt to a shell
// command.

import { BACKEND_NAMES, type BackendName } from "./config.ts";
import type { ChangeMode } from "./git.ts";
import { runDiffRules, type RunOptions } from "./runner.ts";

const USAGE =
  "usage: run.ts [--base <ref>] [--committed|--staged|--working] [--fail] [--json] [--config <path>] [--backend decision-model|command] [--command <cmd>] [--purpose <text>]";

function parseArgs(argv: ReadonlyArray<string>): RunOptions {
  let mode: ChangeMode = "full";
  let fail = false;
  let json = false;
  const values: Partial<Record<"base" | "configPath" | "backend" | "command" | "purpose", string>> = {};
  const valueFlags = {
    "--base": "base",
    "--config": "configPath",
    "--backend": "backend",
    "--command": "command",
    "--purpose": "purpose",
  } as const;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? "";
    const [flag = "", inline] = arg.startsWith("--") && arg.includes("=") ? [arg.slice(0, arg.indexOf("=")), arg.slice(arg.indexOf("=") + 1)] : [arg, undefined];
    if (flag === "--fail") fail = true;
    else if (flag === "--json") json = true;
    else if (flag === "--committed") mode = "committed";
    else if (flag === "--staged") mode = "staged";
    else if (flag === "--working") mode = "working";
    else if (flag === "--help" || flag === "-h") {
      console.log(USAGE);
      process.exit(0);
    } else if (Object.hasOwn(valueFlags, flag)) {
      const value = inline ?? argv[(index += 1)];
      if (value === undefined || value.length === 0) throw new Error(`${flag} needs a value`);
      values[valueFlags[flag as keyof typeof valueFlags]] = value;
    } else throw new Error(`unknown argument ${arg}`);
  }
  const backend = BACKEND_NAMES.find((name) => name === values.backend);
  if (values.backend !== undefined && backend === undefined) {
    throw new Error(`--backend must be one of ${BACKEND_NAMES.join(", ")}`);
  }
  const named: { backend?: BackendName } = backend === undefined ? {} : { backend };
  return {
    cwd: process.cwd(),
    env: process.env,
    mode,
    fail,
    json,
    ...named,
    ...(values.base === undefined ? {} : { base: values.base }),
    ...(values.configPath === undefined ? {} : { configPath: values.configPath }),
    ...(values.command === undefined ? {} : { command: values.command }),
    ...(values.purpose === undefined ? {} : { purpose: values.purpose }),
  };
}

let options: RunOptions;
try {
  options = parseArgs(process.argv.slice(2));
} catch (error) {
  console.error(`diff-rules: ${error instanceof Error ? error.message : String(error)}\n${USAGE}`);
  process.exit(2);
}
const result = await runDiffRules(options);
process.stderr.write(result.stderr);
process.stdout.write(result.stdout);
process.exitCode = result.exitCode;
