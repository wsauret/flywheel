import { describe, expect, test } from "bun:test";
import type { Options, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { probeCliModel, type QueryFunction } from "../../../../../src/orchestration/modules/provider-claude-agent-sdk/query-launcher.js";
import { cliInit, forwardDiagnostics, records, turnResult } from "./_bridge-harness.js";
import { OPUS_ROW, SEPARATED, initReply, launcherConfig, noLock, stubQuery } from "./_launcher-harness.js";

forwardDiagnostics();

describe("probing a model's access through the CLI", () => {
  test("an access probe sends one minimal uncached request for its model as the listing engine, returns the turn's messages, and closes the CLI once the turn ended; an abort during the turn interrupts it first", async () => {
    const options: Options[] = [];
    const prompts: SDKUserMessage[] = [];
    const events: string[] = [];
    const probeQuery = (turn: readonly SDKMessage[]): QueryFunction => (params) => {
      options.push(params.options ?? {});
      const iterator = typeof params.prompt === "string" ? undefined : params.prompt[Symbol.asyncIterator]();
      async function* messages(): AsyncGenerator<SDKMessage, void> {
        const sent = await iterator?.next();
        if (sent?.done === false) prompts.push(sent.value);
        yield* turn;
        // The CLI answers no second message: the probe's caller stops it.
        await new Promise(() => {});
      }
      return Object.assign(stubQuery({
        initializationResult: async () => initReply([OPUS_ROW], { tokenSource: "claude.ai" }),
        interrupt: async () => { events.push("interrupt"); return undefined; },
        close: () => { events.push("close"); },
      }), { [Symbol.asyncIterator]: () => messages() });
    };
    const turn: SDKMessage[] = [cliInit(), turnResult({ result: "OK" })];

    expect(await probeCliModel(launcherConfig(), "claude-fable-5-2", new AbortController().signal, probeQuery(turn), noLock)).toEqual(turn);
    expect(prompts.map(({ message }) => message.content)).toEqual(["Reply with only OK."]);
    expect(events).toEqual(["close"]);
    const [probe] = options;
    expect(probe).toMatchObject({ model: "claude-fable-5-2", maxTurns: 1, tools: [], settingSources: [], strictMcpConfig: true, persistSession: false, extraArgs: { "project-config-root": "/home/person/.claude-flywheel" } });
    expect(probe?.env).toMatchObject({ ...SEPARATED, DISABLE_PROMPT_CACHING: "1", CLAUDE_CODE_EXTRA_BODY: JSON.stringify({ max_tokens: 16 }) });

    // A timeout or a supersede after the message went out leaves the turn active, so it is interrupted before the close.
    events.length = 0;
    const controller = new AbortController();
    const unfinished = probeCliModel(launcherConfig(), "claude-fable-5-2", controller.signal, probeQuery([cliInit()]), noLock);
    while (prompts.length < 2) await Bun.sleep(1);
    const reason = new DOMException("The access probe timed out", "TimeoutError");
    controller.abort(reason);
    expect(await unfinished.then(() => undefined, (error: unknown) => error)).toBe(reason);
    while (events.length < 2) await Bun.sleep(1);
    expect(events).toEqual(["interrupt", "close"]);
    // A probe runs once per audited model, so a clean stop writes no record at the default level.
    await Bun.sleep(5);
    expect(records.filter(({ type }) => type.startsWith("provider.claude_sdk."))).toEqual([]);
  });
});
