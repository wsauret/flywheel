/**
 * The shell route of the search rules (ARCH-TOOLS-052, PI-AGENT-053): one
 * `#!/bin/sh` shim per search program, put first on the PATH of every agent
 * shell command on macOS and Linux. A shim runs the person's own program with
 * added exclusions and a processing-time limit; it never changes the
 * program's arguments, matching, or output otherwise. Every value comes from
 * `search-rules.ts` when the shim is rendered.
 */

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { quoteBashSingle } from "./bash-script.js";
import {
  PRUNED_DIR_NAMES,
  SEARCH_CPU_LIMIT_SECONDS,
  SHELL_SEARCH_PROGRAMS,
  SHELL_SEARCH_RULES,
  shellSearchStoppedMessage,
  type ShellSearchProgram,
} from "./search-rules.js";
import type { BashOperations } from "./types.js";

/** The folder under a session scratchpad that holds one folder of shims per rendered set. */
const SEARCH_SHIMS_DIR = "search-shims";

/** The status a shell reports for a child that SIGXCPU ended: 128 + 24 on macOS and Linux. */
const CPU_LIMIT_STATUS = 152;

type PrunedProgram = {
  [P in ShellSearchProgram]: (typeof SHELL_SEARCH_RULES)[P]["prunes"] extends true ? P : never
}[ShellSearchProgram];

/**
 * Every shim holds directory names as glob patterns that match the name
 * literally, because grep's `--exclude-dir`, find's `-name` and `-path`, rg's
 * `-g`, and fd's `-E` all read a glob, and each reads a backslash as an escape.
 */
function escapeGlob(name: string): string {
  return name.replace(/[[\]*?{}\\]/g, "\\$&");
}

// Writes one argument as a single-quoted shell word into $quoted, for the
// argument lists that a shim evaluates later.
const QUOTE = `sq="'"
quote() {
  quoted= rest=$1
  while :; do
    case $rest in
      *"$sq"*) quoted=$quoted\${rest%%"$sq"*}"'\\\\''"; rest=\${rest#*"$sq"} ;;
      *) quoted="'$quoted$rest'"; return ;;
    esac
  done
}`;

/**
 * Prints the basenames of the directories that git ignores below any
 * directory among the roots, minus the basenames of the directories it
 * tracks below any of them, so `results` stays searchable where a tracked
 * directory has that name. Each root asks its own repository, and a root
 * outside one contributes nothing. The exclusions of one call apply to all
 * its roots, because grep's `--exclude-dir`, rg's `-g`, and fd's `-E` cover
 * the whole command. A relative root is relative to $base. A root inside an
 * ignored directory lists itself as `./`, which names nothing. git writes
 * NUL-ended paths, so a name keeps its backslashes, tabs, and quotes; a name
 * that holds a newline cannot be one line of $excluded and is left out.
 */
function ignoredNames(git: string | undefined): string {
  if (git === undefined) return "ignored_names() { :; }";
  const run = `${quoteBashSingle(git)} -C "$dir" ls-files -z`;
  return `ignored_names() {
  for root; do
    shift
    case $root in /*) ;; *) root=$base/$root ;; esac
    [ -d "$root" ] && set -- "$@" "$root"
  done
  [ $# -gt 0 ] || return 0
  for dir; do
    { ${run}; printf '//\\000'; ${run} --others --ignored --exclude-standard --directory; printf '///\\000'; } 2>/dev/null
  done | tr '\\n\\000' '\\001\\n' | awk -F/ '
    index($0, "\\001") { next }
    $0 == "//" { ignored = 1; next }
    $0 == "///" { ignored = 0; next }
    !ignored { for (i = 1; i < NF; i++) tracked[$i] = 1; next }
    /\\/$/ { name = $(NF - 1); if (name != ".") found[name] = 1 }
    END { for (name in found) if (!(name in tracked)) { gsub(/[][*?{}\\\\]/, "\\\\\\\\&", name); print name } }'
}`;
}

/**
 * `exclude` sets $excluded to the pruned names of a call whose directory roots
 * are its arguments, `.` when there are none, minus each name the call names.
 * A grep or find call names a pruned directory only when a root's own last
 * component is that name (`mention_roots`), or when a find name or path test
 * holds it as a whole word of a glob or path; both go to $mentions. A search
 * pattern and an ancestor of a root never name one. grep's `--exclude-dir`
 * and find's prune drop a root of that name, while rg and fd keep a root that
 * their exclusions match, so they record no mentions.
 */
const EXCLUDE = `mentioned() {
  name=$1; shift
  for mention; do
    case $mention in
      =$name) return 0 ;;
      :*) case " \${mention#:} " in *[!A-Za-z0-9._-]$name[!A-Za-z0-9._-]*) return 0 ;; esac ;;
    esac
  done
  return 1
}
mention_roots() {
  for root; do
    root=\${root%"\${root##*[!/]}"}
    quote "=\${root##*/}"; mentions="$mentions $quoted"
  done
}
exclude() {
  [ $# -gt 0 ] || set -- .
  candidates="$names
$(ignored_names "$@")"
  excluded=
  for name in $candidates; do
    eval "mentioned \\"\\$name\\" $mentions" || excluded="$excluded
$name"
  done
}`;

/**
 * The options of a program whose command line is options and operands: a
 * short cluster reads letter by letter, where a letter that takes a value
 * takes the rest of its argument or the next one; a long option takes its
 * value after `=` or as the next argument; options may follow operands until
 * `--`. `arms` are `case` arms run for each option, with the option in $1,
 * its value in $2, and 1 in $3 when the value was a separate argument. The
 * walk leaves the position of that `--` in $ended.
 */
interface OptionGrammar {
  readonly shortWithValue: string;
  readonly longWithValue: readonly string[];
  readonly arms: string;
}

const GREP_GRAMMAR: OptionGrammar = {
  shortWithValue: "ABCDdefm",
  longWithValue: ["--after-context", "--before-context", "--context", "--max-count", "--devices", "--directories", "--include", "--exclude", "--exclude-dir", "--exclude-from", "--label", "--binary-files", "--group-separator", "--regexp", "--file"],
  arms: `-r|-R|--recursive|--dereference-recursive) recursive=1 ;;
    -d|--directories) [ "$2" = recurse ] && recursive=1 ;;
    -e|-f|--regexp|--file) first_is_path=1 ;;`,
};

/**
 * Each program's grammar, and the statement that adds its exclusions when the
 * walk of its options is done. Operands are in $first and $positionals as
 * quoted words; the first one is the search pattern unless $first_is_path.
 */
const PROGRAMS = {
  grep: { grammar: GREP_GRAMMAR, finish: grepFinish() },
  egrep: { grammar: GREP_GRAMMAR, finish: grepFinish() },
  fgrep: { grammar: GREP_GRAMMAR, finish: grepFinish() },
  // With no path, rg searches a standard input that is a pipe, file, or
  // socket, and the directory otherwise; a filter of a pipe pays no git call.
  // A later -g wins over an earlier one, so the exclusions follow the
  // person's options, where a broad include such as `-g '**'` cannot undo
  // them, and precede the `--` that ends the options, after which a -g would
  // be a path.
  rg: {
    grammar: {
      shortWithValue: "efEmjgdtTABCMr",
      longWithValue: ["--regexp", "--file", "--encoding", "--max-count", "--threads", "--glob", "--max-depth", "--type", "--type-not", "--after-context", "--before-context", "--context", "--max-columns", "--replace", "--pre", "--pre-glob", "--dfa-size-limit", "--engine", "--regex-size-limit", "--iglob", "--ignore-file", "--max-filesize", "--type-add", "--type-clear", "--color", "--colors", "--context-separator", "--field-context-separator", "--field-match-separator", "--hostname-bin", "--hyperlink-format", "--path-separator", "--sort", "--sortr", "--generate"],
      arms: "-e|-f|--regexp|--file|--files) first_is_path=1 ;;",
    },
    finish: `[ "$first_is_path" = 1 ] && positionals="$first$positionals"
if [ -n "$positionals" ] || { [ ! -p /dev/stdin ] && [ ! -f /dev/stdin ] && [ ! -S /dev/stdin ]; }; then
  eval "exclude $positionals"
  globs=
  for name in $excluded; do quote "!$name/"; globs="$globs -g $quoted"; done
  rebuilt= index=0
  for arg; do
    index=$((index + 1))
    [ "$index" = "$ended" ] && rebuilt="$rebuilt$globs"
    quote "$arg"; rebuilt="$rebuilt $quoted"
  done
  [ -z "$ended" ] && rebuilt="$rebuilt$globs"
  eval "set -- $rebuilt"
fi`,
  },
  fd: {
    grammar: {
      shortWithValue: "dEteSoxXjCc",
      longWithValue: ["--and", "--max-depth", "--min-depth", "--exact-depth", "--exclude", "--type", "--extension", "--size", "--changed-within", "--change-newer-than", "--newer", "--changed-after", "--changed-before", "--change-older-than", "--older", "--owner", "--format", "--exec", "--exec-batch", "--batch-size", "--ignore-file", "--color", "--ignore-contain", "--threads", "--max-results", "--max-buffer-time", "--base-directory", "--path-separator", "--search-path"],
      arms: `-C|--base-directory) base=$2 ;;
    --search-path) quote "$2"; positionals="$positionals $quoted" ;;`,
    },
    finish: `eval "exclude $positionals"
for name in $excluded; do set -- -E "$name/" "$@"; done`,
  },
} as const satisfies { readonly [P in Exclude<PrunedProgram, "find">]: { readonly grammar: OptionGrammar; readonly finish: string } };

/**
 * grep prunes only a recursive search, so a filter of a pipe pays no git
 * call. With no operand, a recursive grep searches the current directory.
 */
function grepFinish(): string {
  return `if [ "$recursive" = 1 ]; then
  [ "$first_is_path" = 1 ] && positionals="$first$positionals"
  eval "mention_roots $positionals; exclude $positionals"
  for name in $excluded; do set -- "--exclude-dir=$name" "$@"; done
fi`;
}

/**
 * The walk over the options and operands of `grammar`. An option that makes
 * the program run a command (`exempt`) lifts the limit. As fd reads it, a
 * command in a separate argument takes every argument up to `;`, and an
 * attached one (`-xPROG`, `--exec=PROG`) only itself.
 */
function walkOptions(grammar: OptionGrammar, exempt: readonly string[]): string {
  const exemptArm = exempt.length > 0 ? `\n    ${exempt.join("|")}) limit=0 command=\${3:-0} ;;` : "";
  return `option() {
  case $1 in
    ${grammar.arms}${exemptArm}
  esac
}
first_is_path=0 recursive=0 options=1 pending= command=0 first= positionals= index=0 ended=
for arg; do
  index=$((index + 1))${exempt.length > 0 ? `
  if [ "$command" = 1 ]; then [ "$arg" = ';' ] && command=0; continue; fi` : ""}
  if [ -n "$pending" ]; then option "$pending" "$arg" 1; pending=; continue; fi
  if [ "$options" = 1 ]; then
    case $arg in
      --) options=0 ended=$index; continue ;;
      --*=*) option "\${arg%%=*}" "\${arg#*=}"; continue ;;
      ${grammar.longWithValue.join("|")}) pending=$arg; continue ;;
      --*) option "$arg"; continue ;;
      -?*)
        letters=\${arg#-}
        while [ -n "$letters" ]; do
          letter=\${letters%"\${letters#?}"}
          letters=\${letters#?}
          case $letter in
            [${grammar.shortWithValue}]) if [ -n "$letters" ]; then option "-$letter" "$letters"; letters=; else pending=-$letter; fi ;;
            *) option "-$letter" ;;
          esac
        done
        continue ;;
    esac
  fi
  quote "$arg"
  if [ -z "$first" ]; then first=" $quoted"; else positionals="$positionals $quoted"; fi
done`;
}

/**
 * find gets a clause ahead of its expression. In the usual top-down order it
 * prunes: `( -type d ( -name A -o ... ) -prune -false ) -o ( EXPR )`, with
 * `-true` for an empty expression. Depth-first order (`-depth`, a leading
 * `-d`, or `-delete`) visits a directory's contents before the directory, so
 * `-prune` has no effect there and GNU find refuses it with `-delete`; the
 * clause filters the output instead: `! ( -type d ( -name A -o ... ) -o -path
 * P -o ... ) ( EXPR )`, where each P matches the paths below one pruned name.
 * It is an AND, so neither EXPR nor the implicit `-print` acts on a pruned
 * entry. Global options move ahead of the clause, where GNU find expects
 * them. The operands of a primary and the command of `-exec` and its kin
 * stay in place, so an operand spelled like an option never moves. BSD
 * `-depth n` is a test, not depth-first order, and BSD `-f PATH` names a root.
 */
function findExclusions(exempt: readonly string[]): string {
  return `lead= roots= paths= hoisted= expression= state=lead pending= operands=0 name_test=0 command=0 previous= depth=0 depth_first=0
for arg; do
  quote "$arg"
  if [ "$command" = 1 ]; then
    expression="$expression $quoted"
    case $arg in ';') command=0 ;; +) [ "$previous" = '{}' ] && command=0 ;; esac
    previous=$arg
    continue
  fi
  if [ "$operands" -gt 0 ]; then
    expression="$expression $quoted"; operands=$((operands - 1))
    if [ "$name_test" = 1 ]; then name_test=0; quote ":$arg"; mentions="$mentions $quoted"; fi
    continue
  fi
  case $pending in
    lead) lead="$lead $quoted"; pending=; continue ;;
    root) lead="$lead $quoted"; roots="$roots $quoted"; pending=; continue ;;
    hoisted) hoisted="$hoisted $quoted"; pending=; continue ;;
  esac
  if [ "$depth" = 1 ]; then
    depth=0
    case $arg in
      [0-9]*|[-+][0-9]*) expression="$expression -depth $quoted"; continue ;;
      *) hoisted="$hoisted -depth"; depth_first=1 ;;
    esac
  fi
  if [ "$state" = lead ]; then
    case $arg in
      -d) lead="$lead $quoted"; depth_first=1; continue ;;
      -[EHLPXsx]|-O*) lead="$lead $quoted"; continue ;;
      -D) lead="$lead $quoted"; pending=lead; continue ;;
      -f) lead="$lead $quoted"; pending=root; continue ;;
      --) lead="$lead $quoted"; state=paths; continue ;;
    esac
    state=paths
  fi
  if [ "$state" = paths ]; then
    case $arg in
      -?*|'('|'!'|')'|,) state=expression ;;
      *) paths="$paths $quoted"; continue ;;
    esac
  fi
  case $arg in
    -maxdepth|-mindepth|-files0-from) hoisted="$hoisted $quoted"; pending=hoisted ;;
    -depth|-d) depth=1 ;;
    -mount|-xdev|-noleaf|-ignore_readdir_race|-noignore_readdir_race) hoisted="$hoisted $quoted" ;;
    ${exempt.join("|")}) expression="$expression $quoted"; command=1 previous= limit=0 ;;
    -delete) expression="$expression $quoted"; depth_first=1 ;;
    -fprintf) expression="$expression $quoted"; operands=2 ;;
    -name|-iname|-path|-ipath|-wholename|-iwholename|-regex|-iregex) expression="$expression $quoted"; operands=1 name_test=1 ;;
    -lname|-ilname|-newer*|-anewer|-cnewer|-type|-xtype|-perm|-user|-group|-uid|-gid|-size|-links|-inum|-samefile|-[acmB]time|-[acmB]min|-used|-fstype|-context|-printf|-fprint|-fprint0|-fls|-regextype|-flags|-mnewer)
      expression="$expression $quoted"; operands=1 ;;
    *) expression="$expression $quoted" ;;
  esac
done
[ "$depth" = 1 ] && hoisted="$hoisted -depth" && depth_first=1
eval "mention_roots $roots $paths; exclude $roots $paths"
if [ -n "$excluded" ]; then
  names_clause= paths_clause=
  for name in $excluded; do
    quote "$name"; names_clause="$names_clause\${names_clause:+ -o} -name $quoted"
    quote "*/$name/*"; paths_clause="$paths_clause -o -path $quoted"
  done
  if [ "$depth_first" = 1 ]; then
    eval "set -- $lead $paths $hoisted '!' '(' -type d '(' $names_clause ')' $paths_clause ')' '(' \${expression:- -true} ')'"
  else
    eval "set -- $lead $paths $hoisted '(' -type d '(' $names_clause ')' -prune -false ')' -o '(' \${expression:- -true} ')'"
  fi
fi`;
}

function prunes(program: ShellSearchProgram): program is PrunedProgram {
  return SHELL_SEARCH_RULES[program].prunes;
}

/** The exclusions of `program`: the walk of its arguments, then the rewrite of "$@". */
function exclusions(program: PrunedProgram, exempt: readonly string[]): string {
  if (program === "find") return findExclusions(exempt);
  const { grammar, finish } = PROGRAMS[program];
  return `${walkOptions(grammar, exempt)}\n${finish}`;
}

/**
 * The limit and exit translation every shim ends with. A shell reports a
 * child that a signal ended on its own stderr, and dash can print that report
 * after a redirection of the command ends. So the waiting shell keeps its
 * stderr on /dev/null for the rest of its life, and the original stderr waits
 * on a spare descriptor for the program and the shim's message, which
 * replaces the report. The spare is the highest of 3 to 9 that the caller left
 * closed, so every descriptor the caller passed reaches the program
 * unchanged. dash knows no descriptor above 9, so when the caller holds all
 * of 3 to 9 the shim leaves stderr alone, and the shell's one-line report
 * then shows ahead of the message.
 */
function runUnderLimit(program: ShellSearchProgram, exempt: boolean): string {
  const limited = `ulimit -S -t ${SEARCH_CPU_LIMIT_SECONDS}`;
  return [
    exempt ? `if [ "$limit" = 0 ]; then exec "$real" "$@"; fi` : undefined,
    "spare=",
    `for fd in 9 8 7 6 5 4 3; do { true >&$fd; } 2>/dev/null || { spare=$fd; break; }; done`,
    `if [ -n "$spare" ]; then`,
    `  eval "exec $spare>&2 2>/dev/null"`,
    `  (${limited}; eval "exec 2>&$spare $spare>&-"; exec "$real" "$@")`,
    "else",
    `  (${limited}; exec "$real" "$@")`,
    "fi",
    "status=$?",
    `if [ "$status" -eq ${CPU_LIMIT_STATUS} ]; then printf '%s\\n' ${quoteBashSingle(shellSearchStoppedMessage(program))} >&"\${spare:-2}"; exit 2; fi`,
    `exit "$status"`,
  ].filter((line) => line !== undefined).join("\n");
}

/** The text of the shim of `program`, which runs `real`. */
function renderSearchShim(program: ShellSearchProgram, real: string, git: string | undefined): string {
  const exempt: readonly string[] = SHELL_SEARCH_RULES[program].cpuLimitExemptWith;
  const pruning = !prunes(program) ? [] : [
    "set -f",
    "IFS='\n'",
    `names=${quoteBashSingle(PRUNED_DIR_NAMES.map(escapeGlob).join("\n"))}`,
    "base=. mentions=",
    QUOTE,
    ignoredNames(git),
    EXCLUDE,
    exclusions(program, exempt),
  ];
  return [
    "#!/bin/sh",
    `# Generated by Flywheel: the search rules of ${program} (ARCH-TOOLS-052).`,
    `real=${quoteBashSingle(real)}`,
    ...(exempt.length > 0 ? ["limit=1"] : []),
    ...pruning,
    runUnderLimit(program, exempt.length > 0),
    "",
  ].join("\n");
}

/**
 * Writes the shims of the search programs that `basePath` resolves into
 * `<scratchDir>/search-shims/<hash of their text>` and returns that folder, or
 * undefined when `basePath` holds none of them. A program absent from
 * `basePath` gets no shim, so the shell reports it missing as before. An
 * installed shim is never rewritten: other text gets another folder.
 */
export async function installSearchShims(operations: Pick<BashOperations, "ensureDir" | "writeExecutable">, scratchDir: string, basePath: string): Promise<string | undefined> {
  const git = Bun.which("git", { PATH: basePath }) ?? undefined;
  const shims = SHELL_SEARCH_PROGRAMS.flatMap((program) => {
    const real = Bun.which(program, { PATH: basePath });
    return real === null ? [] : [{ program, text: renderSearchShim(program, real, git) }];
  });
  if (shims.length === 0) return undefined;
  const hash = createHash("sha256");
  for (const { program, text } of shims) hash.update(`${program}\0${text}\0`);
  const directory = join(scratchDir, SEARCH_SHIMS_DIR, hash.digest("hex").slice(0, 16));
  operations.ensureDir(directory);
  for (const { program, text } of shims) {
    const path = join(directory, program);
    if (!existsSync(path)) await operations.writeExecutable(path, text);
  }
  return directory;
}
