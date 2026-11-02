# Experiment Scripts

Authoring guide for the two scripts the charter's Commands section describes. Draft both with that section and get them approved with it. The harness runs both; the loop never edits them.

## `.experiment/measure.sh`

Bash script (`set -euo pipefail`) that pre-checks fast (syntax errors in under a second), runs the benchmark, and writes structured lines to stdout. Keep the script fast; every second is multiplied by hundreds of runs.

For fast, noisy benchmarks (under 5 seconds), run the workload several times inside the script and report the median. This produces stable data points and makes the confidence score reliable from the start. Slow workloads (model training, large builds) do not need this; single runs are fine.

### Structured output

`METRIC name=value` lines carry the primary metric (the name must match the charter's `metric_name`) and any secondary metrics. `run_experiment` parses them.

### Design the script to inform optimization

The script should output whatever data helps the next iteration make a better decision. Think about what you will need to see after each run to know where to focus:

- Phase timings when the workload has distinct stages.
- Error counts, failure categories, or test names when checks can fail in different ways.
- Memory usage, cache hit rates, or other runtime diagnostics when relevant.
- Anything domain-specific that localizes regressions or identifies bottlenecks.

The script runs the same code every iteration and is protected during the loop, so settle its instrumentation here.

### Agent-supplied ASI via `log_experiment`

The `asi` parameter of `log_experiment` annotates each run with whatever would help the next iteration decide better: free-form key/value pairs. Do not repeat the description or raw output; capture what would be lost after a context reset.

Annotate failures and crashes heavily. Discarded and crashed runs are reverted, so the code changes are gone. The only record that survives is the description and ASI in the recorded run facts. If you do not capture what you tried and why it failed, future iterations waste time rediscovering the same dead ends.

## `.experiment/checks.sh`

Bash script (`set -euo pipefail`) for backpressure and correctness checks: tests, types, lint. The file always exists because the loop protects it; without a correctness constraint it holds only the shebang and `set -euo pipefail`.

When checks are present:

- They run automatically after every passing benchmark in `run_experiment`.
- If checks fail, `run_experiment` reports it clearly; log the run as `checks_failed`.
- Their execution time does not affect the primary metric.
- A result cannot be kept when checks have failed.
- They have a separate timeout (default 300 seconds).

Keep output minimal. Only the last 80 lines of checks output reach the agent on failure. Suppress verbose progress and success output and let only errors through, so the agent can pinpoint what broke.
