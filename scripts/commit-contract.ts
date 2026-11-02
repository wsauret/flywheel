/** The changelog commit contract, in code.
 *
 *  The `ship` skill (src/agent-skills/ship/SKILL.md) states the contract
 *  for authors: `<type>(<scope>)?: <subject>`, where a feat, fix, or perf
 *  subject reads as a standalone release-note entry and a `Changelog:` trailer
 *  carries the user-facing sentence when it differs from the engineering
 *  subject. This module is the one machine reading of that contract: the CI
 *  gate (`check`) and the release-note generator (`notes`) both parse with it,
 *  so a message the gate accepts is a message the generator understands.
 *
 * Usage:
 *   bun run scripts/commit-contract.ts check --base <sha> --head <sha>
 *   printf "%s\n" "<header>" "" "<body>" | bun run scripts/commit-contract.ts check-message
 *   bun run scripts/commit-contract.ts notes --surface terminal|vscode --version 1.4.2 [--out <file>]
 */

import { compareSemanticVersions, parseSemanticVersion } from "./release-version.js";

/** Type vocabulary and the release-note section each type publishes under.
 *  A null section is an engineering-facing type the changelog excludes. */
export const COMMIT_TYPES = {
  feat: "Added",
  fix: "Fixed",
  perf: "Performance",
  docs: null,
  refactor: null,
  test: null,
  chore: null,
  release: null,
} as const;

export type CommitType = keyof typeof COMMIT_TYPES;
export type ReleaseSurface = "terminal" | "vscode";
export type CommitSurface = ReleaseSurface | "shared";

export interface ReleaseCommit {
  readonly hash: string;
  readonly message: string;
  readonly files: readonly string[];
}

const HEADER = /^(feat|fix|perf|docs|refactor|test|chore|release)(?:\(([a-z0-9][a-z0-9.-]*)\))?(!)?: (.+)$/;
const CHANGELOG_TRAILER = /^Changelog: (.+)$/m;
const BREAKING_PARAGRAPH = /^BREAKING CHANGE: ([\s\S]+?)(?:\n\n|$)/m;

export interface ParsedCommit {
  readonly type: CommitType;
  readonly scope: string | undefined;
  readonly breaking: boolean;
  readonly subject: string;
  /** The `Changelog:` trailer's user-facing sentence, when present. */
  readonly changelog: string | undefined;
  /** The `BREAKING CHANGE:` paragraph, when present. */
  readonly breakingNote: string | undefined;
}

/** Tool-generated messages git writes itself; the contract does not bind them
 *  and the generator ignores them. */
export function isExemptMessage(message: string): boolean {
  const header = message.split("\n", 1)[0] ?? "";
  return header.startsWith("Merge ") || header.startsWith("Revert ");
}

function isCommitType(value: string): value is CommitType {
  return value in COMMIT_TYPES;
}

export function parseCommitMessage(message: string): ParsedCommit | undefined {
  const header = message.split("\n", 1)[0] ?? "";
  const match = HEADER.exec(header);
  if (match === null) return undefined;
  const [, type = "", scope, bang, subject = ""] = match;
  if (!isCommitType(type)) return undefined;
  return {
    type,
    scope,
    breaking: bang === "!",
    subject,
    changelog: CHANGELOG_TRAILER.exec(message)?.[1]?.trim(),
    breakingNote: BREAKING_PARAGRAPH.exec(message)?.[1]?.trim().replace(/\s+/g, " "),
  };
}

const VSCODE_ONLY_SCOPES = new Set(["vscode", "ide"]);
const TERMINAL_ONLY_SCOPES = new Set(["tui", "cli"]);
const HISTORICAL_VSCODE_COMMITS = new Set([
  "5814bd1798739446830958636a64331baff65907",
  "3da322d6a6cfae5f6430571a1891f359ae411d43",
]);


/** Classify where a user can observe one commit. Product scopes are the
 * user-facing authority. Paths fill in unscoped work, while two exact legacy
 * commits preserve the extension boundary from before surface scopes settled. */
export function classifyReleaseSurface(commit: ReleaseCommit): CommitSurface {
  const parsed = parseCommitMessage(commit.message);
  if (HISTORICAL_VSCODE_COMMITS.has(commit.hash)) return "vscode";
  if (parsed?.scope !== undefined && VSCODE_ONLY_SCOPES.has(parsed.scope)) return "vscode";
  if (parsed?.scope !== undefined && TERMINAL_ONLY_SCOPES.has(parsed.scope)) return "terminal";
  if (commit.files.length > 0 && commit.files.every((file) => file.startsWith("vscode/"))) return "vscode";
  if (
    commit.files.length > 0 &&
    commit.files.every((file) => file.startsWith("src/tui/") || /^tests\/(?:unit|integration)\/tui\//.test(file))
  ) {
    return "terminal";
  }
  return "shared";
}

export function releaseCommitsForSurface<T extends ReleaseCommit>(commits: readonly T[], surface: ReleaseSurface): T[] {
  return commits.filter((commit) => {
    const owner = classifyReleaseSurface(commit);
    return owner === "shared" || owner === surface;
  });
}

/** Every way one message violates the contract; an empty list is a pass. */
export function validateCommitMessage(message: string): string[] {
  if (isExemptMessage(message)) return [];
  const parsed = parseCommitMessage(message);
  if (parsed === undefined) {
    return [`the header does not parse as <type>(<scope>)?: <subject> with a type in {${Object.keys(COMMIT_TYPES).join(", ")}}`];
  }
  const reasons: string[] = [];
  if (/^[A-Z]/.test(parsed.subject)) reasons.push("the subject starts with an uppercase letter; the contract states lowercase imperative");
  if (parsed.subject.endsWith(".")) reasons.push("the subject ends with a period; the contract states no trailing period");
  if (parsed.breaking && parsed.breakingNote === undefined) reasons.push("the type carries `!` but the body has no `BREAKING CHANGE:` paragraph saying what breaks");
  if (!parsed.breaking && parsed.breakingNote !== undefined) reasons.push("the body has a `BREAKING CHANGE:` paragraph but the type carries no `!`");
  return reasons;
}

function presentEntry(text: string): string {
  const trimmed = text.trim().replace(/\.$/, "");
  return trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
}

/** Compose the public release-note body from full commit messages, newest
 *  first. Exempt and unparsable messages are the caller's to filter or count;
 *  this function reads only messages the contract parses. */
export function composeReleaseNotes(messages: readonly string[]): string {
  const parsed = messages.map(parseCommitMessage).filter((commit): commit is ParsedCommit => commit !== undefined);
  const sections: [string, string[]][] = [
    ["Breaking changes", parsed.filter((commit) => commit.breaking).map((commit) => presentEntry(commit.breakingNote ?? commit.changelog ?? commit.subject))],
    ...(["Added", "Fixed", "Performance"] as const).map((section): [string, string[]] => [
      section,
      parsed
        .filter((commit) => !commit.breaking && COMMIT_TYPES[commit.type] === section)
        .map((commit) => presentEntry(commit.changelog ?? commit.subject)),
    ]),
  ];
  const body = sections
    .filter(([, entries]) => entries.length > 0)
    .map(([title, entries]) => `## ${title}\n\n${entries.map((entry) => `- ${entry}`).join("\n")}`)
    .join("\n\n");
  return body === "" ? "No user-facing changes in this release." : body;
}

function commitDetails(message: string): string {
  const details = message
    .split("\n")
    .slice(1)
    .filter((line) => !/^(?:Changelog|Claude-Session|Co-Authored-By|Signed-off-by|Reviewed-by):/i.test(line.trim()))
    .join("\n")
    .trim();
  return details || "No additional commit context.";
}

function changedPathEvidence(files: readonly string[]): string {
  const shown = files.slice(0, 20);
  const omitted = files.length - shown.length;
  return [...shown.map((file) => `  - ${file}`), ...(omitted > 0 ? [`  - ${omitted} more path(s)`] : [])].join("\n");
}

/** Compose evidence for the rewrite model. Unlike the terse public changelog,
 * this preserves surface, scope, rationale, and paths so the model can explain
 * how a behavior changed without inventing implementation details. */
export function composeReleaseEvidence(commits: readonly ReleaseCommit[]): string {
  return commits
    .map((commit) => ({ commit, parsed: parseCommitMessage(commit.message) }))
    .filter(({ parsed }) => parsed !== undefined && (parsed.breaking || COMMIT_TYPES[parsed.type] !== null))
    .map(({ commit, parsed }) => {
      if (parsed === undefined) return "";
      const section = parsed.breaking ? "Breaking changes" : COMMIT_TYPES[parsed.type];
      const change = parsed.breaking ? parsed.breakingNote ?? parsed.changelog ?? parsed.subject : parsed.changelog ?? parsed.subject;
      return [
        `## ${section}`,
        `Commit: ${commit.hash}`,
        `Surface: ${classifyReleaseSurface(commit)}`,
        `Scope: ${parsed.scope ?? "unscoped"}`,
        `Change: ${presentEntry(change)}`,
        "Rationale and mechanism:",
        commitDetails(commit.message),
        "Changed paths:",
        changedPathEvidence(commit.files),
      ].join("\n");
    })
    .filter((entry) => entry !== "")
    .join("\n\n");
}

interface RangeCommit {
  readonly hash: string;
  readonly message: string;
}

function gitLog(range: readonly string[]): RangeCommit[] {
  const result = Bun.spawnSync(["git", "log", "--format=%H%x1f%B%x1e", ...range], { windowsHide: true });
  if (result.exitCode !== 0) throw new Error(`git log ${range.join(" ")} failed: ${result.stderr.toString().trim()}`);
  return result.stdout
    .toString()
    .split("\x1e")
    .map((record) => record.trim())
    .filter((record) => record !== "")
    .map((record) => {
      const [hash = "", message = ""] = record.split("\x1f");
      return { hash, message: message.trim() };
    });
}

function changedFiles(hash: string): string[] {
  const result = Bun.spawnSync(["git", "show", "--format=", "--name-only", hash], { windowsHide: true });
  if (result.exitCode !== 0) throw new Error(`git show ${hash} failed: ${result.stderr.toString().trim()}`);
  return result.stdout.toString().split("\n").map((file) => file.trim()).filter((file) => file !== "");
}

function resolvedRange(base: string | undefined, head: string): readonly string[] {
  // A push that creates a ref reports an all-zero base, and a shallow or
  // rewritten history can lose the base commit; both fall back to the head
  // commit alone rather than failing the gate on commits it cannot see.
  //
  // The fallback is two arguments, not one string holding a space: these reach
  // git through an argument list that performs no word splitting, so a joined
  // "HEAD -1" arrives as a single revision and git rejects it.
  if (base === undefined || base === "" || /^0+$/.test(base)) return [head, "-1"];
  const probe = Bun.spawnSync(["git", "rev-parse", "--verify", "--quiet", `${base}^{commit}`], { windowsHide: true });
  return probe.exitCode === 0 ? [`${base}..${head}`] : [head, "-1"];
}

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

function upstreamCommit(): string | undefined {
  const result = Bun.spawnSync(["git", "rev-parse", "--verify", "--quiet", "@{upstream}"], { windowsHide: true });
  if (result.exitCode !== 0) return undefined;
  const commit = result.stdout.toString().trim();
  return commit === "" ? undefined : commit;
}

/** Validates one draft message read from stdin, before any commit exists. */
async function runCheckMessage(): Promise<void> {
  const reasons = validateCommitMessage((await Bun.stdin.text()).trim());
  for (const reason of reasons) console.error(`  ${reason}`);
  if (reasons.length > 0) {
    console.error("\nThe draft message violates the repository changelog contract (AGENTS.md, Hard Rules).");
    process.exit(1);
  }
  console.log("The draft message satisfies the changelog contract.");
}

function runCheck(): void {
  const head = argument("--head") ?? "HEAD";
  const base = argument("--base") ?? (process.argv.includes("--upstream") ? upstreamCommit() : undefined);
  const commits = gitLog(resolvedRange(base, head));
  const failures = commits
    .map((commit) => ({ commit, reasons: validateCommitMessage(commit.message) }))
    .filter(({ reasons }) => reasons.length > 0);
  for (const { commit, reasons } of failures) {
    const header = commit.message.split("\n", 1)[0];
    console.error(`${commit.hash.slice(0, 9)} ${header}`);
    for (const reason of reasons) console.error(`  ${reason}`);
  }
  if (failures.length > 0) {
    console.error(`\n${failures.length} of ${commits.length} commit message(s) violate the repository changelog contract (AGENTS.md, Hard Rules).`);
    process.exit(1);
  }
  console.log(`${commits.length} commit message(s) satisfy the changelog contract.`);
}

export function previousReleaseTag(version: string, surface: ReleaseSurface): string | undefined {
  const current = parseSemanticVersion(version);
  if (current === undefined) throw new Error(`--version ${version} is not a strict major.minor.patch release`);
  const prefix = surface === "terminal" ? "v" : "vscode-v";
  const tags = Bun.spawnSync(["git", "tag", "--list", `${prefix}*`], { windowsHide: true }).stdout.toString().split("\n");
  const older = tags
    .map((tag) => parseSemanticVersion(tag.trim().slice(prefix.length)))
    .filter((candidate): candidate is NonNullable<typeof candidate> => candidate !== undefined)
    .filter((candidate) => compareSemanticVersions(candidate, current) < 0)
    .sort(compareSemanticVersions);
  const previous = older.at(-1);
  return previous === undefined ? undefined : `${prefix}${previous.canonical}`;
}

export interface CollectedReleaseEvidence {
  readonly baseTag: string | undefined;
  readonly head: string;
  readonly evidence: string;
}

export function collectReleaseEvidence(version: string, surface: ReleaseSurface): CollectedReleaseEvidence {
  const baseTag = previousReleaseTag(version, surface);
  const headResult = Bun.spawnSync(["git", "rev-parse", "HEAD"], { stdout: "pipe", stderr: "pipe", windowsHide: true });
  if (headResult.exitCode !== 0) throw new Error(`git rev-parse HEAD failed: ${headResult.stderr.toString().trim()}`);
  const head = headResult.stdout.toString().trim();
  const commits = gitLog([baseTag === undefined ? head : `${baseTag}..${head}`]).filter((commit) => !isExemptMessage(commit.message));
  const unparsable = commits.filter((commit) => parseCommitMessage(commit.message) === undefined);
  if (unparsable.length > 0) console.error(`${unparsable.length} commit(s) predate or violate the contract and are excluded from the notes.`);
  const withFiles = commits.map((commit): ReleaseCommit => ({ ...commit, files: changedFiles(commit.hash) }));
  return { baseTag, head, evidence: composeReleaseEvidence(releaseCommitsForSurface(withFiles, surface)) };
}

function releaseSurface(value: string | undefined): ReleaseSurface {
  if (value === "terminal" || value === "vscode") return value;
  throw new Error("no valid --surface was stated; use terminal or vscode");
}

async function runNotes(): Promise<void> {
  const version = argument("--version");
  if (version === undefined) throw new Error("no --version was stated");
  const surface = releaseSurface(argument("--surface"));
  const collected = collectReleaseEvidence(version, surface);
  const out = argument("--out");
  if (out === undefined) console.log(collected.evidence);
  else await Bun.write(out, `${collected.evidence}\n`);
}

if (import.meta.main) {
  const command = process.argv[2];
  if (command === "check") runCheck();
  else if (command === "check-message") await runCheckMessage();
  else if (command === "notes") await runNotes();
  else throw new Error(`unknown command ${JSON.stringify(command)}; state check, check-message, or notes`);
}
