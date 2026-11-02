/** Compose the release notes: the mechanical changelog from commit history,
 *  rewritten into product voice by one preset model invocation through
 *  Flywheel's own headless task mode. The mid tier respects the source
 *  profile's enabled models. Refine the surface-specific prompts by rerunning the matching `notes:draft`
 *  command until the output reads right. Binary and Marketplace publication
 *  use the same script with independent release tags and prompts.
 *
 *  Usage: bun run scripts/release-notes.ts --surface terminal|vscode [--version <x.y.z>] [--out <path>]
 */

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { collectReleaseEvidence, type ReleaseSurface } from "./commit-contract.js";
import { createReleaseNotesManifest } from "./release-notes-manifest.js";
import { latestReleaseTag } from "./release-repo.js";
import { parseSemanticVersion } from "./release-version.js";
import { AuthProfileManager } from "../src/orchestration/auth/auth-profile-manager.js";

// The preset invocation is shared; each publication surface owns its prompt.
// Not the cheap tier: on 2026-10-28 it refused an 860-commit extension range
// as too large to reconcile without omissions.
const NOTES_MODEL = "mid";
const NOTES_EFFORT = "medium";
// The reconciliation pass reads every changelog entry since the last release,
// and for v0.1.0 (over 1,100 commits) it took 250 to 300 s, so the bound leaves
// room for a large release rather than for a typical one.
const NOTES_DEADLINE_SECONDS = 900;
const NOTES_RESULT_CONTRACT = `Return only one JSON object, with no code fence or commentary.
On success, return {"status":"success","notes":"<release notes markdown>"}.
The notes must start with one summary paragraph, followed by nonempty sections headed exactly "## Added", "## Fixed", "## Changed", or "## Performance". Separate the summary, headings, and bullet lists with blank lines. Use only "- " bullet entries, one line per entry, in each section.
If you cannot produce release notes, return {"status":"refused","reason":"<reason>"} instead. Never put a refusal or other commentary in a success result.`;

const ROOT = join(import.meta.dir, "..");
const VALUE_FLAGS = new Set(["--surface", "--version", "--out"]);

function fail(reason: string): never {
  console.error(`release-notes: ${reason}`);
  process.exit(1);
}

/** Parse argv into the two known flags; any unknown argument, repeated flag,
 *  or flag without a value is an error rather than a silent default. */
function readArguments(argv: readonly string[]) {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === undefined) continue;
    if (!VALUE_FLAGS.has(flag)) fail(`unknown argument ${JSON.stringify(flag)}; state --surface terminal|vscode, --version <x.y.z>, or --out <path>`);
    if (values.has(flag)) fail(`${flag} may be given once`);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) fail(`${flag} requires a value`);
    values.set(flag, value);
    index += 1;
  }
  const surface = values.get("--surface");
  const version = values.get("--version");
  const out = values.get("--out");
  return { surface, ...(version === undefined ? {} : { version }), ...(out === undefined ? {} : { out }) };
}

function parseSurface(value: string | undefined): ReleaseSurface {
  if (value === "terminal" || value === "vscode") return value;
  fail("state --surface terminal or --surface vscode");
}

async function resolveVersion(explicit: string | undefined, surface: ReleaseSurface): Promise<string> {
  if (explicit !== undefined) {
    if (parseSemanticVersion(explicit) === undefined) fail(`${explicit} is not a strict MAJOR.MINOR.PATCH version`);
    return explicit;
  }
  if (surface === "vscode") {
    const manifest: unknown = await Bun.file(join(ROOT, "vscode", "package.json")).json();
    if (typeof manifest !== "object" || manifest === null || !("version" in manifest) || typeof manifest.version !== "string") {
      fail("vscode/package.json has no version");
    }
    if (parseSemanticVersion(manifest.version) === undefined) fail(`the extension version ${manifest.version} is not strict MAJOR.MINOR.PATCH`);
    return manifest.version;
  }
  const latest = await latestReleaseTag();
  if (latest === undefined) return "0.0.1";
  const parsed = parseSemanticVersion(latest.replace(/^v/, ""));
  if (parsed === undefined) fail(`the latest release ${latest} is not a strict vMAJOR.MINOR.PATCH release`);
  return `${parsed.major}.${parsed.minor}.${parsed.patch + 1}`;
}

/** Decode a model success result followed by the headless task JSON summary.
 * Returns an error for incomplete tasks, refusals, or Markdown outside the
 * release-note grammar. Task completion alone does not authorize publication. */
export function extractNotes(stdout: string): { notes: string } | { error: string } {
  const trimmed = stdout.trimEnd();
  const summaryStart = trimmed.lastIndexOf("\n");
  const summaryLine = trimmed.slice(summaryStart + 1);
  let summary: unknown;
  try {
    summary = JSON.parse(summaryLine);
  } catch {
    return { error: "the invocation output does not end with the JSON summary line" };
  }
  if (typeof summary !== "object" || summary === null || !("termination" in summary)) {
    return { error: "the trailing JSON line is not the headless task summary" };
  }
  const termination: unknown = summary.termination;
  const kind =
    typeof termination === "object" && termination !== null && "terminal" in termination &&
    typeof termination.terminal === "object" && termination.terminal !== null && "kind" in termination.terminal
      ? termination.terminal.kind
      : undefined;
  if (kind !== "completed") return { error: `the headless task terminated as ${JSON.stringify(kind)}, not completed` };
  const body = (summaryStart === -1 ? "" : trimmed.slice(0, summaryStart)).trim();
  if (body === "") return { error: "the model returned no notes text" };
  let result: unknown;
  try {
    result = JSON.parse(body);
  } catch {
    return { error: "the model did not return a release-notes JSON result" };
  }
  if (typeof result !== "object" || result === null || !("status" in result)) {
    return { error: "the model did not return an explicit release-notes success result" };
  }
  if (result.status === "refused") return { error: "the model refused to generate release notes" };
  if (result.status !== "success" || !("notes" in result) || typeof result.notes !== "string") {
    return { error: "the model did not return an explicit release-notes success result" };
  }
  const notes = result.notes.trim();
  const [overview, ...sections] = notes.split(/\n[ \t]*\n/);
  if (
    overview === undefined || overview === "" || /^[ \t]*(?:#{1,6}(?:[ \t]|$)|[-*+][ \t])/m.test(overview) ||
    sections.length < 2 || sections.length % 2 !== 0 ||
    !sections.every((block, index) => index % 2 === 0
      ? /^## (Added|Fixed|Changed|Performance)$/.test(block)
      : block.split("\n").every((line) => /^- \S.*$/.test(line)))
  ) {
    return { error: "the model result is not release notes: expected a summary and nonempty release-note sections" };
  }
  return { notes };
}

export function releaseNotesHeadlessArgs(scratchRoot: string, authProfileId: string, task: string): readonly string[] {
  return [
    "--project-root", scratchRoot,
    "--auth-profile", authProfileId,
    "--headless",
    "--task", task,
    "--model", NOTES_MODEL,
    "--effort", NOTES_EFFORT,
    "--deadline-seconds", String(NOTES_DEADLINE_SECONDS),
  ];
}

export interface ReleaseNotesInvocation {
  readonly exitCode: number;
  readonly stdout: { toString(): string };
}

interface ReleaseNotesInput {
  readonly sourceRoot: string;
  readonly surface: ReleaseSurface;
  readonly version: string;
  readonly outFile: string;
  readonly collected: {
    readonly evidence: string;
    readonly head: string;
    readonly baseTag: string | undefined;
  };
  readonly prompt: string;
  readonly reconciliationPrompt: string;
}

interface ReleaseNotesBoundaries {
  readonly resolveAuthProfileId: (sourceRoot: string) => string;
  readonly createScratchProject: () => string;
  readonly invoke: (scratchRoot: string, authProfileId: string, task: string) => ReleaseNotesInvocation;
}

/** The evidence file both calls read in the scratch project. */
export const RELEASE_EVIDENCE_FILE = "release-evidence.md";

/** Draft and reconcile release notes through one isolated headless project.
 * The source project selects credentials. Publication occurs only after both
 * calls complete and their output passes strict extraction. The evidence is a
 * file in that project, not part of a task: a task is one command-line
 * argument, which the platform bounds (1 MB on macOS, 128 KB on Linux), and a
 * long release range exceeds it. */
export async function runReleaseNotes(input: ReleaseNotesInput, boundaries: ReleaseNotesBoundaries): Promise<string> {
  const authProfileId = boundaries.resolveAuthProfileId(input.sourceRoot);
  const scratchRoot = boundaries.createScratchProject();
  // The absolute path, because the agent resolves a relative one against its
  // execution directory, which is the source checkout, not the scratch project.
  const evidenceFile = join(scratchRoot, RELEASE_EVIDENCE_FILE);
  const evidence = `Release evidence: read the file ${evidenceFile} in full before you answer. It holds every commit this release covers, newest first.`;
  let reconciled: string;
  try {
    await Bun.write(evidenceFile, input.collected.evidence);
    const draftInvocation = boundaries.invoke(
      scratchRoot,
      authProfileId,
      `${input.prompt}\n\n${evidence}\n\n${NOTES_RESULT_CONTRACT}`,
    );
    if (draftInvocation.exitCode !== 0) throw new Error(`the draft model invocation failed (exit ${draftInvocation.exitCode})`);
    const draft = extractNotes(draftInvocation.stdout.toString());
    if ("error" in draft) throw new Error(draft.error);

    const reconciliationInvocation = boundaries.invoke(
      scratchRoot,
      authProfileId,
      `${input.reconciliationPrompt}\n\n${evidence}\n\nDraft release notes:\n\n${draft.notes}\n\n${NOTES_RESULT_CONTRACT}`,
    );
    if (reconciliationInvocation.exitCode !== 0) {
      throw new Error(`the reconciliation model invocation failed (exit ${reconciliationInvocation.exitCode})`);
    }
    const extracted = extractNotes(reconciliationInvocation.stdout.toString());
    if ("error" in extracted) throw new Error(extracted.error);
    reconciled = extracted.notes;
  } finally {
    rmSync(scratchRoot, { recursive: true, force: true });
  }

  const notes = `${reconciled}\n`;
  mkdirSync(dirname(input.outFile), { recursive: true });
  await Bun.write(input.outFile, notes);
  if (input.surface === "vscode") {
    const manifest = createReleaseNotesManifest(
      {
        surface: input.surface,
        releaseVersion: input.version,
        head: input.collected.head,
        baseTag: input.collected.baseTag,
      },
      notes,
    );
    await Bun.write(join(dirname(input.outFile), "release-notes.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  }
  return reconciled;
}

if (import.meta.main) {
  const options = readArguments(process.argv.slice(2));
  const surface = parseSurface(options.surface);
  const version = await resolveVersion(options.version, surface);
  const outFile = options.out ?? (surface === "terminal" ? join(ROOT, "dist", "release-notes.md") : join(ROOT, "vscode", "dist", "release-notes.md"));

  const collected = collectReleaseEvidence(version, surface);
  const changelog = collected.evidence;
  if (changelog === "") fail(`the mechanical changelog is empty: no user-facing ${surface} commits since the last ${surface} release`);

  const promptFile = surface === "terminal" ? "release-notes-terminal-prompt.md" : "release-notes-vscode-prompt.md";
  const prompt = await Bun.file(join(ROOT, "scripts", promptFile)).text();
  const reconciliationPrompt = await Bun.file(join(ROOT, "scripts", "release-notes-reconciliation-prompt.md")).text();

  console.error(`release-notes: rewriting the ${surface} v${version} changelog with ${NOTES_MODEL} (${NOTES_EFFORT})...`);
  let notes: string;
  try {
    notes = await runReleaseNotes(
      { sourceRoot: ROOT, surface, version, outFile, collected, prompt, reconciliationPrompt },
      {
        resolveAuthProfileId: (sourceRoot) =>
          new AuthProfileManager({ userDataRoot: join(homedir(), ".flywheel"), projectRoot: sourceRoot }).inspect().id,
        createScratchProject: () => mkdtempSync(join(tmpdir(), "flywheel-release-notes-")),
        invoke: (scratchRoot, authProfileId, task) =>
          Bun.spawnSync(
            [join(ROOT, "bin", "flywheel"), ...releaseNotesHeadlessArgs(scratchRoot, authProfileId, task)],
            { cwd: ROOT, stdout: "pipe", stderr: "inherit", windowsHide: true },
          ),
      },
    );
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
  console.error(`release-notes: wrote ${outFile}`);
  console.log(notes);
}