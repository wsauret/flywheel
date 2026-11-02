/**
 * Shared harness for live agent-loop provider tests.
 *
 * Builds the loop from the production pieces with only the dependencies these
 * tests need. The exposure planner supplies the self-contained tools (bash,
 * read, write, edit, search, list) through one request tool surface. The system
 * prompt is built from that same tool surface and the execution directory's
 * `<env>` block. The client and its launch authority come from the live client
 * harness, which resolves the serving route as production does. Bash runs as
 * the headless host runs it: through that guarded launcher, a background
 * execution owner, and a foreground hold. No
 * subagent, workflow, or session wiring: the loop runs oneshot (no input
 * source) and completes when the model yields without tool calls.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEnvCaptureResolver } from "../../../src/infra/env-detection.js";
import { NO_MODULE_RUNTIMES } from "../../../src/infra/module-runtime.js";
import { ownedCommandRunner } from "../../../src/infra/owned-command.js";
import { runAgentLoop } from "../../../src/orchestration/agent-runtime/agent-loop.js";
import type { AgentLoopTerminal } from "../../../src/orchestration/agent-runtime/agent-loop-types.js";
import { createBackgroundExecutionOwner } from "../../../src/orchestration/agent-runtime/background-execution-owner.js";
import { createBackgroundWorkRegistry } from "../../../src/orchestration/agent-runtime/background-work.js";
import { createForegroundBashHoldController } from "../../../src/orchestration/agent-runtime/foreground-bash-hold.js";
import type { StreamEvent } from "../../../src/orchestration/agent-runtime/llm/types.js";
import { createRequestToolSurface } from "../../../src/orchestration/agent-runtime/request-tool-surface.js";
import { buildSystemPrompt } from "../../../src/orchestration/agent-runtime/system-prompt.js";
import { planToolExposure } from "../../../src/orchestration/agent-runtime/tools/tool-exposure-planner.js";
import { testCapabilityModules, testKernelToolDeps, testRuntimeConfigCapture } from "../../helpers/request-tool-surface.js";
import { liveDirectories, withLiveClient, type LiveRun } from "./_live-client.js";

const TASK = "You are a helpful coding assistant. Complete the task exactly as instructed, then stop.";

export interface LiveLoopRun {
  result: AgentLoopTerminal;
  events: StreamEvent[];
}

/** Runs one oneshot `LIVE_MODEL` agent loop in `executionCwd`, which the
 *  caller owns and removes. `label` names the test in the serving-account
 *  line the live client harness prints. */
export function runLiveAgentLoop(input: {
  label: string;
  instruction: string;
  executionCwd: string;
  /** Loop abort budget; the surrounding test timeout must exceed it. */
  timeoutMs: number;
}): Promise<LiveLoopRun> {
  return withLiveClient(input.label, (run) => runLoop(run, input));
}

async function runLoop({ client, launcher }: LiveRun, input: { instruction: string; executionCwd: string; timeoutMs: number }): Promise<LiveLoopRun> {
  const purpose = { kind: "headless-task", prompt: { kind: "assembled", corePrompt: "You are a helpful AI Agent." } } as const;
  // A oneshot loop has no conversation to deliver a background notice into.
  const background = createBackgroundExecutionOwner(createBackgroundWorkRegistry({ kind: "chat", enqueueNotification: () => {} }));
  const foregroundBashHold = createForegroundBashHoldController(() => {});
  const runId = `live-${crypto.randomUUID()}`;
  // Bash writes its command scripts and logs into the session scratch
  // directory. A run owns its own, as a session does, and removes it.
  const scratchDir = mkdtempSync(join(tmpdir(), "live-scratch-"));
  const events: StreamEvent[] = [];
  try {
    const tools = await createRequestToolSurface(
      (moduleSnapshot, runtimeConfig) => planToolExposure({
        kernel: testKernelToolDeps({
          userDataRoot: liveDirectories.userDataRoot,
          moduleSnapshot,
          runtimeConfig,
          purpose,
          servingModel: { model: client.model, modelFamily: client.modelFamily },
          backgroundTasks: background.tasks,
          foregroundBashHold,
        }),
        modules: NO_MODULE_RUNTIMES,
      }),
      testCapabilityModules,
      testRuntimeConfigCapture,
    );
    const env = await createEnvCaptureResolver(ownedCommandRunner(launcher))({ projectRoot: input.executionCwd, executionCwd: input.executionCwd });
    const result = await runAgentLoop({
      client,
      tools,
      // The loop builds the prompt after it resolves each request's surface,
      // so the prompt describes exactly the tools that request advertises.
      systemPrompt: () => buildSystemPrompt({
        promptKind: "headless",
        tools: [...tools.current().tools.values()],
        envBlock: env.envBlock,
        scratchDir,
      }),
      instruction: `${TASK}\n\n${input.instruction}`,
      executionCwd: input.executionCwd,
      userDataRoot: `${input.executionCwd}/.test-account`, projectRoot: input.executionCwd,
      scratchDir,
      launcher,
      background,
      persistence: { history: { append: () => {} } },
      seed: { kind: "fresh" },
      signal: AbortSignal.timeout(input.timeoutMs),
      onEvent: (event) => events.push(event),
      providerSessionKey: runId, promptCacheKey: runId,
      artifactScopeId: runId,
      retrievalSessionId: runId,
    });
    return { result, events };
  } finally {
    await background.close();
    await foregroundBashHold.awaitSettlement();
    foregroundBashHold.dispose();
    rmSync(scratchDir, { recursive: true, force: true });
  }
}

/** Tool names in stream order, from the loop's tool_use events. */
export function toolNamesUsed(events: StreamEvent[]): string[] {
  return events
    .filter((e): e is Extract<StreamEvent, { kind: "tool_use" }> => e.kind === "tool_use")
    .map((e) => e.toolCall.name);
}

export function toolWasUsed(events: StreamEvent[], toolName: string): boolean {
  return toolNamesUsed(events).includes(toolName);
}
