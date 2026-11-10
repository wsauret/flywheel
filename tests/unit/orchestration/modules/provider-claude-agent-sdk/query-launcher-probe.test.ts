import { describe, expect, test } from "bun:test";
import type { Options, SDKControlGetContextUsageResponse } from "@anthropic-ai/claude-agent-sdk";
import type { LauncherScope } from "../../../../../src/infra/process-supervisor.js";
import { probeCliModel, type QueryFunction } from "../../../../../src/orchestration/modules/provider-claude-agent-sdk/query-launcher.js";
import { forwardDiagnostics, records } from "./_bridge-harness.js";
import { OPUS_ROW, SEPARATED, initReply, launcherConfig, noLaunch, noLock, stubQuery } from "./_launcher-harness.js";

forwardDiagnostics();

/** The debug line of engine 2.1.306 for a count that the service refused because it does not serve the model. */
const REFUSED_LINE = '2026-11-09T23:39:07.307Z [ERROR] countTokens API call failed: 404 {"type":"error","error":{"type":"not_found_error","message":"model: claude-fable-5-2"},"request_id":"req_1"}';
const EXIT = { code: 0, signal: null, statusOf: "payload", ownership: "surrendered" } as const;

/** An engine whose stderr carries `lines` and whose context usage request answers `totalTokens`, or never answers. */
function countingEngine(lines: readonly string[], totalTokens: number | undefined) {
  const options: Options[] = [];
  const events: string[] = [];
  const exit = Promise.withResolvers<typeof EXIT>();
  const stderr = new ReadableStream<Uint8Array>({ start: (controller) => {
    for (const line of lines) controller.enqueue(new TextEncoder().encode(`${line}\n`));
    controller.close();
  } });
  const closed = new ReadableStream<Uint8Array>({ start: (controller) => controller.close() });
  const launcher: LauncherScope = {
    ...noLaunch,
    open: () => launcher,
    spawnOwned: async () => ({ pid: 42, token: "fake", stdin: undefined, stdout: closed, stderr, exited: exit.promise, terminate: async () => EXIT }),
  };
  const sdkQuery: QueryFunction = (params) => {
    options.push(params.options ?? {});
    params.options?.spawnClaudeCodeProcess?.({ command: "/opt/flywheel/native/claude", args: [], env: {}, signal: new AbortController().signal });
    return stubQuery({
      initializationResult: async () => initReply([OPUS_ROW], { tokenSource: "claude.ai" }),
      // SAFETY: the probe reads only the total of the engine's context usage reply.
      // oxlint-disable-next-line typescript/consistent-type-assertions -- the reply's other fields are irrelevant here
      getContextUsage: () => totalTokens === undefined ? new Promise(() => {}) : Promise.resolve({ totalTokens } as SDKControlGetContextUsageResponse),
      interrupt: async () => { events.push("interrupt"); },
      close: () => {
        events.push("close");
        exit.resolve(EXIT);
      },
    });
  };
  return { config: { ...launcherConfig(), launcher }, sdkQuery, options, events };
}

describe("probing a model's access through the CLI", () => {
  test("an access probe starts the listing engine on the model as its custom option, counts the model's tokens with no turn, and reads a refusal of the model from the engine's debug output", async () => {
    const served = countingEngine([], 10);
    expect(await probeCliModel(served.config, "claude-fable-5-2", new AbortController().signal, served.sdkQuery, noLock)).toEqual({ totalTokens: 10, refused: false });
    expect(served.events).toEqual(["close"]);
    const [options] = served.options;
    expect(options).toMatchObject({ model: "claude-fable-5-2", tools: [], settingSources: [], strictMcpConfig: true, persistSession: false, extraArgs: { "debug-to-stderr": null, "project-config-root": "/home/person/.claude-flywheel" } });
    expect(options?.maxTurns).toBeUndefined();
    // The custom model option keeps the engine from validating the model with a billed request.
    expect(options?.env).toMatchObject({ ...SEPARATED, ANTHROPIC_CUSTOM_MODEL_OPTION: "claude-fable-5-2" });

    const refused = countingEngine([REFUSED_LINE], 0);
    expect(await probeCliModel(refused.config, "claude-fable-5-2", new AbortController().signal, refused.sdkQuery, noLock)).toEqual({ totalTokens: 0, refused: true });
    // A failed count that does not refuse this model, such as a refusal that names another model, refuses nothing.
    const other = countingEngine([REFUSED_LINE.replace("claude-fable-5-2", "claude-opus-5-5"), "[ERROR] countTokens API call failed: 429 {\"type\":\"error\",\"error\":{\"type\":\"rate_limit_error\",\"message\":\"slow down\"}}"], 0);
    expect(await probeCliModel(other.config, "claude-fable-5-2", new AbortController().signal, other.sdkQuery, noLock)).toEqual({ totalTokens: 0, refused: false });
  });

  test("an abort before the count answers rejects with its reason and closes the engine without an interrupt, and a clean stop writes no record at the default level", async () => {
    const engine = countingEngine([], undefined);
    const controller = new AbortController();
    const unfinished = probeCliModel(engine.config, "claude-fable-5-2", controller.signal, engine.sdkQuery, noLock);
    const reason = new DOMException("The access probe timed out", "TimeoutError");
    controller.abort(reason);
    expect(await unfinished.then(() => undefined, (error: unknown) => error)).toBe(reason);
    while (engine.events.length < 1) await Bun.sleep(1);
    expect(engine.events).toEqual(["close"]);
    await Bun.sleep(5);
    expect(records.filter(({ type }) => type.startsWith("provider.claude_sdk."))).toEqual([]);
  });
});
