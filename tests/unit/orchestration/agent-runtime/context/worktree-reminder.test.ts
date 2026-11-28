import { expect, test } from "bun:test";
import { mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { runAgentLoop } from "../../../../../src/orchestration/agent-runtime/loop/agent-loop.js";
import { createBackgroundExecutionOwner } from "../../../../../src/orchestration/agent-runtime/background-execution/background-execution-owner.js";
import { createBackgroundWorkRegistry } from "../../../../../src/orchestration/session/control/background-work/background-work.js";
import type { RuntimeTool } from "../../../../../src/orchestration/agent-runtime/tools/types.js";
import { stableSystemPrompt } from "../../../../../src/orchestration/agent-runtime/llm/system-prompt-tiers.js";
import { RequestToolMap } from "../../../../helpers/request-tool-surface.js";
import { temporaryDirectories } from "../../../../helpers/directories.js";
import { makeCaptureClient } from "./_loop-fixtures.js";

const temporary = temporaryDirectories();
const loopIdentity = { userDataRoot: "/scratch/.test-account", projectRoot: "/scratch", providerSessionKey: "worktree-reminder", promptCacheKey: "worktree-reminder", artifactScopeId: "worktree-reminder", retrievalSessionId: "worktree-reminder" };

/** A repository in which `add` registers one linked worktree as Git writes its metadata, so no Git process runs. */
function repositoryWithWorktree() {
  const base = realpathSync(temporary("worktree-reminder-"));
  const project = join(base, "project");
  const metadata = join(project, ".git", "worktrees", "wt");
  const worktree = join(base, "wt");
  mkdirSync(join(project, ".git"), { recursive: true });
  const add = () => {
    mkdirSync(metadata, { recursive: true });
    mkdirSync(worktree);
    writeFileSync(join(metadata, "gitdir"), join(worktree, ".git"));
    writeFileSync(join(metadata, "commondir"), "../..");
    writeFileSync(join(worktree, ".git"), `gitdir: ${metadata}\n`);
  };
  return { project, worktree, add, remove: () => { rmSync(worktree, { recursive: true, force: true }); rmSync(metadata, { recursive: true, force: true }); } };
}

const end = { events: [{ kind: "text_delta" as const, text: "Done.", blockKey: "text" }, { kind: "done" as const, stopReason: "end_turn" as const }] };

async function run(options: { readonly record: boolean; readonly removeBeforeEnd: boolean }) {
  const { project, worktree, add: addWorktree, remove } = repositoryWithWorktree();
  const { client, capturedMessages } = makeCaptureClient([
    { events: [{ kind: "tool_use", toolCall: { id: "tc_1", name: "add", input: {} } }, { kind: "done", stopReason: "tool_use" }] },
    end, end, end,
  ]);
  let turnEnds = 0;
  const registry = createBackgroundWorkRegistry({ kind: "chat", enqueueNotification: () => {} });
  const background = createBackgroundExecutionOwner(registry);
  // Stands in for a bash call of `git worktree add`, which the shell watches the same way; without the record, another session adds it.
  const add: RuntimeTool = { name: "add", action: "shell_exec", description: "adds a worktree", inputSchema: { type: "object" }, isConcurrencySafe: true, execute: async () => {
    const exited = options.record ? background.shell.worktrees.track("git worktree add ../wt", project) : undefined;
    addWorktree();
    exited?.();
    if (options.removeBeforeEnd) remove();
    return { content: "Preparing worktree", outcome: "ok" };
  } };
  const result = await runAgentLoop({
    client, tools: new RequestToolMap([[add.name, add]]), systemPrompt: stableSystemPrompt("test"), instruction: "check in a worktree",
    executionCwd: "/scratch", ...loopIdentity, completeOnIdle: {}, persistence: { history: { append: () => {} } }, seed: { kind: "fresh" },
    background, inputSource: { drainPending: () => null }, onEvent: () => {}, lifecycle: { onTurnEnded: () => { turnEnds++; } },
  });
  await background.close();
  const reminders = capturedMessages.flat().filter((message) => message.kind === "user" && typeof message.content === "string" && message.content.startsWith("[worktree reminder]"));
  return { result, requests: capturedMessages.length, turnEnds, worktree, reminders: [...new Set(reminders.map((message) => message.content))] };
}

test("a turn that ends over a worktree its commands created gets one reminder naming it, inside that turn", async () => {
  const kept = await run({ record: true, removeBeforeEnd: false });
  expect(kept.result.kind).toBe("completed");
  expect(kept.requests).toBe(3);
  // The reminded request settles the same input inside its logical turn.
  expect(kept.turnEnds).toBe(1);
  expect(kept.reminders).toHaveLength(1);
  expect(kept.reminders[0]).toContain(`- ${kept.worktree}`);
});

test("no reminder names a created worktree that was removed, or a worktree that the session did not create", async () => {
  for (const options of [{ record: true, removeBeforeEnd: true }, { record: false, removeBeforeEnd: false }]) {
    const { result, requests, reminders } = await run(options);
    expect(result.kind).toBe("completed");
    expect(requests).toBe(2);
    expect(reminders).toEqual([]);
  }
});
