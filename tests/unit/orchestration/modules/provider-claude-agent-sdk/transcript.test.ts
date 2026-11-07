import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { temporaryDirectories } from "../../../../helpers/directories.js";
import type { CliMessage, PlacedReminder } from "../../../../../src/orchestration/modules/provider-claude-agent-sdk/cli-view.js";
import { canonicalShell } from "../../../../../src/orchestration/agent-runtime/llm/claude-reminders.js";
import { processHolders } from "../../../../../src/infra/process-holder.js";
import { bridgeSessionId } from "../../../../../src/orchestration/modules/provider-claude-agent-sdk/session-id.js";
import { cliProjectSlug, lockSession, removeTranscript, sweepLeftBehindSessions, transcriptFiles, transcriptRows, writeTranscript, type TranscriptClock } from "../../../../../src/orchestration/modules/provider-claude-agent-sdk/transcript.js";

const temporaryDirectory = temporaryDirectories();
const SESSION = "9d3b72e1-0000-8000-8000-000000000001";
const NOW = new Date("2026-10-07T21:52:47.792Z");
const DAY_MS = 24 * 60 * 60_000;

function clock(): TranscriptClock {
  let next = 0;
  return { now: NOW, newUuid: () => `row-${++next}` };
}

const ENVIRONMENT: PlacedReminder["reminder"] = { kind: "environment", workingDirectory: "/work/a", isWorktree: false, isGitRepo: true, platform: "darwin", shell: "zsh", osVersion: "Darwin 25.3.0" };
const WINDOWS_ENVIRONMENT: PlacedReminder["reminder"] = { kind: "environment", workingDirectory: "C:\\work\\a", isWorktree: false, isGitRepo: true, platform: "win32", shell: "PowerShell", osVersion: "Windows 11 Pro 10.0.26100" };
const MODEL: PlacedReminder["reminder"] = {
  kind: "model", modelId: "claude-sonnet-5-5", displayName: "Sonnet 5.5", knowledgeCutoff: "June 2026",
  // The row holds the identity only, so the engine words the reminder itself; this text never reaches the row.
  text: "Flywheel's own model reminder text.",
};
const SIGNED = { type: "thinking", thinking: "Step one.\n Step two. é\u{1F600}", signature: "Eo8BCkYI+/=\nAB" } as const;
const HISTORY: CliMessage[] = [
  { role: "user", content: [{ type: "text", text: "U1" }] },
  { role: "assistant", content: [SIGNED, { type: "text", text: "Reading." }, { type: "tool_use", id: "toolu_1", name: "mcp__runtime__read", input: { path: "a" } }] },
  { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: [{ type: "text", text: "R1" }] }, { type: "text", text: "U2" }] },
  { role: "assistant", content: [{ type: "text", text: "Done." }] },
];
interface RowFields { readonly type: string; readonly [field: string]: unknown }
const row = (uuid: number, fields: RowFields) => ({
  parentUuid: uuid === 1 ? null : `row-${uuid - 1}`, isSidechain: false, uuid: `row-${uuid}`, timestamp: NOW.toISOString(), sessionId: SESSION, ...fields,
});

describe("the rotation transcript", () => {
  test("writes the rows in the format that the CLI resumes from", () => {
    const rows = transcriptRows({
      sessionId: SESSION, model: "claude-sonnet-5-5", history: HISTORY,
      reminders: [{ message: 0, reminder: { kind: "date", date: "2026-10-06", changed: false } }, { message: 0, reminder: MODEL }, { message: 0, reminder: ENVIRONMENT },
        { message: 2, reminder: { kind: "date", date: "2026-10-07", changed: true } }],
    }, clock());
    const usage = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
    expect<unknown>(rows).toEqual([
      row(1, { type: "user", message: { role: "user", content: [{ type: "text", text: "U1" }] } }),
      row(2, { type: "attachment", attachment: { type: "environment", snapshot: {
        workingDirectory: "/work/a", isWorktree: false, isGitRepo: true, additionalWorkingDirectories: [], platform: "darwin", shell: "zsh", osVersion: "Darwin 25.3.0",
      } }, rendered: [] }),
      row(3, { type: "attachment", attachment: { type: "model", identity: { modelId: "claude-sonnet-5-5", marketingName: "Sonnet 5.5", knowledgeCutoff: "June 2026" } }, rendered: [] }),
      row(4, { type: "attachment", attachment: { type: "date", date: "2026-10-06" }, rendered: [] }),
      row(5, { type: "assistant", message: { id: "msg_rotation_1", type: "message", role: "assistant", model: "claude-sonnet-5-5", content: HISTORY[1]!.content, stop_reason: "tool_use", stop_sequence: null, usage } }),
      row(6, { type: "user", message: { role: "user", content: HISTORY[2]!.content }, sourceToolAssistantUUID: "row-5", toolUseResult: [{ type: "text", text: "R1" }] }),
      row(7, { type: "attachment", attachment: { type: "date", date: "2026-10-07", changed: true }, rendered: [] }),
      row(8, { type: "assistant", message: { id: "msg_rotation_3", type: "message", role: "assistant", model: "claude-sonnet-5-5", content: HISTORY[3]!.content, stop_reason: "end_turn", stop_sequence: null, usage } }),
    ]);
    // The CLI resends stored blocks with their key order, and its own tool result starts with `tool_use_id`.
    expect(JSON.stringify(rows[5])).toContain('"content":[{"tool_use_id":"toolu_1","type":"tool_result","content":[{"type":"text","text":"R1"}]},{"type":"text","text":"U2"}]');
    // The CLI sends the previous request id back to the service, so a computed row never names one.
    expect(rows.some((written) => "requestId" in written)).toBe(false);
  });

  test("adds the account context next to the environment and carries the environment through an update", () => {
    const rows = transcriptRows({
      sessionId: SESSION, model: "claude-sonnet-5-5", history: [HISTORY[0]!, HISTORY[3]!, { role: "user", content: [{ type: "text", text: "U3" }] }], accountEmail: "person@example.com",
      reminders: [{ message: 0, reminder: ENVIRONMENT }, { message: 0, reminder: MODEL }, { message: 2, reminder: { kind: "environment-update", workingDirectory: "/work/b", isGitRepo: false } }],
    }, clock());
    const attachments = rows.flatMap((written) => (written.type === "attachment" ? [written.attachment] : []));
    expect(attachments.map((attachment) => attachment.type)).toEqual(["environment", "model", "session_context", "environment"]);
    expect(attachments[2]).toEqual({ type: "session_context", context: { userEmail: expect.stringMatching(/^The user's email address is person@example\.com\. Use it only to identify the user/u) } });
    expect(attachments[3]).toEqual({ type: "environment",
      snapshot: { workingDirectory: "/work/b", isWorktree: false, isGitRepo: false, additionalWorkingDirectories: [], platform: "darwin", shell: "zsh", osVersion: "Darwin 25.3.0" },
      changes: [{ field: "workingDirectory", from: "/work/a" }, { field: "isGitRepo" }] });
    expect(() => transcriptRows({ sessionId: SESSION, model: "m", history: [HISTORY[0]!], reminders: [{ message: 0, reminder: { kind: "environment-update", isWorktree: true } }] }, clock()))
      .toThrow("an environment update reminder precedes the environment reminder");
  });

  test("states the shell that the engine names in every environment row, and the reminder's shell when the engine names that one", () => {
    const shells = (shell?: string) => transcriptRows({
      sessionId: SESSION, model: "claude-sonnet-5-5", history: [HISTORY[0]!, HISTORY[3]!, { role: "user", content: [{ type: "text", text: "U3" }] }],
      reminders: [{ message: 0, reminder: WINDOWS_ENVIRONMENT }, { message: 2, reminder: { kind: "environment-update", workingDirectory: "/work/b" } }],
      ...(shell === undefined ? {} : { shell }),
    }, clock()).flatMap((written) => (written.type === "attachment" && written.attachment.type === "environment" ? [written.attachment.snapshot.shell] : []));
    expect(shells("bash")).toEqual(["bash", "bash"]);
    expect(shells()).toEqual(["PowerShell", "PowerShell"]);
  });

  test("states this host's shell for a reminder that an agent without the shell read, as the engine names its own", () => {
    const unshelled: PlacedReminder["reminder"] = { kind: "environment", workingDirectory: "/work/a", isWorktree: false, isGitRepo: true, platform: "darwin", osVersion: "Darwin 25.3.0" };
    const shells = transcriptRows({ sessionId: SESSION, model: "claude-sonnet-5-5", history: [HISTORY[0]!], reminders: [{ message: 0, reminder: unshelled }] }, clock())
      .flatMap((written) => (written.type === "attachment" && written.attachment.type === "environment" ? [written.attachment.snapshot.shell] : []));
    expect(shells).toEqual([canonicalShell()]);
  });

  test("writes a thinking-only answer with one orphan carrier block that the CLI keeps at load and removes before the wire", () => {
    const thinkingOnly: CliMessage = { role: "assistant", content: [SIGNED, { type: "redacted_thinking", data: "opaque" }] };
    const rows = transcriptRows({
      sessionId: SESSION, model: "claude-sonnet-5-5", history: [HISTORY[0]!, thinkingOnly, { role: "user", content: [{ type: "text", text: "U2" }] }, HISTORY[3]!],
      reminders: [{ message: 0, reminder: ENVIRONMENT }],
    }, clock());
    expect(rows.map((written) => written.type)).toEqual(["user", "attachment", "assistant", "user", "assistant"]);
    const answer = rows[2];
    expect(answer?.type === "assistant" ? answer.message : undefined).toMatchObject({
      id: "msg_rotation_1", stop_reason: "end_turn",
      content: [SIGNED, { type: "redacted_thinking", data: "opaque" }, { type: "server_tool_use", id: "srvtoolu_rotation_carrier_1", name: "code_execution", input: {} }],
    });
    // An answer with any other block needs no carrier.
    const last = rows[4];
    expect(last?.type === "assistant" ? last.message.content : undefined).toEqual(HISTORY[3]!.content);
  });

  test("names the project directory as the CLI does", () => {
    expect(cliProjectSlug("/Users/me/my project.v2")).toBe("-Users-me-my-project-v2");
    // The CLI keeps 200 characters and adds the base-36 absolute value of its 32-bit string hash (all.js `RI`).
    // The hash of the second path is negative.
    for (const [end, hash] of [["end", "9mhqp3"], ["x", "hvko3g"]]) {
      const long = `/work/${"deep/".repeat(45)}${end}`;
      expect(cliProjectSlug(long)).toBe(`${long.replace(/[^a-zA-Z0-9]/gu, "-").slice(0, 200)}-${hash}`);
    }
  });

  test("writes the transcript privately where the CLI looks and keeps signed thinking byte for byte", () => {
    const config = temporaryDirectory("flywheel-sdk-transcript-");
    const cwd = join(config, "work");
    mkdirSync(cwd);
    const rows = transcriptRows({ sessionId: SESSION, model: "claude-sonnet-5-5", history: HISTORY, reminders: [] }, clock());
    const written = writeTranscript(config, cwd, SESSION, rows);

    expect(written).toEqual({ sessionId: SESSION, path: join(config, "projects", cliProjectSlug(realpathSync(cwd)), `${SESSION}.jsonl`), resumeAt: "row-4" });
    const text = readFileSync(written.path, "utf8");
    expect(text.endsWith("}\n")).toBe(true);
    expect(text).toContain(JSON.stringify(SIGNED));
    const parsed: unknown = text.split("\n").filter(Boolean).map((line) => JSON.parse(line));
    expect(parsed).toEqual(JSON.parse(JSON.stringify(rows)));
    if (process.platform !== "win32") expect(statSync(written.path).mode & 0o777).toBe(0o600);
  });

  test("removes the project directory that it created for a transcript, and only while the directory holds nothing else", () => {
    const config = temporaryDirectory("flywheel-sdk-remove-");
    const rows = transcriptRows({ sessionId: SESSION, model: "claude-sonnet-5-5", history: HISTORY, reminders: [] }, clock());
    const project = (cwd: string) => join(config, "projects", cliProjectSlug(realpathSync(cwd)));
    const cwd = (name: string) => {
      const path = join(config, name);
      mkdirSync(path);
      return path;
    };

    const alone = cwd("alone");
    removeTranscript(writeTranscript(config, alone, SESSION, rows));
    expect(existsSync(project(alone))).toBe(false);

    // The CLI and the person's own sessions share `projects/`: a directory with anything else in it stays.
    const shared = cwd("shared");
    const written = writeTranscript(config, shared, SESSION, rows);
    writeFileSync(join(project(shared), "6f1d4f7c-2b1a-4c8e-9f3a-1b2c3d4e5f60.jsonl"), "{}\n");
    removeTranscript(written);
    expect([existsSync(written.path), readdirSync(project(shared))]).toEqual([false, ["6f1d4f7c-2b1a-4c8e-9f3a-1b2c3d4e5f60.jsonl"]]);

    // Two bridges rotate in one project at once. The directory goes with the last of their transcripts, whichever
    // bridge created it.
    const concurrent = cwd("concurrent");
    const creator = writeTranscript(config, concurrent, SESSION, rows);
    const second = writeTranscript(config, concurrent, bridgeSessionId(), rows);
    removeTranscript(creator);
    expect(readdirSync(project(concurrent))).toEqual([basename(second.path)]);
    removeTranscript(second);
    expect(existsSync(project(concurrent))).toBe(false);

    // A directory that was there before the transcript stays, even when the removal leaves it empty.
    const existing = cwd("existing");
    mkdirSync(project(existing), { recursive: true });
    removeTranscript(writeTranscript(config, existing, SESSION, rows));
    expect(readdirSync(project(existing))).toEqual([]);
  });

  test("writing a transcript removes the bridge sessions whose owner is proven gone, and nothing else", () => {
    const config = temporaryDirectory("flywheel-sdk-sweep-");
    const cwd = join(config, "work");
    mkdirSync(cwd);
    const project = join(config, "projects", cliProjectSlug(realpathSync(cwd)));
    mkdirSync(project, { recursive: true });
    const boot = NOW.getTime() - 10 * DAY_MS;
    const age = (path: string, ms: number) => {
      const seconds = (NOW.getTime() - ms) / 1000;
      utimesSync(path, seconds, seconds);
    };
    const transcript = (id: string, ageMs: number) => {
      const path = join(project, `${id}.jsonl`);
      writeFileSync(path, "{}\n");
      age(path, ageMs);
      return path;
    };
    // A shared agent host's session: its transcript and its folder of agent files.
    const host = (id: string, ageMs: number) => {
      const agents = join(project, id, "subagents");
      mkdirSync(agents, { recursive: true });
      const agentFile = join(agents, "agent-a0123456789abcdef.jsonl");
      writeFileSync(agentFile, "{}\n");
      for (const path of [agentFile, agents, join(project, id)]) age(path, ageMs);
      return [join(project, id), transcript(id, ageMs)];
    };
    const lockOf = (id: string) => join(config, "session-locks", `${id}.lock`);
    // A lock that a process left which no longer runs: the pid now runs another process.
    const goneHolder = (id: string) => {
      const { boot: bootId } = processHolders.own() ?? expect.unreachable("the kernel did not give this test process its identity");
      mkdirSync(join(config, "session-locks"), { recursive: true });
      writeFileSync(lockOf(id), JSON.stringify({ pid: process.pid, owner: "gone", v: 1, start: "1", ...(bootId === undefined ? {} : { boot: bootId }) }));
    };

    // A live owner's session stays at any age, also when its newest write is before the boot.
    const lockedId = bridgeSessionId();
    const unlock = lockSession(config, lockedId);
    const locked = [...host(lockedId, 30 * DAY_MS), transcript(bridgeSessionId(), 0)];
    const lockedTranscriptId = basename(locked[2]!, ".jsonl");
    const unlockTranscript = lockSession(config, lockedTranscriptId);
    // A session whose lock a gone process left is reclaimed, however fresh.
    const goneHostId = bridgeSessionId();
    goneHolder(goneHostId);
    const goneHost = host(goneHostId, 0);
    const goneTranscriptId = bridgeSessionId();
    goneHolder(goneTranscriptId);
    const goneTranscript = transcript(goneTranscriptId, 0);
    // Also when its artifacts are in another project directory of the login, and a lock whose owner ended before its
    // engine wrote anything goes as well.
    const elsewhereId = bridgeSessionId();
    goneHolder(elsewhereId);
    const elsewhere = join(config, "projects", "-elsewhere", `${elsewhereId}.jsonl`);
    mkdirSync(join(config, "projects", "-elsewhere"));
    writeFileSync(elsewhere, "{}\n");
    goneHolder(bridgeSessionId());
    // Remove with the lockless rule after 2027-02-01: sessions of a build without locks are reclaimed only when they
    // were last written before the boot, and kept when written since, whatever their age.
    const beforeBoot = [...host(bridgeSessionId(), 11 * DAY_MS), transcript(bridgeSessionId(), 11 * DAY_MS), transcript("464c5957-1a2b-8c3d-9e4f-0a1b2c3d4e5f", 11 * DAY_MS)];
    const sinceBoot = [...host(bridgeSessionId(), 9 * DAY_MS), transcript(bridgeSessionId(), 9 * DAY_MS)];
    // The person's own sessions and other files stay.
    const person = transcript("6f1d4f7c-2b1a-4c8e-9f3a-1b2c3d4e5f60", 30 * DAY_MS);
    const personFolder = join(project, "6f1d4f7c-2b1a-4c8e-9f3a-1b2c3d4e5f60");
    mkdirSync(personFolder);
    age(personFolder, 30 * DAY_MS);
    const other = join(project, `${bridgeSessionId()}.txt`);
    writeFileSync(other, "{}\n");
    age(other, 30 * DAY_MS);
    const rows = transcriptRows({ sessionId: SESSION, model: "claude-sonnet-5-5", history: HISTORY, reminders: [] }, clock());

    try {
      const written = writeTranscript(config, cwd, SESSION, rows, transcriptFiles, boot);
      expect([...locked, ...sinceBoot, person, personFolder, other, written.path].filter((path) => !existsSync(path))).toEqual([]);
      expect([...goneHost, goneTranscript, elsewhere, ...beforeBoot].filter(existsSync)).toEqual([]);
      // Lock files are no sessions: the live owners' locks stay, and each lock that the sweep took is gone with its session.
      expect(readdirSync(join(config, "session-locks")).toSorted()).toEqual([`${lockedId}.lock`, `${lockedTranscriptId}.lock`].toSorted());
    } finally {
      unlock();
      unlockTranscript();
    }
  });

  test("a sweep takes no lock on a lockless session written since the boot, so a sweep that crashes leaves no proof of a gone owner for it", () => {
    const config = temporaryDirectory("flywheel-sdk-sweep-");
    const cwd = join(config, "work");
    mkdirSync(cwd);
    const project = join(config, "projects", cliProjectSlug(realpathSync(cwd)));
    mkdirSync(join(project, bridgeSessionId(), "subagents"), { recursive: true });
    // A file where the lock directory belongs, so any lock that the sweep tries fails on every platform; a directory
    // without write permission would not stop a lock on Windows.
    writeFileSync(join(config, "session-locks"), "");
    expect(() => { sweepLeftBehindSessions(config, cwd, transcriptFiles, NOW.getTime() - DAY_MS); }).not.toThrow();
    expect(readdirSync(project)).toHaveLength(1);
  });
});
