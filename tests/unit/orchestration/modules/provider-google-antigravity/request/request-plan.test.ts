import { describe, expect, test } from "bun:test";
import { lowerProviderHistory } from "../../../../../../src/orchestration/agent-runtime/llm/history/provider-history.js";
import { createModelReminders } from "../../../../../../src/orchestration/agent-runtime/llm/history/runtime-reminders.js";
import type { ConversationMessage } from "../../../../../../src/orchestration/agent-runtime/llm/types.js";
import { textHistoryTarget } from "../../../../../../src/orchestration/modules/provider-google-antigravity/request/history-text.js";
import { CONTINUATION_PROMPT, planRequest, REPLY_PROMPT, type PlannedRequest, type RequestPlan } from "../../../../../../src/orchestration/modules/provider-google-antigravity/request/request-plan.js";
import { messageFingerprint, type SessionOutput, type SessionView } from "../../../../../../src/orchestration/modules/provider-google-antigravity/request/session-view.js";
import { SHELL_CAPABILITIES } from "../../../../../helpers/prompt-capabilities.js";

const limits = { threshold: 256_000, margin: 8_000, byteCap: 760_000, promptByteCap: 190_000 };
const systemPrompt = { stable: "STABLE", session: "SESSION", conversation: "CONVERSATION" };

const u1: ConversationMessage = { kind: "user", content: "Fix the build.", origin: "human" };
const a1: ConversationMessage = { kind: "assistant", content: [{ type: "thinking", thinking: "SECRET-THINKING", signature: "s" }, { type: "text", text: "Done." }] };
const u2: ConversationMessage = { kind: "user", content: "Now run the tests.", origin: "human" };
const u2Prompt = `<message role="user" origin="person">\nNow run the tests.\n</message>`;
const call = (id: string): ConversationMessage => ({ kind: "assistant", content: [{ type: "text", text: "Reading." }, { type: "tool_use", id, name: "read", input: { path: "build.ts" } }] });
const result = (id: string): Extract<ConversationMessage, { kind: "toolResult" }> => ({ kind: "toolResult", toolUseId: id, content: [{ type: "text", text: `result of ${id}` }] });
const answer = (message: ConversationMessage): SessionOutput => ({ kind: "answer", fingerprint: messageFingerprint(message) });
const revealed = (id: string, message = call(id)): SessionOutput => ({ kind: "call", toolUseId: id, fingerprint: messageFingerprint(message) });

function request(messages: ConversationMessage[], fields: Partial<PlannedRequest> = {}): PlannedRequest {
  return { processId: "p1", systemPrompt, messages, model: "gemini-3.1-pro", effort: "high", estimatedTokens: 1_000, ...fields };
}

function plannedView(plan: RequestPlan): SessionView {
  if (plan.kind === "overflow") throw new Error("the request overflowed");
  return plan.view;
}

/** The view of a session that a rotation opened for `messages` and whose step then settled with `output`. */
function settledView(messages: ConversationMessage[], output: SessionOutput): SessionView {
  return { ...plannedView(planRequest(undefined, request(messages), limits)), output };
}

function rotation(plan: RequestPlan): Extract<RequestPlan, { kind: "rotate" }> {
  if (plan.kind !== "rotate") throw new Error(`expected a rotation, got ${plan.kind}`);
  return plan;
}

describe("planRequest", () => {
  test("an idle session that holds the history pushes the new user message", () => {
    const plan = planRequest(settledView([u1], answer(a1)), request([u1, a1, u2]), limits);
    expect(plan).toMatchObject({ kind: "push", text: u2Prompt });
    expect(plan).not.toHaveProperty("select");
  });

  test("a parked call whose result is the new tail is delivered", () => {
    const plan = planRequest(settledView([u1], revealed("c1")), request([u1, call("c1"), result("c1")]), limits);
    expect(plan).toMatchObject({ kind: "deliver", toolUseId: "c1", result: result("c1"), notices: [] });
  });

  test("a parked call's result is delivered with the reminders and runtime notices that follow it", () => {
    const date: ConversationMessage = { kind: "user", origin: "system", framing: "reminder", content: "<system-reminder>\nThe date is 2026-11-22.\n</system-reminder>\n" };
    const notice: ConversationMessage = { kind: "user", origin: "system", runtimeNotice: true, content: "A child finished." };
    const plan = planRequest(settledView([u1], revealed("c1")), request([u1, call("c1"), result("c1"), date, notice]), limits);
    expect(plan).toMatchObject({ kind: "deliver", toolUseId: "c1", notices: [date, notice] });
  });

  test("a call that the session revealed before the request's history holds it settles the request with no release", () => {
    const view = { ...plannedView(planRequest(settledView([u1], revealed("c1")), request([u1, call("c1"), result("c1")]), limits)), output: revealed("c2") };
    expect(planRequest(view, request([u1, call("c1"), result("c1")]), limits)).toEqual({ kind: "continue-call", toolUseId: "c2", view });
  });

  test("a request whose history holds the session's output changed, as by redaction, rotates", () => {
    const engineAnswer: ConversationMessage = { kind: "assistant", content: [{ type: "text", text: "The key is sk-live-1234." }] };
    const redactedAnswer: ConversationMessage = { kind: "assistant", content: [{ type: "text", text: "The key is [REDACTED]." }] };
    expect(planRequest(settledView([u1], answer(engineAnswer)), request([u1, redactedAnswer, u2]), limits)).toMatchObject({ kind: "rotate", reason: "history" });
    const engineCall: ConversationMessage = { kind: "assistant", content: [{ type: "tool_use", id: "c1", name: "bash", input: { command: "echo sk-live-1234" } }] };
    const redactedCall: ConversationMessage = { kind: "assistant", content: [{ type: "tool_use", id: "c1", name: "bash", input: { command: "echo [REDACTED]" } }] };
    expect(planRequest(settledView([u1], revealed("c1", engineCall)), request([u1, redactedCall, result("c1")]), limits)).toMatchObject({ kind: "rotate", reason: "history" });
  });

  test("a request after a cancel rotates with the full history in the append", () => {
    const view = { ...settledView([u1], answer(a1)), cancelled: true };
    const plan = rotation(planRequest(view, request([u1, a1, u2]), limits));
    expect(plan).toMatchObject({ reason: "cancelled", prompt: { kind: "input", text: u2Prompt } });
    expect(plan.append).toContain("Fix the build.");
    expect(plan.append).toContain("Done.");
    expect(plan.append).not.toContain("Now run the tests.");
    expect(plan.append).not.toContain("SECRET");
  });

  test("a request whose conversation tier differs from the session's rotates", () => {
    const plan = planRequest(settledView([u1], answer(a1)), request([u1, a1, u2], { systemPrompt: { ...systemPrompt, conversation: "OTHER" } }), limits);
    expect(plan).toMatchObject({ kind: "rotate", reason: "system-prompt" });
  });

  test("an edited history or another process rotates", () => {
    const view = settledView([u1], answer(a1));
    expect(planRequest(view, request([{ ...u1, content: "Fix the tests." }, a1, u2]), limits)).toMatchObject({ kind: "rotate", reason: "history" });
    expect(planRequest(view, request([u1, a1, u2], { processId: "p2" }), limits)).toMatchObject({ kind: "rotate", reason: "process" });
  });

  test("an effort change sets the selection before a push, and rotates while a call is parked", () => {
    const idle = planRequest(settledView([u1], answer(a1)), request([u1, a1, u2], { effort: "low" }), limits);
    expect(idle).toMatchObject({ kind: "push", text: u2Prompt, select: { model: "gemini-3.1-pro", effort: "low" }, view: { effort: "low" } });
    const parked = planRequest(settledView([u1], revealed("c1")), request([u1, call("c1"), result("c1")], { effort: "low" }), limits);
    expect(parked).toMatchObject({ kind: "rotate", reason: "selection" });
  });

  test("a model change rotates, and a parked call's rotation holds the new model's reminder in the append and sends the continuation prompt", () => {
    const target = (model: string) => textHistoryTarget({ accessProvider: "google_api", provider: "google", api: "google-generative-ai", model });
    const history: ConversationMessage[] = [u1];
    history.push(...createModelReminders("gemini-3.1-pro", 1_048_576)(history, "/scratch", SHELL_CAPABILITIES));
    const view = settledView(lowerProviderHistory(history, target("gemini-3.1-pro")), revealed("c1"));
    history.push(call("c1"), result("c1"));
    const reminders = createModelReminders("gemini-4-neon", 1_048_576)(history, "/scratch", SHELL_CAPABILITIES);
    history.push(...reminders);
    const lowered = lowerProviderHistory(history, target("gemini-4-neon"));
    expect(lowered.at(-1)).toMatchObject({ kind: "user", framing: "model" });

    // Lowering for the new model leaves out the held reminder that names the old one (PI-MODEL-090), so the session no
    // longer holds the request's history.
    const plan = rotation(planRequest(view, request(lowered, { model: "gemini-4-neon" }), limits));
    expect(plan).toMatchObject({ reason: "history", prompt: { kind: "continuation", text: CONTINUATION_PROMPT }, view: { covered: lowered.length } });
    expect(plan.append).toContain(`<tool_result id="c1">`);
    expect(plan.append).toContain("gemini-4-neon");
    expect(plan.append).not.toContain("gemini-3.1-pro");

    // Real input after the reminders still goes as the prompt.
    const steered = rotation(planRequest(view, request([...lowered, u2], { model: "gemini-4-neon" }), limits));
    expect(steered.prompt).toEqual({ kind: "input", text: u2Prompt });
    expect(steered.append).toContain("gemini-4-neon");

    // The same holds between prompts: an idle session rotates instead of selecting the new model in place.
    const answered: ConversationMessage[] = [...history.slice(0, 4), a1, u2];
    const idle = settledView(lowerProviderHistory(answered.slice(0, 4), target("gemini-3.1-pro")), answer(a1));
    answered.push(...createModelReminders("gemini-4-neon", 1_048_576)(answered, "/scratch", SHELL_CAPABILITIES));
    expect(planRequest(idle, request(lowerProviderHistory(answered, target("gemini-4-neon")), { model: "gemini-4-neon" }), limits)).toMatchObject({ kind: "rotate", reason: "history" });
  });

  test("a session near the engine's compaction threshold rotates, and a request that does not fit overflows", () => {
    const view = { ...settledView([u1], answer(a1)), occupancy: 250_000 };
    expect(planRequest(view, request([u1, a1, u2]), limits)).toMatchObject({ kind: "rotate", reason: "occupancy" });
    expect(planRequest(view, request([u1, a1, u2], { estimatedTokens: 300_000 }), limits)).toEqual({ kind: "overflow", reason: "tokens" });
  });

  test("an append over the byte cap overflows", () => {
    expect(planRequest(undefined, request([u1, a1, u2]), { ...limits, byteCap: 10 })).toEqual({ kind: "overflow", reason: "bytes" });
  });

  test("input over the prompt byte cap goes whole into the append, on a push and on a rotation", () => {
    const large: ConversationMessage = { kind: "user", content: `Review this log:\n${"x".repeat(200_000)}\nEND-OF-LOG`, origin: "human" };
    const pushed = rotation(planRequest(settledView([u1], answer(a1)), request([u1, a1, large]), limits));
    expect(pushed).toMatchObject({ reason: "prompt-size", prompt: { kind: "continuation", text: REPLY_PROMPT }, view: { covered: 3, synthetic: [{ kind: "primer", after: 3 }, { kind: "continuation", after: 3 }] } });
    expect(pushed.append).toEndWith("END-OF-LOG\n</message>");
    const opened = rotation(planRequest(undefined, request([large]), limits));
    expect(opened).toMatchObject({ reason: "new-session", prompt: { kind: "continuation", text: REPLY_PROMPT }, view: { covered: 1 } });
    expect(opened.append).toEndWith("END-OF-LOG\n</message>");
  });

  test("a rotation whose tail is a pending call's result renders the call and result and sends the continuation prompt", () => {
    const foreign: ConversationMessage = {
      kind: "assistant",
      accessProvider: "google_api",
      provider: "google",
      model: "gemini-3.1-pro",
      content: [
        { type: "reasoning", id: "rs_1", encrypted_content: "SECRET-ENCRYPTED" },
        { type: "thinking", thinking: "Checking the script first.", presentation: "progress" },
        { type: "tool_use", id: "c1", name: "read", input: { path: "build.ts" }, thoughtSignature: "SECRET-SIGNATURE" },
      ],
    };
    const plan = rotation(planRequest(undefined, request([u1, a1, u2, foreign, result("c1")]), limits));
    expect(plan).toMatchObject({ reason: "new-session", prompt: { kind: "continuation", text: CONTINUATION_PROMPT }, view: { covered: 5, synthetic: [{ kind: "primer", after: 5 }, { kind: "continuation", after: 5 }] } });
    for (const text of ["Done.", "Checking the script first.", `<tool_call id="c1" name="read">`, `<tool_result id="c1">\nresult of c1\n</tool_result>`]) expect(plan.append).toContain(text);
    expect(plan.append).not.toContain("SECRET");
  });
});
