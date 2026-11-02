const string = (description: string) => ({ type: "string", description } as const)

export const initExperimentSchema = {
  type: "object",
  properties: {
    name: string('Human-readable name for this experiment session (e.g. "Optimizing liquid for fastest execution and parsing")'),
    metric_name: string('Display name for the primary metric (e.g. "total_µs", "bundle_kb", "val_bpb"). Shown in dashboard headers.'),
    metric_unit: string('Unit for the primary metric. Use "µs", "ms", "s", "kb", "mb", or "" for unitless. Affects number formatting. Default: ""'),
    direction: { type: "string", enum: ["lower", "higher"], description: 'Whether "lower" or "higher" is better for the primary metric. Default: "lower".' },
    measure_command: string("Approved command that emits the declared METRIC lines."),
    checks_command: { type: ["string", "null"], description: "Approved checks command, or null when no checks are required." },
    work_dir: string("Dedicated Git worktree root for this experiment session."),
    max_iterations: { type: ["integer", "null"], minimum: 1, description: "Maximum experiment iterations, or null for the runtime limit." },
    protected_paths: { type: "array", items: { type: "string" }, description: "Path globs the experiment cannot write." },
    sealed_paths: { type: "array", items: { type: "string" }, description: "Path globs the experiment cannot read." },
  },
  required: ["name", "metric_name", "measure_command", "work_dir"],
  additionalProperties: false,
} as const

export const runExperimentSchema = {
  type: "object",
  properties: {
    timeout_seconds: { type: "number", description: "Kill after this many seconds (default: 600)" },
    checks_timeout_seconds: { type: "number", description: "Kill the approved checks command after this many seconds (default: 300)." },
  },
  additionalProperties: false,
} as const

export const logExperimentSchema = {
  type: "object",
  properties: {
    commit: string("Git commit hash (short, 7 chars)"),
    metric: { type: "number", description: "The primary optimization metric value (e.g. seconds, val_bpb). 0 for crashes." },
    status: { type: "string", enum: ["keep", "discard", "crash", "checks_failed"] },
    description: string("Short description of what this experiment tried"),
    metrics: { type: "object", additionalProperties: { type: "number" }, description: 'Additional metrics to track as { name: value } pairs, e.g. { "compile_µs": 4200, "render_µs": 9800 }. These are shown alongside the primary metric for tradeoff monitoring.' },
    force: { type: "boolean", description: "Set to true to allow adding a new secondary metric that wasn't tracked before. Only use for metrics that have proven very valuable to watch." },
    asi: { type: "object", additionalProperties: true, description: "Actionable Side Information - structured diagnostics for this run. Free-form key/value pairs. Parsed ASI from run_experiment output is merged automatically; use this to add or override fields." },
  },
  required: ["commit", "metric", "status", "description"],
  additionalProperties: false,
} as const
