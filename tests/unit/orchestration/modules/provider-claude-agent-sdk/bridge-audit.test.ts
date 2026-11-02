import { describe, expect, test } from "bun:test";
import { answers, cliInit, cliOnlyMessage, forwardDiagnostics, init, logLines, request, requestBlock, send, settle, U1, U1_WITH_ENVIRONMENT, withBridge } from "./_bridge-harness.js";

forwardDiagnostics();

// The record of what the engine added to each admitted request, which the adapter writes on the request's audit
// response (ARCH-CONTEXT-008). The hidden rows that it carries are asserted beside each hidden-request rule in bridge.test.ts.
describe("the bridge's record of what the engine added", () => {
  test("a served request hands the adapter one record of what the engine added, from its fixed behavior, its init, and its request block", () => withBridge(async ({ ops, queries }) => {
    const marked = request([U1_WITH_ENVIRONMENT], { system: [{ type: "text", text: "Flywheel system prompt", cache_control: { type: "ephemeral" } }] });
    const first = await send(ops, marked);
    const query = queries[0];
    query?.emit(cliInit({ per_turn_effort_active: true }));
    await settle();
    // The engine logs its request before it sends it: its own body fields and its exact beta header.
    logLines(query, requestBlock("/v1/messages", ["model", "messages", "system", "tools", "metadata", "max_tokens", "thinking", "context_management", "output_config", "stream"], "oauth-2025-04-20,effort-2025-11-24"));
    query?.emit(...answers("Done."));
    await first.read;

    expect(first.types.at(-1)).toBe("message_stop");
    expect(first.contexts).toEqual([{
      identity: "claude-engine",
      additions: [
        { part: "system", kind: "billing", at: 0 }, { part: "system", kind: "identity", at: 1 },
        { part: "message", kind: "reminder:session-context", at: 0 }, { part: "message", kind: "reminder:environment", at: 0 },
        // The engine writes the model and date sections that Flywheel's first message does not hold, and sets the
        // effort on the system message that holds them.
        { part: "message", kind: "model", at: 0 }, { part: "message", kind: "date", at: 0 },
        { part: "message", kind: "output_config.effort", at: 0, value: "medium" },
        { part: "body", kind: "cache_control", value: "engine-placed" },
        { part: "body", kind: "metadata" }, { part: "body", kind: "context_management" },
        { part: "header", kind: "anthropic-beta", value: "oauth-2025-04-20,effort-2025-11-24" },
      ],
      hiddenRequests: [],
      notRecorded: ["cache_control count"],
    }]);
  }, { email: "person@example.com" }));

  test("a record names what the engine did not state: an effort without the engine's per-turn statement, and a request block it never logged", () => withBridge(async ({ ops, queries }) => {
    const first = await send(ops, request([U1]));
    queries[0]?.emit(init, ...answers("Done."));
    await first.read;
    expect(first.contexts).toEqual([expect.objectContaining({ notRecorded: ["output_config.effort per turn", "body fields", "anthropic-beta"] })]);
  }));

  test("an engine that stops sending the effort per turn gets no per-turn effort on its next record", () => withBridge(async ({ ops, queries }) => {
    const first = await send(ops, request([U1]));
    queries[0]?.emit(cliInit({ per_turn_effort_active: true }), cliOnlyMessage({ type: "system", subtype: "per_turn_effort_changed", per_turn_effort_active: false }), ...answers("Done."));
    await first.read;
    expect(first.contexts.flatMap(({ additions }) => additions.filter(({ kind }) => kind === "output_config.effort"))).toEqual([]);
    expect(first.contexts.map(({ notRecorded }) => notRecorded)).toEqual([["body fields", "anthropic-beta"]]);
  }));
});
