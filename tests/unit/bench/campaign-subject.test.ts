import { expect, test } from "bun:test";
import { chmod, realpath, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { captureCampaignEventSearch, resolveCampaignSubject } from "../../../bench/chat-ab/campaign-subject.js";
import type { LauncherScope } from "../../../src/infra/process-supervisor.js";
import { temporaryDirectories } from "../../helpers/directories.js";
import { fakeOwnedCommandRunner, ownedCommandResult } from "../../helpers/owned-command-fake.js";
import { challengeConversationEvidence } from "../../../bench/chat-ab/challenge-reply.js";

const temporary = temporaryDirectories();

test("captures only root assistant text appended after the challenge position", () => {
  const row = (position: number, sessionId: string, kind: "user" | "assistant", content: unknown) => ({
    source: "store", sessionId, position, type: "chat.entries.appended", version: 3, actor: "flywheel",
    payload: { conversationId: "root", entries: [{ kind: "message", id: `entry-${position}`, parentId: null, timestamp: "2026-10-22T00:00:00Z", message: { kind, content } }] },
  });
  const rows = [
    row(10, "root", "assistant", [{ type: "text", text: "Before challenge" }]),
    row(11, "root", "user", "The challenge"),
    row(12, "child", "assistant", [{ type: "text", text: "Child output" }]),
    row(13, "root", "assistant", [{ type: "thinking", thinking: "private" }, { type: "tool_use", id: "tool", name: "read", input: {} }, { type: "text", text: "I checked the producer." }]),
    row(14, "root", "assistant", "The design holds."),
    row(15, "root", "assistant", [{ type: "tool_use", id: "question", name: "ask_user", input: { context: "The lock must stay exclusive." } }]),
  ].map(value => JSON.stringify(value)).join("\n");
  expect(challengeConversationEvidence(rows, "root", 10)).toEqual({ position: 15, text: "I checked the producer.\n\nThe design holds.\n\nThe lock must stay exclusive." });
  expect(challengeConversationEvidence("", "root")).toEqual({ position: 0, text: "" });
  expect(() => challengeConversationEvidence("private", "root")).toThrow("subject challenge reply evidence failed validation");
});

test("streams public step searches larger than the command buffer before cleanup", async () => {
  const directory = temporary("campaign-search-");
  const transcript = `${JSON.stringify({ payload: { entries: [{ content: "x".repeat(1_100_000) }] } })}\n`;
  const handoff = `${JSON.stringify({ payload: { definitionId: "spec-create", content: { summary: "done" } } })}\n`;
  const order: string[] = [];
  const scope: LauncherScope = {
    open: () => scope,
    adoptOwned: async () => { throw new Error("no adoption"); },
    close: async () => { order.push("closed"); return { settled: true }; },
    spawnOwned: async command => {
      const type = command[command.indexOf("--type") + 1]!;
      order.push(type);
      const exit = { code: 0, signal: null, statusOf: "payload" as const, ownership: "surrendered" as const };
      return {
        pid: 1, token: "search", stdin: undefined,
        stdout: new Blob([type === "handoff.written" ? handoff : transcript]).stream(),
        stderr: new Blob([]).stream(), exited: Promise.resolve(exit), terminate: async () => exit,
      };
    },
  };
  const input = { launcher: scope, commandPrefix: ["subject"], projectRoot: directory, env: {}, profile: "Personal", model: "claude-sonnet-5.5", effort: "medium" as const, artifactDir: directory };
  const handoffs = await captureCampaignEventSearch(input, "workflow", "handoff.written", join(directory, "handoffs.jsonl"));
  const chats = await captureCampaignEventSearch(input, "workflow", "chat.entries.appended", join(directory, "transcript.jsonl"));
  const cleanup = async () => {
    expect(await Bun.file(chats.stdout.path).text()).toBe(transcript);
    expect(await Bun.file(handoffs.stdout.path).text()).toBe(handoff);
    order.push("cleanup");
  };
  await cleanup();
  expect(chats.stdout.bytes).toBe(Buffer.byteLength(transcript));
  expect(chats.stdout.bytes).toBeGreaterThan(1_000_000);
  expect(order).toEqual(["handoff.written", "closed", "chat.entries.appended", "closed", "cleanup"]);
});

test("pins the real version binary and refuses changed bytes without a paid preflight", async () => {
  const directory = temporary("campaign-subject-");
  const binary = join(directory, "version");
  await writeFile(binary, "synthetic version binary");
  await chmod(binary, 0o700);
  // Windows resolves a command on PATH only through an executable extension, as the native claude.exe.
  await symlink(binary, join(directory, process.platform === "win32" ? "claude.exe" : "claude"));
  const resolvedBinary = await realpath(binary);
  const path = process.env.PATH;
  const { run, calls } = fakeOwnedCommandRunner(() => Promise.resolve(ownedCommandResult("2.1.296 (Claude Code)\n")));
  try {
    process.env.PATH = directory;
    const resolved = await resolveCampaignSubject({ subject: "claude-code" }, { model: "claude-sonnet-5.5", effort: "medium", authProfile: "Personal" }, run);
    expect(resolved.identity).toMatchObject({ subject: "claude-code", binaryPath: resolvedBinary, binaryVersion: "2.1.296 (Claude Code)", model: "claude-sonnet-5-5" });
    const prepared = await resolved.prepare(join(directory, "unused"));
    expect(prepared.isolationAgent).toEqual({ kind: "claude-code" });
    expect(prepared.environment).toEqual({});
    expect(prepared.confinement(["/scratch/hidden"])).toMatchObject({ hidden: [], own: [], readonly: [resolvedBinary] });
    const settingsIdentity = await prepared.preflight({
      launcher: { open: () => { throw new Error("no paid preflight"); }, spawnOwned: async () => { throw new Error("no paid preflight"); }, adoptOwned: async () => { throw new Error("no adoption"); }, close: async () => ({ settled: true }) },
      projectRoot: directory, artifactDir: directory, env: {}, wrapCommand: (command) => command,
    });
    expect(prepared.record("candidate", settingsIdentity)).toMatchObject({ subject: "claude-code", binaryPath: resolvedBinary });
    expect(calls).toHaveLength(1);
    await prepared.validate();
    await writeFile(binary, "changed version binary");
    await expect(prepared.validate()).rejects.toThrow("binary changed");
  } finally {
    if (path === undefined) delete process.env.PATH;
    else process.env.PATH = path;
  }
});
