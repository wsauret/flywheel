const BENCHMARK_GUARDRAIL =
  "Be careful not to overfit to the benchmarks and do not cheat on the benchmarks."

export interface ExperimentSystemPromptFragmentOptions {
  readonly checksCommand: string | null
}

/** Renders the active experiment contract from request-pinned durable state. */
export function renderExperimentSystemPromptFragment(
  options: ExperimentSystemPromptFragmentOptions,
): string {
  let fragment =
    "## Experiment Mode (ACTIVE)" +
    "\nYou are in experiment mode. Optimize the primary metric through an autonomous experiment loop." +
    "\nUse init_experiment, run_experiment, and log_experiment tools. NEVER STOP until interrupted." +
    "\nExperiment rules: .experiment/charter.md is read-only during the loop. Read this file at the start of every session and after compaction." +
    "\nUse the session checkpoint as working memory for the theme ledger, ideas backlog, and what has been tried. Do not create parallel .auto files or JSONL state." +
    `\n${BENCHMARK_GUARDRAIL}` +
    "\nIf the user sends a follow-on message while an experiment is running, finish the current run_experiment + log_experiment cycle first, then address their message in the next iteration."

  if (options.checksCommand !== null) {
    fragment +=
      "\n\n## Backpressure Checks (ACTIVE)" +
      `\nThe recorded checks command (${options.checksCommand}) runs automatically after every passing benchmark in run_experiment.` +
      "\nIf the benchmark passes but checks fail, run_experiment will report it clearly." +
      "\nUse status 'checks_failed' in log_experiment when this happens. It behaves like a crash: no commit is created and changes are auto-reverted." +
      "\nYou cannot use status 'keep' when checks have failed." +
      "\nThe checks execution time does NOT affect the primary metric."
  }

  return fragment
}
