/**
 * The one rule set that bounds every agent file search (ARCH-TOOLS-052,
 * PI-AGENT-053): the search and list tools apply it in process, and on macOS
 * and Linux the agent shell applies it through shims around the person's own
 * search programs. Every route reads its values here; none keeps a copy, and
 * the native crate receives them as options.
 */

/**
 * Processor time one search may spend, in seconds. The tools sum the CPU time
 * of every thread that works on one search, so queue wait and machine load do
 * not count. A shim sets it as the soft `ulimit -t` of the real program, so a
 * program that only filters a pipe never reaches it.
 */
export const SEARCH_CPU_LIMIT_SECONDS = 30;

/**
 * Wall-clock time after which the search and list tools stop a search that
 * spends little processor time because it waits on reads, such as cloud-only
 * files or a network mount. It is a backstop, never the rule: an ordinary
 * search reaches the CPU limit first. Shell programs have no own backstop;
 * the bash tool's timeout bounds them.
 */
export const SEARCH_WALL_BACKSTOP_SECONDS = 120;

/**
 * Directory names that every directory search prunes at any depth, in
 * addition to the directories the repository's ignore rules exclude. A search
 * whose root is at or inside one of them still searches it, because a
 * directory the call names stays reachable. The list holds language-agnostic
 * artifact directories, `.git`, and Flywheel's own workspace state: append-only
 * logs (a runaway log once grew to 728MB and turned every pathless search into
 * a 100s stall), the SQLite event store, and the search tool's truncation
 * breadcrumbs, which must not match future searches for the same terms.
 */
export const PRUNED_DIR_NAMES: readonly string[] = [
  ".git",
  "node_modules", "dist", "build", "out", "target", "vendor", "obj",
  "__pycache__", ".venv", "venv", ".tox", ".mypy_cache", ".pytest_cache", ".ruff_cache",
  "coverage", ".nyc_output", ".next", ".nuxt", ".svelte-kit", ".turbo", ".parcel-cache", ".cache", ".gradle",
  "Pods", "DerivedData", ".terraform", ".dart_tool",
  ".flywheel",
];

/**
 * Why the search or list tool stopped a search before it finished:
 * `no-worker` when every native search worker stayed busy until the wall
 * backstop, so the search never started.
 */
export type SearchStop = "cpu-limit" | "wall-backstop" | "no-worker";

/**
 * The error text the search and list tools return when they stop a search.
 * `tool` names the stopped tool. No partial results accompany it, so the text
 * tells the model how to narrow the call.
 */
export function searchStoppedMessage(tool: "search" | "list", stop: SearchStop): string {
  if (stop === "cpu-limit") {
    return `The ${tool} was stopped after ${SEARCH_CPU_LIMIT_SECONDS}s of processing time; no results were returned. Narrow it and retry: pass a more specific 'path' (a subdirectory or single file) or add a more selective filter. Broad scans of large trees cannot finish within the limit.`;
  }
  if (stop === "no-worker") {
    return `The ${tool} did not start: other searches kept the search capacity busy for ${SEARCH_WALL_BACKSTOP_SECONDS}s; no results were returned. Try again, or narrow the search so it finishes sooner.`;
  }
  return `The ${tool} was stopped after ${SEARCH_WALL_BACKSTOP_SECONDS}s of waiting on file reads; no results were returned. The path likely holds slow storage, such as cloud-only files or a network mount. Pass a 'path' that holds local files.`;
}

/**
 * The guidance a shim prints to standard error when `program` reaches the
 * CPU limit, before the shim exits with status 2.
 */
export function shellSearchStoppedMessage(program: ShellSearchProgram): string {
  return `${program}: stopped after ${SEARCH_CPU_LIMIT_SECONDS}s of processing time. Narrow the path or the pattern.`;
}

/**
 * The shell search rule of one program.
 * - `prunes`: the shim excludes pruned directories from the program's
 *   directory searches. The pruned names are `PRUNED_DIR_NAMES` plus the
 *   basenames of the directories that git ignores below the call's roots,
 *   minus the basenames of the directories git tracks there. A call keeps a
 *   pruned directory that it names: a path operand whose own last component
 *   is that name or, for find, a name or path test that holds it. A search
 *   pattern or an ancestor of a root never names one, so
 *   `grep -rn node_modules .` still prunes. Without `prunes`, the program
 *   gets only the CPU limit.
 * - `cpuLimitExemptWith`: arguments that make the program run other commands per
 *   result. Their children would inherit the CPU limit, so with any of these
 *   arguments the shim sets no limit and only prunes.
 */
export interface ShellSearchRule {
  readonly prunes: boolean;
  readonly cpuLimitExemptWith: readonly string[];
}

/**
 * The programs that get a shim in the agent shell on macOS and Linux, with the
 * rule of each. A program absent from the base PATH gets no shim.
 */
export const SHELL_SEARCH_RULES = {
  grep: { prunes: true, cpuLimitExemptWith: [] },
  egrep: { prunes: true, cpuLimitExemptWith: [] },
  fgrep: { prunes: true, cpuLimitExemptWith: [] },
  rg: { prunes: true, cpuLimitExemptWith: [] },
  find: { prunes: true, cpuLimitExemptWith: ["-exec", "-execdir", "-ok", "-okdir"] },
  fd: { prunes: true, cpuLimitExemptWith: ["-x", "-X", "--exec", "--exec-batch"] },
  du: { prunes: false, cpuLimitExemptWith: [] },
} as const satisfies { readonly [program: string]: ShellSearchRule };

export type ShellSearchProgram = keyof typeof SHELL_SEARCH_RULES;

function isShellSearchProgram(name: string): name is ShellSearchProgram {
  return Object.hasOwn(SHELL_SEARCH_RULES, name);
}

/** The programs of `SHELL_SEARCH_RULES`, in their declared order. */
export const SHELL_SEARCH_PROGRAMS: readonly ShellSearchProgram[] = Object.keys(SHELL_SEARCH_RULES).filter(isShellSearchProgram);
