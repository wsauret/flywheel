/** A Harbor Hub benchmark that the hill-climb system runs and scores. Each
 *  benchmark has one descriptor here, and the launcher, the ledger, and the
 *  analysis read a benchmark's facts only from it. What the dataset itself
 *  states, such as timeouts and the agent's network mode, is read from the
 *  dataset; what the harness leaderboard states, such as its strata, is read
 *  from the board's data. The exclusions are the one board fact that the
 *  launcher needs without the board's data, so the descriptor states them and
 *  `hill.ts board verify` refuses a descriptor that disagrees with the board. */
export interface HarborBenchmark {
  /** The id that the command line and round records name. */
  readonly id: string;
  readonly display: string;
  /** The Harbor Hub dataset and the exact ref that every run pins. */
  readonly dataset: { readonly name: string; readonly ref: string };
  /** The prefix that a bare task name takes, such as `terminal-bench` in `terminal-bench/kv-store-grpc`. */
  readonly taskNamespace: string;
  /** The benchmark's key in the harness leaderboard's data; absent when the board does not rank it. */
  readonly boardKey?: string;
  /** Named lists of bare task names that a hill-climb measures. The `subset`
   *  split is the one that projects to the full benchmark. A benchmark whose
   *  splits are not chosen yet has none, and a run of a missing split is refused. */
  readonly splits: Readonly<Record<string, readonly string[]>>;
  /** Tasks of the dataset that a run of the whole benchmark leaves out, as the
   *  board does, each with the board's reason. */
  readonly excluded: readonly { readonly task: string; readonly reason: string }[];
  /** Tasks whose grader fails correct work on Harbor Hub. They stay in their
   *  splits, as on the board, and scores are also reported without them. */
  readonly hubBroken: readonly { readonly task: string; readonly evidence: string }[];
  /** Whether each trial home carries the benchmark-only answer-key rule. A
   *  benchmark whose agent phase is offline gains nothing from it. */
  readonly answerKeyRule: boolean;
  /** Names of the benchmark's own published copies, such as its repository
   *  owners and dataset names. A passing trial whose tool calls reach a code
   *  host or dataset hub URL that holds one of them is an answer-key candidate for review. */
  readonly answerKeySources: readonly string[];
  /** Whether the grader downloads its tools from GitHub, so that a verifier log
   *  with a failed GitHub download and no test summary means that nothing graded the trial. */
  readonly verifierDownloadsFromGithub: boolean;
  /** Whether a local Docker run seals the verifier's Python dependencies into a wheelhouse. */
  readonly localVerifierWheelhouse: boolean;
}

/** The split that a run of every task measures: the dataset without the
 *  benchmark's exclusions, which is the board's whole benchmark. */
export const ALL_TASKS = "all";

/** The split that a round's first run of an explicit task list measures: the
 *  tasks of that list. */
export const TASK_LIST = "task-list";

const TERMINAL_BENCH_2_1: HarborBenchmark = {
  id: "terminal-bench-2.1",
  display: "Terminal-Bench 2.1",
  dataset: { name: "terminal-bench/terminal-bench-2-1", ref: "sha256:7d7bdc1cbedad549fc1140404bd4dc45e5fd0ea7c4186773687d177ad3a0699a" },
  taskNamespace: "terminal-bench",
  boardKey: "terminal-bench-2.1",
  splits: {
    subset: [
      "filter-js-from-html", "install-windows-3.11", "mteb-retrieve", "db-wal-recovery", "sparql-university",
      "mcmc-sampling-stan", "kv-store-grpc", "bn-fit-modify", "cobol-modernization", "regex-log",
      "custom-memory-heap-crash", "rstan-to-pystan", "constraints-scheduling", "build-pmars",
    ],
    holdout: [
      "configure-git-webserver", "count-dataset-tokens", "fix-git", "gcode-to-text", "hf-model-inference",
      "log-summary-date-ranges", "mteb-leaderboard", "multi-source-data-merger", "nginx-request-logging", "overfull-hbox",
      "pypi-server", "pytorch-model-recovery", "raman-fitting", "sqlite-db-truncate",
    ],
    holdout2: [
      "adaptive-rejection-sampler", "build-cython-ext", "cancel-async-tasks", "chess-best-move", "circuit-fibsqrt",
      "code-from-image", "dna-assembly", "dna-insert", "financial-document-processor", "fix-ocaml-gc",
      "headless-terminal", "large-scale-text-editing", "largest-eigenval", "llm-inference-batching-scheduler", "mailman",
      "path-tracing-reverse", "protein-assembly", "regex-chess", "schemelike-metacircular-eval", "write-compressor",
    ],
  },
  excluded: [
    { task: "qemu-startup", reason: "its upstream image does not start on Harbor" },
    { task: "qemu-alpine-ssh", reason: "its upstream image does not start on Harbor" },
  ],
  hubBroken: [
    { task: "custom-memory-heap-crash", evidence: "Harbor's oracle agent failed it 8 of 8 times on Harbor Hub on 2026-11-07; failing trials fail only test_no_memory_leaks_with_valgrind." },
  ],
  answerKeyRule: true,
  answerKeySources: ["terminal-bench", "terminal_bench", "tbench", "harbor-framework", "harborframework", "laude-institute", "laude"],
  verifierDownloadsFromGithub: true,
  localVerifierWheelhouse: true,
};

const DEEP_SWE_1_1: HarborBenchmark = {
  id: "deep-swe-1.1",
  display: "DeepSWE v1.1",
  dataset: { name: "datacurve/deep-swe-1-1", ref: "sha256:5affcd534fd90ac85d202d4c63f8b35ddc942140afdd5d60014a21365440a2f5" },
  taskNamespace: "datacurve",
  boardKey: "deep-swe",
  splits: {
    subset: [
      "aiomonitor-task-snapshots-diff", "bandit-structured-nosec-directives", "dasel-html-document-format", "dynamodb-toolbox-lazy-recursive-schemas",
      "expr-try-catch-errors", "ipython-session-bundle-replay", "koota-composite-trait-aspects", "narwhals-rolling-window-suite",
      "ofetch-per-origin-circuit-breaker", "prometheus-transactional-reload-status", "prometheus-typed-label-sorting", "scc-bounded-memory-spilling",
      "termenv-preserve-ansi-resets", "textual-kitty-key-phases", "valibot-recursive-schema-composition", "yaegi-go-embed-directives",
    ],
    holdout: [
      "participle-grammar-conflict-analysis", "etree-xml-diff-patch", "tengo-destructuring-bindings", "go-genai-streamed-function-args", "ytt-jsonpath-query-api",
      "testem-bail-on-test-failure", "gql-incremental-graphql-delivery", "httpx-streaming-json-iteration", "mashumaro-flattened-dataclass-fields",
      "bandit-interprocedural-taint-checks", "psd-tools-blend-range-api", "happy-dom-deterministic-intersectionobserver", "clack-async-autocomplete-options",
      "sql-formatter-bigquery-pipe-formatting", "httpx-deterministic-cookie-store",
    ],
  },
  excluded: [
    { task: "helm-unified-manifest-stream", reason: "its reference solution fails on the board's sandbox" },
    { task: "vulture-persistent-analysis-cache", reason: "its grader fails correct solutions" },
  ],
  hubBroken: [
    { task: "prometheus-transactional-reload-status", evidence: "Harbor's oracle agent failed it 4 of 4 times on Harbor Hub on 2026-11-09: each passed all 15 fail-to-pass tests and failed the same 10 pass-to-pass TestQueryLog cases, which skip with \"ip version not supported\" because the Hub sandbox has no IPv6." },
  ],
  answerKeyRule: false,
  answerKeySources: ["deep-swe", "deepswe", "datacurve"],
  verifierDownloadsFromGithub: false,
  localVerifierWheelhouse: false,
};

export const HARBOR_BENCHMARKS: readonly HarborBenchmark[] = [TERMINAL_BENCH_2_1, DEEP_SWE_1_1];

/** Returns the registered benchmark with this id, or throws an error that lists every registered id. */
export function harborBenchmark(id: string): HarborBenchmark {
  const benchmark = HARBOR_BENCHMARKS.find((candidate) => candidate.id === id);
  if (benchmark === undefined) throw new Error(`unknown benchmark ${id}; registered: ${HARBOR_BENCHMARKS.map((candidate) => candidate.id).join(", ")}`);
  return benchmark;
}
