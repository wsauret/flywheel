import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, realpath, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { captureCampaignEventSearch, resolveCampaignSubject } from "../../../bench/chat-ab/campaign-subject.js";
import type { LauncherScope } from "../../../src/infra/process-supervisor.js";
import { structuredIdentity } from "../../../src/orchestration/modules/development/benchmark/content-identity.js";
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

/** Put a synthetic claude binary first on PATH for `body`. */
async function withClaudeOnPath(body: (binary: string, resolvedBinary: string, directory: string) => Promise<void>) {
  const directory = temporary("campaign-subject-");
  const binary = join(directory, "version");
  await writeFile(binary, "synthetic version binary");
  await chmod(binary, 0o700);
  // Windows resolves a command on PATH only through an executable extension, as the native claude.exe.
  await symlink(binary, join(directory, process.platform === "win32" ? "claude.exe" : "claude"));
  const path = process.env.PATH;
  try {
    process.env.PATH = directory;
    await body(binary, await realpath(binary), directory);
  } finally {
    if (path === undefined) delete process.env.PATH;
    else process.env.PATH = path;
  }
}
const settings = { model: "claude-sonnet-5.5", effort: "medium", authProfile: "Personal" } as const;
const binarySha256 = createHash("sha256").update("synthetic version binary").digest("hex");

test("pins the real version binary and refuses changed bytes without a paid preflight", async () => {
  await withClaudeOnPath(async (binary, resolvedBinary, directory) => {
    const { run, calls } = fakeOwnedCommandRunner(() => Promise.resolve(ownedCommandResult("2.1.296 (Claude Code)\n")));
    const resolved = await resolveCampaignSubject({ subject: "claude-code" }, settings, run);
    const identity = { subject: "claude-code", binaryPath: resolvedBinary, binarySha256, binaryVersion: "2.1.296 (Claude Code)", model: "claude-sonnet-5-5", effort: "medium" } as const;
    expect(resolved.identity).toEqual(identity);
    const prepared = await resolved.prepare(join(directory, "unused"));
    expect(prepared.isolationAgent).toEqual({ kind: "claude-code" });
    expect(prepared.environment).toEqual({});
    expect(prepared.confinement(["/scratch/hidden"])).toMatchObject({ hidden: [], own: [], readonly: [resolvedBinary] });
    const settingsIdentity = await prepared.preflight({
      launcher: { open: () => { throw new Error("no paid preflight"); }, spawnOwned: async () => { throw new Error("no paid preflight"); }, adoptOwned: async () => { throw new Error("no adoption"); }, close: async () => ({ settled: true }) },
      projectRoot: directory, artifactDir: directory, env: {}, wrapCommand: (command) => command,
    });
    expect(settingsIdentity).toBe(structuredIdentity(identity));
    expect(prepared.record("candidate", settingsIdentity)).toEqual({ id: "candidate", ...identity, settingsIdentity });
    expect(calls).toHaveLength(1);
    await prepared.validate();
    await writeFile(binary, "changed version binary");
    await expect(prepared.validate()).rejects.toThrow("binary changed");
  });
});

test("pins a plugin revision in the treatment identity and refuses a revision without the plugin builder", async () => {
  await withClaudeOnPath(async () => {
    const commit = "c".repeat(40);
    const answer = (builder: boolean) => fakeOwnedCommandRunner(async (command) => {
      if (command[0] !== "git") return ownedCommandResult("2.1.296 (Claude Code)\n");
      if (command[1] === "cat-file") return ownedCommandResult("", builder ? 0 : 128);
      return ownedCommandResult(command[1] === "rev-parse" ? `${commit}\n` : "");
    });
    const { run } = answer(true);
    const resolved = await resolveCampaignSubject({ subject: "claude-code", plugin: "HEAD" }, settings, run);
    expect(resolved.identity).toMatchObject({ subject: "claude-code", binarySha256, plugin: { revision: commit } });
    await expect(resolveCampaignSubject({ subject: "claude-code", plugin: "HEAD" }, settings, answer(false).run))
      .rejects.toThrow(`Plugin revision HEAD (${commit}) has no scripts/build-claude-plugin.ts`);
  });
});
