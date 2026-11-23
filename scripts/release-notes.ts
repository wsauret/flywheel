/** Compose the release notes: one unattended Flywheel agent chat reads the
 *  mechanical changelog from commit history, verifies every claim against the
 *  code of the release, and writes the notes in product voice. The chat runs in
 *  a disposable checkout of the release head, so it reads the source that ships
 *  and runs git against the previous release tag. Binary and Marketplace
 *  publication use the same script with independent release tags and surface
 *  prompts; both share one method prompt.
 *
 *  Usage: bun run scripts/release-notes.ts --surface terminal|vscode [--version <x.y.z>] [--out <path>]
 */

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { Schema } from "effect";

import { collectReleaseEvidence, type ReleaseSurface } from "./commit-contract.js";
import { createReleaseNotesManifest } from "./release-notes-manifest.js";
import { latestReleaseTag } from "./release-repo.js";
import { parseSemanticVersion } from "./release-version.js";
import { AuthProfileManager } from "../src/orchestration/auth/auth-profile-manager.js";

// The strongest model at high effort, because no person audits the notes
// before publication. On 2026-11-23 the earlier design (two mid-tier calls that
// saw only commit messages) published a provider that the range had removed
// and about 25 unsupported claims in v0.1.4, because it could not read the code.
const NOTES_MODEL = "claude-opus-5.5";
const NOTES_EFFORT = "high";
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

/** Decode the agent's final message as a release-notes success result.
 * Returns an error for a refusal, other text, or Markdown outside the
 * release-note grammar. A finished turn alone does not authorize publication. */
export function extractNotes(message: string): { notes: string } | { error: string } {
  const body = message.trim();
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

/** The requests that the runner sends, in this order, in one notes chat. */
type AcpRequestBody =
  | { readonly method: "initialize"; readonly params: { readonly protocolVersion: 1; readonly clientCapabilities: { readonly [capability: string]: never } } }
  | { readonly method: "session/new"; readonly params: { readonly cwd: string; readonly mcpServers: readonly never[] } }
  | {
    readonly method: "session/set_config_option";
    readonly params: { readonly sessionId: string; readonly configId: "model" | "effort"; readonly value: string };
  }
  | { readonly method: "session/prompt"; readonly params: { readonly sessionId: string; readonly prompt: readonly [{ readonly type: "text"; readonly text: string }] } };

export type AcpRequest = { readonly jsonrpc: "2.0"; readonly id: number } & AcpRequestBody;

/** The parts of a chat message that the runner reads; other fields are ignored. */
const ChatMessageSchema = Schema.Struct({
  id: Schema.optionalKey(Schema.Unknown),
  method: Schema.optionalKey(Schema.String),
  params: Schema.optionalKey(Schema.Struct({
    update: Schema.optionalKey(Schema.Union([
      Schema.Struct({ sessionUpdate: Schema.Literal("agent_message_chunk"), content: Schema.Struct({ text: Schema.String }) }),
      Schema.Struct({ sessionUpdate: Schema.String }),
    ])),
  })),
  result: Schema.optionalKey(Schema.Struct({ sessionId: Schema.optionalKey(Schema.String), stopReason: Schema.optionalKey(Schema.String) })),
  error: Schema.optionalKey(Schema.Struct({
    message: Schema.String,
    data: Schema.optionalKey(Schema.Struct({ failure: Schema.optionalKey(Schema.String) })),
  })),
});

/** One Agent Client Protocol connection to a headless Flywheel chat. */
export interface AcpConnection {
  /** Write one JSON-RPC request. */
  readonly send: (message: AcpRequest) => void;
  /** Each newline-delimited message that the chat writes; ends when the chat exits. */
  readonly lines: AsyncIterable<string>;
  /** Stop the chat and wait for it to exit. */
  readonly close: () => Promise<void>;
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
  readonly methodPrompt: string;
}

interface ReleaseNotesBoundaries {
  readonly resolveAuthProfileId: (sourceRoot: string) => string;
  /** Check out `head` in a new directory outside the repository and return its path. */
  readonly createWorktree: (head: string) => string;
  readonly removeWorktree: (worktree: string) => void;
  readonly openChat: (worktree: string, authProfileId: string) => AcpConnection;
}

/** The evidence file that the chat reads in the worktree root. */
export const RELEASE_EVIDENCE_FILE = "release-evidence.md";

/** Run one prompt turn in a new chat and return the text of the agent's final
 *  message. Text before a tool call is narration, so each tool event discards
 *  the text collected until then. Fails on a refused request, a turn that does
 *  not end with `end_turn`, any request from the chat (an unattended chat has
 *  nobody to answer it), or a chat that exits before it answers. */
async function promptChat(chat: AcpConnection, cwd: string, task: string): Promise<string> {
  const lines = chat.lines[Symbol.asyncIterator]();
  let id = 0;
  let finalMessage = "";
  async function request(body: AcpRequestBody) {
    const { method } = body;
    id += 1;
    chat.send({ jsonrpc: "2.0", id, ...body });
    for (;;) {
      const next = await lines.next();
      if (next.done === true) throw new Error(`the notes chat exited before it answered ${method}`);
      if (next.value.trim() === "") continue;
      let json: unknown;
      try {
        json = JSON.parse(next.value);
      } catch {
        throw new Error(`the notes chat wrote a line that is not JSON during ${method}`);
      }
      const decoded = Schema.decodeUnknownOption(ChatMessageSchema)(json);
      if (decoded._tag === "None") throw new Error(`the notes chat wrote a message that is not ACP JSON-RPC during ${method}`);
      const message = decoded.value;
      if (message.method === "session/update") {
        const update = message.params?.update;
        if (update?.sessionUpdate === "tool_call" || update?.sessionUpdate === "tool_call_update") finalMessage = "";
        if (update !== undefined && "content" in update) finalMessage += update.content.text;
        continue;
      }
      if (message.method !== undefined || message.id !== id) {
        throw new Error(`the notes chat sent an unexpected ${message.method ?? "response"} during ${method}`);
      }
      if (message.error !== undefined) {
        const failure = message.error.data?.failure === undefined ? "" : ` (${message.error.data.failure})`;
        throw new Error(`the notes chat refused ${method}: ${message.error.message}${failure}`);
      }
      return message.result ?? {};
    }
  }

  await request({ method: "initialize", params: { protocolVersion: 1, clientCapabilities: {} } });
  const { sessionId } = await request({ method: "session/new", params: { cwd, mcpServers: [] } });
  if (sessionId === undefined) throw new Error("the notes chat opened no session");
  await request({ method: "session/set_config_option", params: { sessionId, configId: "model", value: NOTES_MODEL } });
  await request({ method: "session/set_config_option", params: { sessionId, configId: "effort", value: NOTES_EFFORT } });
  const answer = await request({ method: "session/prompt", params: { sessionId, prompt: [{ type: "text", text: task }] } });
  if (answer.stopReason !== "end_turn") throw new Error(`the notes turn stopped with ${JSON.stringify(answer.stopReason)}, not end_turn`);
  return finalMessage;
}

function releaseNotesTask(input: ReleaseNotesInput, evidenceFile: string): string {
  const { baseTag, head } = input.collected;
  const range = baseTag === undefined
    ? `There is no previous release: the release covers every commit up to the head commit ${head}.`
    : `The base tag is ${baseTag}, the previous release. The head commit is ${head}.`;
  const evidence = `Release evidence: the file ${evidenceFile} holds every commit that this release covers, newest first. Read it in full. ${range}`;
  return [input.prompt.trim(), input.methodPrompt.trim(), evidence, NOTES_RESULT_CONTRACT].join("\n\n");
}

/** Write the release notes from one unattended chat in a disposable checkout
 * of the release head. The source project selects credentials. Publication
 * occurs only after the turn ends normally and its final message passes strict
 * extraction. The evidence is a file in the checkout, not part of the prompt,
 * so the agent and its subagents read one copy. */
export async function runReleaseNotes(input: ReleaseNotesInput, boundaries: ReleaseNotesBoundaries): Promise<string> {
  const authProfileId = boundaries.resolveAuthProfileId(input.sourceRoot);
  const worktree = boundaries.createWorktree(input.collected.head);
  let finalMessage: string;
  try {
    const evidenceFile = join(worktree, RELEASE_EVIDENCE_FILE);
    await Bun.write(evidenceFile, input.collected.evidence);
    const chat = boundaries.openChat(worktree, authProfileId);
    try {
      finalMessage = await promptChat(chat, worktree, releaseNotesTask(input, evidenceFile));
    } finally {
      await chat.close();
    }
  } finally {
    boundaries.removeWorktree(worktree);
  }
  const extracted = extractNotes(finalMessage);
  if ("error" in extracted) throw new Error(extracted.error);

  const notes = `${extracted.notes}\n`;
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
  return extracted.notes;
}

async function* readLines(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const bytes of stream) {
    const lines = (buffer + decoder.decode(bytes, { stream: true })).split("\n");
    buffer = lines.pop() ?? "";
    yield* lines;
  }
  if (buffer !== "") yield buffer;
}

function git(args: readonly string[]): void {
  const result = Bun.spawnSync(["git", ...args], { cwd: ROOT, stdout: "pipe", stderr: "pipe", windowsHide: true });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString().trim()}`);
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
  const methodPrompt = await Bun.file(join(ROOT, "scripts", "release-notes-method-prompt.md")).text();

  console.error(`release-notes: writing and verifying the ${surface} v${version} notes with ${NOTES_MODEL} (${NOTES_EFFORT})...`);
  let notes: string;
  try {
    notes = await runReleaseNotes(
      { sourceRoot: ROOT, surface, version, outFile, collected, prompt, methodPrompt },
      {
        resolveAuthProfileId: (sourceRoot) =>
          new AuthProfileManager({ userDataRoot: join(homedir(), ".flywheel"), projectRoot: sourceRoot }).inspect().id,
        createWorktree: (head) => {
          const worktree = join(mkdtempSync(join(tmpdir(), "flywheel-release-notes-")), "source");
          git(["worktree", "add", "--quiet", "--detach", worktree, head]);
          return worktree;
        },
        // Cleanup never throws, so it cannot hide the error of the run; prune
        // drops the registration when `remove` failed and the directory is gone.
        removeWorktree: (worktree) => {
          Bun.spawnSync(["git", "worktree", "remove", "--force", worktree], { cwd: ROOT, stdout: "ignore", stderr: "inherit", windowsHide: true });
          rmSync(dirname(worktree), { recursive: true, force: true });
          Bun.spawnSync(["git", "worktree", "prune"], { cwd: ROOT, stdout: "ignore", stderr: "inherit", windowsHide: true });
        },
        openChat: (worktree, authProfileId) => {
          const child = Bun.spawn(
            [join(ROOT, "bin", "flywheel"), "--headless", "--acp", "--unattended", "--auth-profile", authProfileId, "--project-root", worktree],
            { cwd: worktree, stdin: "pipe", stdout: "pipe", stderr: "inherit", windowsHide: true },
          );
          return {
            send: (message) => {
              child.stdin.write(`${JSON.stringify(message)}\n`);
              void child.stdin.flush();
            },
            lines: readLines(child.stdout),
            close: async () => {
              child.kill();
              await child.exited;
            },
          };
        },
      },
    );
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
  console.error(`release-notes: wrote ${outFile}`);
  console.log(notes);
}
