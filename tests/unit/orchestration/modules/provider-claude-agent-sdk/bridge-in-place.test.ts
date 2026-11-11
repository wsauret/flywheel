import { describe, expect, test } from "bun:test";
import type { MessageParam, TextBlockParam } from "@anthropic-ai/sdk/resources/messages.js";
import { createClaudeReminders, environmentReminder, type HostEnvironment } from "../../../../../src/orchestration/agent-runtime/llm/runtime-reminders.js";
import { SHELL_CAPABILITIES } from "../../../../helpers/prompt-capabilities.js";
import {
  A1, A2, answers, forwardDiagnostics, init, MACOS_ENVIRONMENT, parked, payloads, R1, readsFile, request, REQUEST_STEP, send, settle, turnDone, U1, U2, until, withBridge, type Harness, originsOf,
} from "./_bridge-harness.js";

forwardDiagnostics();

const EDITED_A2: MessageParam = { role: "assistant", content: [{ type: "text", text: "Done, edited." }] };
const U3: MessageParam = { role: "user", content: [{ type: "text", text: "Last one." }] };
const FAILED_R1: MessageParam = { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: [{ type: "text", text: "no such file" }], is_error: true }] };

/** A step's opening reminders as canonical history holds them: `environment`, the model, and today's date. */
function openingReminders(environment: HostEnvironment): TextBlockParam[] {
  const [, model, date] = createClaudeReminders("claude-sonnet-5-5", 200_000)([{ kind: "user", origin: "human", content: "Read a." }], environment.workingDirectory, SHELL_CAPABILITIES);
  return [environmentReminder(environment, SHELL_CAPABILITIES), model?.content, date?.content].map((text) => ({ type: "text", text: typeof text === "string" ? text : "" }));
}

/** One idle conversation on one query: U1, a read of `a`, its result through the handler, and "Done.". */
async function idle(harness: Harness) {
  const { query } = await parked(harness);
  const second = await send(harness.ops, request([U1, A1, R1]));
  query.emit(...answers("Done."));
  await second.read;
  return query;
}

describe("the bridge's in-place rotation (rule 13)", () => {
  test("a changed answer cuts the live CLI at the turn's first row, replays the turn, and serves the request on the same process", () => withBridge(async (harness) => {
    const query = await idle(harness);
    const third = await send(harness.ops, request([U1, A1, R1, EDITED_A2, U2]));
    await until(() => harness.log.at(-1) === "push" && harness.log.length > 2);

    expect(harness.log).toEqual(["push", "rewind:push0<=push0", "replay:user", "replay:assistant", "replay:user", "replay:assistant", "push"]);
    // Every replayed row is a frame the CLI takes without a request, and the tool result keeps the transcript's key order.
    expect(query.pushed.slice(1).map((frame) => [frame.type, frame.type === "user" ? frame.shouldQuery : undefined])).toEqual([
      ["user", false], ["assistant", undefined], ["user", false], ["assistant", undefined], ["user", undefined],
    ]);
    expect(JSON.stringify(query.pushed[3]?.message.content)).toBe('[{"tool_use_id":"toolu_1","type":"tool_result","content":[{"type":"text","text":"file a"}]}]');
    // The owed result of the edited turn is no failure, and no answer to a replayed row ends the request.
    query.emit(turnDone, ...answers("Next done."));
    expect(await third.error).toBeUndefined();
    expect(harness.queries).toHaveLength(1);
    expect(payloads("provider.claude_sdk.query.reloaded")).toEqual([{
      sessionId: query.launch.session.id, trigger: "history", interrupted: false, systemPrompt: false, cut: true, opening: false, keptMessages: 0, replayedMessages: 4, durationMs: expect.any(Number),
    }]);
    expect(payloads("provider.claude_sdk.rotation.cache")).toHaveLength(1);
    expect(payloads("provider.claude_sdk.query.stopped")).toEqual([]);
  }, { inPlace: "ready" }));

  test("the cut is at the newest turn start before the change, so earlier turns stay in the CLI unreplayed", () => withBridge(async (harness) => {
    const query = await idle(harness);
    const third = await send(harness.ops, request([U1, A1, R1, A2, U2]));
    query.emit(turnDone, ...answers("Next done."));
    await third.read;
    const fourth = await send(harness.ops, request([U1, A1, R1, A2, U2, EDITED_A2, U3]));
    await until(() => harness.log.at(-1) === "push" && harness.log.length > 3);

    expect(harness.log).toEqual(["push", "push", "rewind:push1<=push1", "replay:user", "replay:assistant", "push"]);
    query.emit(turnDone, ...answers("Last."));
    expect(await fourth.error).toBeUndefined();
    expect(payloads("provider.claude_sdk.query.reloaded")).toMatchObject([{ trigger: "history", cut: true, keptMessages: 4, replayedMessages: 2 }]);
  }, { inPlace: "ready" }));

  test("a result that the parked handler cannot carry interrupts the parked turn, which sends nothing, and pushes the tail after the replayed turn", () => withBridge(async (harness) => {
    const { query } = await parked(harness);
    const second = await send(harness.ops, request([U1, A1, FAILED_R1]));
    await until(() => harness.log.length === 6);

    expect(harness.log).toEqual(["push", "interrupt", "rewind:push0<=push0", "replay:user", "replay:assistant", "push"]);
    expect<unknown>(query.pushed.at(-1)?.message.content).toEqual(FAILED_R1.content);
    // The interrupted turn's result arrives after the push and is not this request's end.
    query.emit(turnDone, ...answers("Recovered."));
    expect(await second.error).toBeUndefined();
    expect(harness.queries).toHaveLength(1);
    expect(payloads("provider.claude_sdk.query.reloaded")).toMatchObject([{ trigger: "undeliverable-result", interrupted: true, cut: true, replayedMessages: 2 }]);
  }, { inPlace: "ready" }));

  describe("a request that its caller cancels while the parked turn's interrupt runs", () => {
    /** Sends the undeliverable result, cancels it while the interrupt waits, then ends the interrupt with `ends`. */
    async function cancelDuringInterrupt(harness: Harness, ends: (interrupt: PromiseWithResolvers<undefined>) => void) {
      const { query } = await parked(harness);
      const interrupt = Promise.withResolvers<undefined>();
      const { interrupt: interruptNow } = query;
      let waiting = false;
      query.interrupt = async () => {
        waiting = true;
        await interrupt.promise;
        return interruptNow();
      };
      const caller = new AbortController();
      const cancelled = harness.ops.createStream(request([U1, A1, FAILED_R1]), { origins: originsOf(request([U1, A1, FAILED_R1])), sharedHost: true, signal: caller.signal, headers: {} }).then(() => undefined, (error: unknown) => error);
      await until(() => waiting);
      caller.abort(new Error("the person stopped the turn"));
      expect(await cancelled).toMatchObject({ message: "the person stopped the turn" });
      ends(interrupt);
      await settle();
      return query;
    }

    test("after a reload that succeeds pushes no tail, and the next request continues the replayed conversation on the same process", () => withBridge(async (harness) => {
      const query = await cancelDuringInterrupt(harness, (interrupt) => { interrupt.resolve(undefined); });
      await until(() => harness.log.length === 5);
      expect(harness.log).toEqual(["push", "interrupt", "rewind:push0<=push0", "replay:user", "replay:assistant"]);
      expect(payloads("provider.claude_sdk.query.stopped")).toEqual([]);

      const next = await send(harness.ops, request([U1, A1, FAILED_R1]));
      await until(() => harness.log.length === 6);
      expect<unknown>(query.pushed.at(-1)?.message.content).toEqual(FAILED_R1.content);
      query.emit(turnDone, ...answers("Recovered."));
      expect(await next.error).toBeUndefined();
      expect(harness.queries).toHaveLength(1);
    }, { inPlace: "ready" }));

    test("after a reload that fails stops the engine and starts no other", () => withBridge(async (harness) => {
      await cancelDuringInterrupt(harness, (interrupt) => { interrupt.reject(new Error("the engine refused the interrupt")); });
      await until(() => payloads("provider.claude_sdk.query.stopped").length === 1);
      expect(payloads("provider.claude_sdk.query.stopped")).toMatchObject([{ reason: "abort", rule: "caller-signal" }]);
      expect(harness.queries).toHaveLength(1);
      expect(harness.log.filter((entry) => entry === "push")).toHaveLength(1);
    }, { inPlace: "ready" }));
  });

  test("a step's first rotation replays its opening row as a turn start whose step the gate refuses unreported, so the CLI states the opening reminders there", () => withBridge(async (harness) => {
    const reminders = openingReminders(MACOS_ENVIRONMENT);
    const opening: MessageParam = { role: "user", content: [{ type: "text", text: "Read a." }, ...reminders] };
    await send(harness.ops, request([opening]));
    const [query] = harness.queries;
    query?.emit(init, ...readsFile);
    await settle();
    const sent = send(harness.ops, request([opening, A1, FAILED_R1]));
    await until(() => harness.log.length === 4);

    expect(harness.log).toEqual(["push", "interrupt", "rewind:push0<=push0", "push"]);
    // The CLI asks for the replayed turn's first step and ends the turn, which sends nothing, with a result that names
    // the row. The row holds no reminder, because the CLI states its own.
    const replayed = query?.pushed[1];
    query?.emit(REQUEST_STEP, { ...turnDone, user_message_uuid: replayed?.uuid });
    const second = await sent;
    await until(() => harness.log.length === 6);
    expect(harness.log.slice(4)).toEqual(["replay:assistant", "push"]);
    expect(replayed).toEqual({ type: "user", uuid: expect.any(String), parent_tool_use_id: null, message: { role: "user", content: [{ type: "text", text: "Read a." }] } });
    expect(query?.steps.at(-1)).toBe(false);
    query?.emit(turnDone, ...answers("Recovered."));
    expect(await second.error).toBeUndefined();
    expect(harness.queries).toHaveLength(1);
    expect(payloads("provider.claude_sdk.step.refused")).toEqual([]);
    expect(payloads("provider.claude_sdk.query.reloaded")).toMatchObject([{ trigger: "undeliverable-result", interrupted: true, cut: true, opening: true, replayedMessages: 2 }]);
  }, { inPlace: "ready" }));

  describe("a step's opening rotation on each platform", () => {
    // On Windows with Git for Windows installed, the engine names bash where the canonical reminder names PowerShell.
    const platforms = [
      { name: "macOS", cwd: "/work", platform: "darwin", shell: "zsh", engineShell: undefined, osVersion: "Darwin 25.3.0" },
      { name: "Linux", cwd: "/work", platform: "linux", shell: "bash", engineShell: undefined, osVersion: "Linux 6.8.0-45-generic" },
      { name: "Windows", cwd: "C:\\work", platform: "win32", shell: "PowerShell", engineShell: "bash", osVersion: "Windows 11 Pro 10.0.26100" },
    ] as const;
    for (const host of platforms) {
      const environment = { kind: "environment", workingDirectory: host.cwd, isWorktree: false, isGitRepo: true, platform: host.platform, shell: host.shell, osVersion: host.osVersion } as const;
      const reminders = openingReminders(environment);
      const opening: MessageParam = { role: "user", content: [{ type: "text", text: "Read a." }, ...reminders] };
      /** The step's first request, parked on a tool call, then the rotation that an error result starts. */
      const rotate = async (harness: Harness) => {
        await send(harness.ops, request([opening]));
        harness.queries[0]?.emit(init, ...readsFile);
        await settle();
        return send(harness.ops, request([opening, A1, FAILED_R1]));
      };

      test(`on ${host.name} it reloads in place, because the engine states the step's canonical opening environment with its own shell, as a transcript does`, () => withBridge(async (harness) => {
        const sent = rotate(harness);
        await until(() => harness.log.length === 4);
        const query = harness.queries[0];
        query?.emit(REQUEST_STEP, { ...turnDone, user_message_uuid: query.pushed[1]?.uuid });
        const second = await sent;
        query?.emit(turnDone, ...answers("Recovered."));
        expect(await second.error).toBeUndefined();
        expect(harness.queries).toHaveLength(1);
        expect(payloads("provider.claude_sdk.query.reloaded")).toMatchObject([{ opening: true }]);
      }, { inPlace: "ready", openingEnvironment: () => environment, ...(host.engineShell === undefined ? {} : { engineShell: host.engineShell }) }));
      test(`on ${host.name} a git state that changed since the step opened starts a new process`, () => withBridge(async (harness) => {
        const sent = rotate(harness);
        await until(() => harness.queries.length === 2);
        const transcript = [...harness.files.values()].join("\n");
        expect(transcript).toContain('"isGitRepo":true');
        // The transcript's environment row states the shell that the engine names, so the engine states no second one.
        expect(transcript).toContain(`"platform":"${host.platform}","shell":"${host.engineShell ?? host.shell}","osVersion":"${host.osVersion}"`);
        harness.queries[1]?.emit(init, ...answers("Recovered."));
        expect(await (await sent).error).toBeUndefined();
        expect(payloads("provider.claude_sdk.query.reloaded")).toEqual([]);
      }, { inPlace: "ready", openingEnvironment: () => ({ ...environment, isGitRepo: false }), ...(host.engineShell === undefined ? {} : { engineShell: host.engineShell }) }));
    }
  });

  test("a new untiered system prompt on an idle query is set in place, and the next message is pushed with nothing replayed", () => withBridge(async (harness) => {
    const query = await idle(harness);
    query.emit(turnDone);
    await settle();
    const third = await send(harness.ops, request([U1, A1, R1, A2, U2], { system: [{ type: "text", text: "A changed prompt" }] }));
    await until(() => harness.log.length === 3);

    expect(harness.log).toEqual(["push", "system-prompt:A changed prompt", "push"]);
    query.emit(...answers("Next done."));
    expect(await third.error).toBeUndefined();
    expect(payloads("provider.claude_sdk.query.reloaded")).toMatchObject([{ trigger: "identity", field: "systemPrompt", systemPrompt: true, cut: false, replayedMessages: 0 }]);
  }, { inPlace: "ready" }));

  test("an idle query whose turn the CLI has not ended is cut at its turn start, because a step that it refuses before its turn result can still add rows", () => withBridge(async (harness) => {
    const query = await idle(harness);
    const third = await send(harness.ops, request([U1, A1, R1, A2, U2], { system: [{ type: "text", text: "A changed prompt" }] }));
    await until(() => harness.log.at(-1) === "push" && harness.log.length > 2);

    expect(harness.log).toEqual(["push", "system-prompt:A changed prompt", "rewind:push0<=push0", "replay:user", "replay:assistant", "replay:user", "replay:assistant", "push"]);
    query.emit(turnDone, ...answers("Next done."));
    expect(await third.error).toBeUndefined();
    expect(payloads("provider.claude_sdk.query.reloaded")).toMatchObject([{ trigger: "identity", systemPrompt: true, cut: true, keptMessages: 0, replayedMessages: 4 }]);
  }, { inPlace: "ready" }));

  test("a CLI version that has not passed its self-test rotates cold, and the stop names why", () => withBridge(async (harness) => {
    await idle(harness);
    const third = await send(harness.ops, request([U1, A1, R1, EDITED_A2, U2]));
    harness.queries[1]?.emit(init, ...answers("Rotated."));
    expect(await third.error).toBeUndefined();

    expect(harness.log).toEqual(["push", "close", "push"]);
    expect(payloads("provider.claude_sdk.query.stopped")).toMatchObject([{ reason: "rotation", rule: "history", evidence: { inPlace: "checking" } }]);
    expect(payloads("provider.claude_sdk.query.reloaded")).toEqual([]);
  }, { inPlace: "checking" }));

  test("a rewind that the CLI refuses ends the reload, and the request is served by a cold rotation", () => withBridge(async (harness) => {
    const query = await idle(harness);
    query.rewindOutcome = { rewound: false, reason: "target_not_found" };
    const third = await send(harness.ops, request([U1, A1, R1, EDITED_A2, U2]));
    await until(() => harness.queries.length === 2);
    harness.queries[1]?.emit(init, ...answers("Rotated."));
    expect(await third.error).toBeUndefined();

    expect(harness.log).toEqual(["push", "rewind:push0<=push0", "close", "push"]);
    expect(payloads("provider.claude_sdk.query.stopped")).toMatchObject([{ reason: "rotation", rule: "history", evidence: { inPlace: "rewind:target_not_found" } }]);
  }, { inPlace: "ready" }));

  test("a row the CLI wrote itself is never a cut target, so an edit inside a parked turn's results cuts at the turn's own row", () => withBridge(async (harness) => {
    const { query } = await parked(harness);
    // The handler takes R1, so the CLI writes R1's row itself; the next answer parks again.
    const second = await send(harness.ops, request([U1, A1, R1]));
    query.emit(...readsFile);
    await second.read;
    await settle();
    const third = await send(harness.ops, request([U1, A1, FAILED_R1, A1, R1]));
    await until(() => harness.log.at(-1) === "push" && harness.log.length > 2);

    expect(harness.log).toEqual(["push", "interrupt", "rewind:push0<=push0", "replay:user", "replay:assistant", "replay:user", "replay:assistant", "push"]);
    query.emit(turnDone, ...answers("Done."));
    expect(await third.error).toBeUndefined();
  }, { inPlace: "ready" }));
});
