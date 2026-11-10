import { beforeEach, describe, expect, it, spyOn } from "bun:test";
import type { ConversationMessage } from "../../../../../src/orchestration/agent-runtime/llm/types.js";
import { readMutationEvidenceFiles } from "../../../../../src/infra/mutation-evidence.js";
import { buildMutationDiff } from "../../../../../src/infra/mutation-diff.js";
import { buildMutationDiffEvidence } from "../../../../../src/infra/mutation-diff-evidence.js";
import type { SessionContentNode, StageSessionContentNodes } from "../../../../../src/infra/session-content.js";
import {
  createLearningReview,
  createReviewUsageAccounting,
  type ReviewNotice,
  type ReviewRunSpec,
  type LearningReviewConfig,
} from "../../../../../src/orchestration/modules/learning/learning-review.js";
import { capabilityAccessFor } from "../../../../../src/orchestration/agent-runtime/tools/types.js";
import type { AgentRunResult, AgentRunTerminal } from "../../../../../src/orchestration/agent-runtime/types.js";
import type { SessionFactWriter } from "../../../../../src/orchestration/session/session-fact-writer.js";
import { composeRealmModuleSnapshot } from "../../../../../src/orchestration/modules.js";
import { Log } from "../../../../../src/infra/log.js";
interface UnknownObject {
  [key: string]: unknown;
}

let specs: ReviewRunSpec[] = [];
let recorded: Array<{ type: string; payload: UnknownObject }> = [];
let notices: ReviewNotice[] = [];
const contentNodes = new Map<string, SessionContentNode>();
const stageContent: StageSessionContentNodes = async (nodes) => { for (const row of nodes) contentNodes.set(row.sha256, row.node); };
let notified: unknown[] = [];

let resolveReview: (() => void) | undefined;
let failReview = false;
/** How the fork's run ended when it settles without a rejection. */
let reviewTerminal: AgentRunTerminal = { kind: "completed" };

/** The host's capability boundary. `learningHeld` is what the live selection
 *  holds for Learning, and Skills is held throughout, so the skill half's own
 *  requirement is never why a case does not fire. `admitReview` is what the
 *  review's own admission answers, so a case can disable Learning between the
 *  counters and the fire. */
let learningHeld = true;
let admitReview = true;
/** Whether the live selection holds Skills; a case turns it off to see the review that Skills off leaves. */
let skillsHeld = true;

function reviewCapabilityState() {
  const held = [...(skillsHeld ? ["skills"] as const : []), ...(learningHeld ? ["learning"] as const : [])];
  return {
    moduleIds: held,
    capabilities: held,
    requireWorkflowConfirmation: true,
    workflowsMode: "off" as const,
    identity: held.join("+"),
  };
}

const reviewCapabilities = capabilityAccessFor({
  state: reviewCapabilityState,
  admit: async (request) => admitReview
    ? { ok: true, grant: { ...reviewCapabilityState(), operation: request.operation, required: request.required } }
    : { ok: false, missing: ["learning"], reason: "learning is turned off. Turn it on in Settings, or remove it from disabled_modules in flywheel.toml" },
});

const reviewCapabilityModules = () => composeRealmModuleSnapshot({ moduleIds: reviewCapabilityState().capabilities });

function recordingWriter(): SessionFactWriter {
  return {
    stageSessionContentNodes: stageContent,
    record: async (fact) => { recorded.push(fact); return null; },
    recordBatch: async () => { throw new Error("unexpected batch write"); },
    recordGuarded: async () => { throw new Error("unexpected guarded write"); },
    transaction: async (run) => { run(); },
    dispose: () => {},
  };
}

function makeReview(config: Partial<LearningReviewConfig> = {}) {
  return createLearningReview({
    sessionId: "sess-1",
    capabilities: reviewCapabilities,
    moduleSelection: reviewCapabilityModules,
    config: { memoryIntervalTurns: 3, skillIntervalIterations: 4, notifications: "on", ...config },
    sessionEventWriter: recordingWriter(),
    readContentNode: async (hash) => contentNodes.get(hash) ?? null,
    spawnReview: (spec) => {
      specs.push(spec);
      const done = failReview
        ? Promise.reject(new Error("review exploded"))
        : new Promise<AgentRunResult>((resolve) => { resolveReview = () => resolve({ servedRequests: 0, durationMs: 1, terminal: reviewTerminal }); });
      return Promise.resolve({
        done,
        model: "test-model",
        recordSystemMessage: (notice: ReviewNotice) => { notices.push(notice); return Promise.resolve(); },
        notifyRecommendation: (recommendation) => { notified.push(recommendation); },
      });
    },
  });
}

function assistantToolUse(name: string): ReadonlyArray<{ type: string; name?: string }> {
  return [{ type: "tool_use", name }];
}

/** The fire path admits Learning before it spawns, so the spawn lands one
 *  queue drain after the call that fired it. `settled()` cannot stand in for
 *  this wait: it also waits for the fork's own `done`, which the case resolves
 *  only after it has inspected the spawned spec. */
function fired(): Promise<void> {
  return new Promise((resolve) => { setImmediate(resolve); });
}

/** Completes one user turn, which fires the review at a one-turn interval. */
async function completeUserTurn(review: { noteUserTurn(): void; onTurnCompleted(): void }): Promise<void> {
  review.noteUserTurn();
  review.onTurnCompleted();
  await fired();
}

/** Lets the review that the case spawned complete, then waits for its settlement. */
async function finishReview(review: Pick<ReturnType<typeof makeReview>, "settled">): Promise<void> {
  resolveReview?.();
  await review.settled();
}

beforeEach(() => {
  specs = [];
  recorded = [];
  notices = [];
  contentNodes.clear();
  notified = [];

  resolveReview = undefined;
  failReview = false;
  reviewTerminal = { kind: "completed" };
  learningHeld = true;
  admitReview = true;
  skillsHeld = true;
});

describe("learning review gating", () => {
  it("fires the memory half after N user turns with the memory prompt", async () => {
    const review = makeReview();
    for (let turn = 0; turn < 3; turn++) review.noteUserTurn();
    review.onTurnCompleted();
    await fired();

    expect(specs).toHaveLength(1);
    expect(specs[0]?.instruction).toContain("durable memory");
    expect(specs[0]?.instruction).not.toContain("skill library");
    expect(specs[0]?.instruction).toContain("You can only use the skill, skill_manage, and memory tools. Other tools will be denied at runtime");
    expect(specs[0]?.instruction).toContain("A preference is never a skill.");
    expect(specs[0]?.capabilities("skill_manage")).toBe(true);

    await finishReview(review);
    expect(recorded[0]?.type).toBe("skill.review.completed");
    expect(recorded[0]?.payload.halves).toEqual(["memory"]);
    expect(recorded[0]?.payload.trigger).toBe("turns");
    expect(recorded[0]?.payload.outcome).toBe("nothing_to_save");
  });

  it("gives a memory review with Skills off no skill guidance and only the memory tool", async () => {
    skillsHeld = false;
    const review = makeReview();
    for (let turn = 0; turn < 3; turn++) review.noteUserTurn();
    for (let call = 0; call < 4; call++) review.noteAssistantMessage("text");
    review.onTurnCompleted();
    await fired();

    expect(specs).toHaveLength(1);
    const instruction = specs[0]?.instruction ?? "";
    expect(instruction).toContain("durable memory");
    expect(instruction).toContain("Repeatable procedure (a method for a class of work, with a routing trigger, steps, verification, and failure guidance) -> not memory. Name it in your reply.");
    expect(instruction).toContain("You can only use the memory tool. Other tools will be denied at runtime");
    expect(instruction).not.toContain("skill_manage");
    expect(instruction).not.toContain("a project skill");
    expect(instruction).not.toContain("never a skill");
    expect(instruction).not.toContain("Global skills");
    expect(specs[0]?.capabilities("skill_manage")).toBe(false);

    await finishReview(review);
  });

  it("fires the skill half after N LLM calls, accumulating across turns", async () => {
    const review = makeReview();
    for (let call = 0; call < 2; call++) review.noteAssistantMessage("text");
    review.onTurnCompleted();
    await fired();
    expect(specs).toHaveLength(0);

    for (let call = 0; call < 2; call++) review.noteAssistantMessage("text");
    review.onTurnCompleted();
    await fired();
    expect(specs).toHaveLength(1);
    expect(specs[0]?.instruction).toContain("otherwise leave memory and the skill library alone");

    await finishReview(review);
  });

  it("resets the skill counter when the model itself calls skill_manage, and the memory counter on memory use", async () => {
    const review = makeReview();
    for (let call = 0; call < 3; call++) review.noteAssistantMessage("text");
    review.noteAssistantMessage(assistantToolUse("skill_manage"));
    review.onTurnCompleted();
    await fired();
    expect(specs).toHaveLength(0);

    review.noteUserTurn();
    review.noteUserTurn();
    review.noteAssistantMessage(assistantToolUse("memory"));
    await completeUserTurn(review);
    // Memory counter was reset at 2, so only 1 turn accumulated since.
    expect(specs).toHaveLength(0);
  });

  it("selects the combined prompt when both halves are due and resets both counters", async () => {
    const review = makeReview({ memoryIntervalTurns: 2, skillIntervalIterations: 2 });
    review.noteUserTurn();
    review.noteUserTurn();
    review.noteAssistantMessage("a");
    review.noteAssistantMessage("b");
    review.onTurnCompleted();
    await fired();

    expect(specs).toHaveLength(1);
    expect(specs[0]?.instruction).toContain("Act on each destination the classifier selects");

    // Counters were reset when the review fired.
    await finishReview(review);
    review.onTurnCompleted();
    await fired();
    expect(specs).toHaveLength(1);
  });

  it("never fires a disabled half", async () => {
    const review = makeReview({ memoryIntervalTurns: 0, skillIntervalIterations: 0 });
    for (let i = 0; i < 20; i++) {
      review.noteUserTurn();
      review.noteAssistantMessage("x");
    }
    review.onTurnCompleted();
    await fired();
    expect(specs).toHaveLength(0);
  });

  it("does not count turns or fire manually while Learning is off", async () => {
    learningHeld = false;
    const review = makeReview({ memoryIntervalTurns: 1, skillIntervalIterations: 1 });
    review.noteUserTurn();
    review.noteAssistantMessage("x");
    review.onTurnCompleted();
    review.learn();
    await fired();
    expect(specs).toHaveLength(0);

    learningHeld = true;
    review.onTurnCompleted();
    await fired();
    expect(specs).toHaveLength(0);
    await completeUserTurn(review);
    expect(specs).toHaveLength(1);

    await finishReview(review);
  });

  it("refuses a review whose Learning admission lands after the disable", async () => {
    admitReview = false;
    const review = makeReview({ memoryIntervalTurns: 1 });
    review.noteUserTurn();
    review.onTurnCompleted();
    await review.settled();

    expect(specs).toHaveLength(0);
    expect(recorded).toHaveLength(0);
  });

  it("settles an admitted review after Learning is disabled and admits no later one", async () => {
    const review = makeReview({ memoryIntervalTurns: 1 });
    await completeUserTurn(review);
    expect(specs).toHaveLength(1);

    // The user disables Learning while the admitted fork is still running.
    learningHeld = false;
    admitReview = false;
    specs[0]?.learningReview.onWritten({ surface: "skill", name: "landed", action: "created", reach: "project" });
    await finishReview(review);

    // The run settles on the grant it was admitted with: its write lands and its
    // completion fact is recorded.
    expect(specs[0]?.capabilityAccess.available("learning")).toBe(true);
    expect(recorded[0]?.payload.outcome).toBe("acted");

    // Nothing after the disable is new admitted work: the counters stop and no
    // second review is spawned.
    await completeUserTurn(review);
    expect(specs).toHaveLength(1);
  });

  it("skips firing while a review is in flight", async () => {
    const review = makeReview({ memoryIntervalTurns: 1 });
    await completeUserTurn(review);
    await completeUserTurn(review);
    expect(specs).toHaveLength(1);

    await finishReview(review);
  });

  it("records acted outcome and publishes one system message for created and updated skills", async () => {
    const review = makeReview({ memoryIntervalTurns: 1 });
    await completeUserTurn(review);

    const mutationEvidence = await buildMutationDiffEvidence(buildMutationDiff([{ path: "SKILL.md", before: { kind: "absent" }, after: { kind: "text", text: "body\n" } }]), "display", stageContent);
    specs[0]?.learningReview.onWritten({ surface: "skill", name: "new-package", action: "created", reach: "project", mutationEvidence });
    specs[0]?.learningReview.onWritten({ surface: "skill", name: "provider-quirks", action: "patched", reach: "project", mutationEvidence });
    specs[0]?.learningReview.onWritten({ surface: "skill", name: "provider-quirks", action: "support_file", reach: "project", mutationEvidence });
    specs[0]?.learningReview.onWritten({ surface: "memory", name: "memory", action: "batch", reach: "global" });
    await finishReview(review);

    expect(recorded[0]?.payload.outcome).toBe("acted");
    expect(recorded[0]?.payload.actions).toEqual([
      { surface: "skill", name: "new-package", action: "created", reach: "project" },
      { surface: "skill", name: "provider-quirks", action: "patched", reach: "project" },
      { surface: "skill", name: "provider-quirks", action: "support_file", reach: "project" },
      { surface: "memory", name: "memory", action: "batch", reach: "global" },
    ]);
    expect(recorded[0]?.payload.recommendations).toEqual([]);
    expect(notices).toHaveLength(1);
    expect(notices[0]?.content).toBe("Created skill: `new-package`. Updated skill: `provider-quirks`.");
    const combined = notices[0]?.mutationEvidence;
    if (!combined) throw new Error("expected combined evidence");
    expect(combined.applied).toBe(3);
    const page = await readMutationEvidenceFiles(combined, 0, 10, async hash => contentNodes.get(hash) ?? null);
    if (page.kind !== "available") throw new Error("expected display page");
    expect(page.files.map(entry => entry.kind === "display" ? [entry.file.path, entry.file.name, entry.file.action, entry.file.reach] : null)).toEqual([
      ["SKILL.md", "new-package", "created", "project"],
      ["SKILL.md", "provider-quirks", "patched", "project"],
      ["SKILL.md", "provider-quirks", "support_file", "project"],
    ]);
    expect(JSON.stringify(notices[0])).not.toContain("body\\n");
  });

  it("reports a write that published no artifact without one", async () => {
    const review = makeReview({ memoryIntervalTurns: 1 });
    await completeUserTurn(review);

    specs[0]?.learningReview.onWritten({ surface: "skill", name: "new-package", action: "created", reach: "project" });
    await finishReview(review);

    expect(notices).toEqual([{
      content: "Created skill: `new-package`.",
    }]);
  });

  it("flattens many writes into one bounded notice manifest", async () => {
    const review = makeReview({ memoryIntervalTurns: 1 });
    await completeUserTurn(review);
    const mutationEvidence = await buildMutationDiffEvidence(buildMutationDiff([{ path: "SKILL.md", before: { kind: "absent" }, after: { kind: "text", text: "Retained body\n" } }]), "one-write", stageContent);
    for (let index = 0; index < 500; index += 1) {
      specs[0]?.learningReview.onWritten({ surface: "skill", name: "one-package", action: "patched", reach: "project", mutationEvidence });
    }
    await finishReview(review);
    const notice = notices[0];
    expect(notice?.content).toBe("Updated skill: `one-package`.");
    expect(Buffer.byteLength(JSON.stringify(notice))).toBeLessThan(4096);
    if (!notice?.mutationEvidence) throw new Error("expected combined notice");
    expect(notice.mutationEvidence.applied).toBe(500);
    expect(notice.mutationEvidence.samples.length).toBeLessThanOrEqual(3);
    const page = await readMutationEvidenceFiles(notice.mutationEvidence, 499, 1, async hash => contentNodes.get(hash) ?? null);
    if (page.kind !== "available") throw new Error("expected last file page");
    expect(page.files[0]?.kind).toBe("display");
    expect(page.nextOffset).toBeNull();
    expect(Object.keys(notice).sort()).toEqual(["content", "mutationEvidence"]);
  });

  it("contains a spawn failure instead of leaking an unhandled rejection", async () => {
    const review = createLearningReview({
      sessionId: "sess-1",
      capabilities: reviewCapabilities,
      moduleSelection: reviewCapabilityModules,
      config: { memoryIntervalTurns: 1, skillIntervalIterations: 0, notifications: "on" },
      spawnReview: () => Promise.reject(new Error("buildContext exploded")),
    });
    review.noteUserTurn();
    review.onTurnCompleted();
    await review.settled();
    // No fact, no system message, no unhandled rejection: the spawn never happened.
    expect(recorded).toHaveLength(0);

    // The counters were reset at fire time, so the cadence restarts cleanly.
    review.noteUserTurn();
    review.onTurnCompleted();
    await review.settled();
  });

  it("records failed outcome when the fork dies", async () => {
    failReview = true;
    const review = makeReview({ memoryIntervalTurns: 1 });
    review.noteUserTurn();
    review.onTurnCompleted();
    await review.settled();

    expect(recorded[0]?.payload.outcome).toBe("failed");
  });

  // An abort is the review's owner ending it: the session or workflow host
  // closed, or the runtime stopped. Its record says so and reports no failure.
  it("records failed outcome, with no notice, when the fork's run ends aborted or in a provider error, and warns only for the error", async () => {
    const reviewLog = Log.create({ service: "learning-review" });
    const warn = spyOn(reviewLog, "warn").mockImplementation(() => {});
    const info = spyOn(reviewLog, "info").mockImplementation(() => {});
    try {
      for (const [terminal, settledAs] of [[{ kind: "aborted" }, "aborted"], [{ kind: "api_error", message: "overloaded", recovery: { kind: "none" } }, "failed"]] satisfies [AgentRunTerminal, string][]) {
        recorded = [];
        reviewTerminal = terminal;
        const review = makeReview({ memoryIntervalTurns: 1 });
        await completeUserTurn(review);
        await finishReview(review);
        expect(recorded[0]?.payload.outcome).toBe("failed");
        expect(info.mock.calls.findLast(([message]) => message === "learning review settled")?.[1]).toMatchObject({ outcome: settledAs });
      }
      expect(warn.mock.calls.filter(([message]) => message === "learning review failed").map(([, fields]) => fields)).toEqual([expect.objectContaining({ terminal: "api_error" })]);
    } finally {
      warn.mockRestore();
      info.mockRestore();
    }
    expect(notices).toEqual([]);
  });

  it("publishes no system message for memory, archive-only, no-op, or failed reviews", async () => {
    const memoryReview = makeReview({ memoryIntervalTurns: 1 });
    memoryReview.noteUserTurn();
    memoryReview.onTurnCompleted();
    await fired();
    specs[0]?.learningReview.onWritten({ surface: "memory", name: "memory", action: "batch", reach: "global" });
    specs[0]?.learningReview.onWritten({ surface: "skill", name: "retired", action: "archived", reach: "project" });
    await finishReview(memoryReview);
    expect(notices).toEqual([]);

    const noOpReview = makeReview({ memoryIntervalTurns: 1 });
    noOpReview.noteUserTurn();
    noOpReview.onTurnCompleted();
    await fired();
    await finishReview(noOpReview);
    expect(notices).toEqual([]);

    failReview = true;
    const failedReview = makeReview({ memoryIntervalTurns: 1 });
    failedReview.noteUserTurn();
    failedReview.onTurnCompleted();
    await fired();
    await failedReview.settled();
    expect(notices).toEqual([]);

    failReview = false;
    const silentReview = makeReview({ memoryIntervalTurns: 1, notifications: "off" });
    silentReview.noteUserTurn();
    silentReview.onTurnCompleted();
    await fired();
    specs[3]?.learningReview.onWritten({ surface: "skill", name: "silent", action: "created", reach: "project" });
    await finishReview(silentReview);
    expect(notices).toEqual([]);
  });

  it("fires the combined review immediately on reflect with the manual trigger", async () => {
    const review = makeReview();
    review.learn();
    await fired();

    expect(specs).toHaveLength(1);
    expect(specs[0]?.instruction).toContain("Act on each destination the classifier selects");
    await finishReview(review);
    expect(recorded[0]?.payload.trigger).toBe("manual");
  });

  it("answers a review the person asked for with its result, also while notifications are off", async () => {
    const review = makeReview({ notifications: "off" });
    review.learn();
    await fired();
    await finishReview(review);
    expect(notices.map((notice) => notice.content)).toEqual(["The learning review found nothing to save from this chat."]);

    review.learn();
    await fired();
    specs[1]?.learningReview.onWritten({ surface: "memory", name: "user", action: "added", reach: "global" });
    specs[1]?.learningReview.onWritten({ surface: "skill", name: "deploy", action: "created", reach: "project" });
    await finishReview(review);
    expect(notices[1]?.content).toBe("The learning review finished. Created skill: `deploy`. Saved 1 memory entry.");

    failReview = true;
    review.learn();
    await fired();
    await review.settled();
    expect(notices[2]?.content).toBe("The learning review could not finish. Run /learn to try again.");
  });
});

  it("applies captured request policy at completion and retains it while the review is in flight", async () => {
    const review = makeReview({ memoryIntervalTurns: 99, skillIntervalIterations: 99, notifications: "on" });
    review.noteUserTurn();
    review.onTurnCompleted({ memoryIntervalTurns: 1, skillIntervalIterations: 0, notifications: "off" });
    await fired();

    expect(specs).toHaveLength(1);
    specs[0]?.learningReview.onWritten({ surface: "skill", name: "silent", action: "created", reach: "project" });
    await finishReview(review);
    expect(notices).toEqual([]);

    review.noteUserTurn();
    review.onTurnCompleted({ memoryIntervalTurns: 2, skillIntervalIterations: 0, notifications: "on" });
    await fired();
    expect(specs).toHaveLength(1);
    review.noteUserTurn();
    review.onTurnCompleted({ memoryIntervalTurns: 2, skillIntervalIterations: 0, notifications: "on" });
    await fired();
    expect(specs).toHaveLength(2);
  });

describe("replay", () => {
  function user(text: string, origin?: "system"): ConversationMessage {
    return origin ? { kind: "user", content: text, origin } : { kind: "user", content: text };
  }
  function assistant(blocks?: Array<{ name: string }>): ConversationMessage {
    return {
      kind: "assistant",
      content: blocks ? blocks.map((b) => ({ type: "tool_use" as const, id: "t", name: b.name, input: {} })) : "text",
    };
  }

  it("derives cadence position from the persisted conversation, modulo the interval", async () => {
    const review = makeReview({ memoryIntervalTurns: 3, skillIntervalIterations: 4 });
    await review.replay([
      user("one"),
      assistant(),
      user("two"),
      assistant([{ name: "skill_manage" }]),
      user("three"),
      user("nudge", "system"),
      assistant(),
    ]);
    // 3 user turns % 3 = 0; 1 assistant since skill_manage.
    review.onTurnCompleted();
    await fired();
    expect(specs).toHaveLength(0);

    // Two more real user turns reach the memory threshold... 0 + 3 = 3.
    review.noteUserTurn();
    review.noteUserTurn();
    await completeUserTurn(review);
    expect(specs).toHaveLength(1);

    await finishReview(review);
  });

  it("resets derivation at the model's own memory writes", async () => {
    const review = makeReview({ memoryIntervalTurns: 2 });
    await review.replay([
      user("one"),
      user("two"),
      assistant([{ name: "memory" }]),
      user("three"),
    ]);
    review.onTurnCompleted();
    await fired();
    // Only one user turn since the memory write: not due.
    expect(specs).toHaveLength(0);
  });

  it("adds turns noted while the replay runs to the replayed position", async () => {
    const review = makeReview({ memoryIntervalTurns: 2, skillIntervalIterations: 2 });
    const replaying = review.replay([user("one"), assistant()]);
    review.noteUserTurn();
    review.noteAssistantMessage("text");
    await replaying;
    review.onTurnCompleted();
    await fired();
    // 1 replayed + 1 live user turn, 1 replayed + 1 live LLM call: both due.
    expect(specs).toHaveLength(1);
    expect(specs[0]?.instruction).toContain("Act on each destination the classifier selects");

    await finishReview(review);
  });

  it("keeps a reset noted while the replay runs over the replayed position", async () => {
    const review = makeReview({ memoryIntervalTurns: 3 });
    const replaying = review.replay([user("one"), user("two")]);
    review.noteAssistantMessage([{ type: "tool_use", name: "memory" }]);
    await replaying;
    await completeUserTurn(review);
    // One user turn since the live memory write: not due.
    expect(specs).toHaveLength(0);
  });
});

describe("cost attribution", () => {
  it("records the fork's usage totals in the completion fact when the spawn reports them", async () => {
    const review = createLearningReview({
      sessionId: "sess-1",
      capabilities: reviewCapabilities,
      moduleSelection: reviewCapabilityModules,
      config: { memoryIntervalTurns: 1, skillIntervalIterations: 0, notifications: "on" },
      sessionEventWriter: recordingWriter(),
      spawnReview: () => Promise.resolve({
        done: Promise.resolve({ servedRequests: 0, durationMs: 1, terminal: { kind: "completed" } }),
        model: "aux-model",
        usage: () => ({ costUsd: 0.0123, inputTokens: 9000, outputTokens: 250, cacheReadTokens: 8000 }),
        recordSystemMessage: () => Promise.resolve(),
      }),
    });
    review.noteUserTurn();
    review.onTurnCompleted();
    await review.settled();

    expect(recorded[0]?.payload.model).toBe("aux-model");
    expect(recorded[0]?.payload.costUsd).toBe(0.0123);
    expect(recorded[0]?.payload.inputTokens).toBe(9000);
    expect(recorded[0]?.payload.outputTokens).toBe(250);
    expect(recorded[0]?.payload.cacheReadTokens).toBe(8000);
  });

  it("omits the usage fields when the spawn has no usage report", async () => {
    const review = makeReview({ memoryIntervalTurns: 1 });
    await completeUserTurn(review);
    await finishReview(review);

    expect(recorded[0]?.payload).not.toHaveProperty("costUsd");
  });
});

describe("live review budget accounting", () => {
  it("accumulates committed usage deltas on a distinct review stream and retires it once", () => {
    const published: Parameters<Parameters<typeof createReviewUsageAccounting>[1]>[0][] = [];
    const accounting = createReviewUsageAccounting("review-1", (event) => {
      published.push(event);
    });

    for (const [id, cost, input, output, cacheRead] of [["usage-1", 0.03, 300, 40, 100], ["usage-2", 0.02, 200, 10, 50]] as const) {
      accounting.observe({
        type: "model.usage.measured",
        data: {
          usage_entry: { attemptId: id === "usage-1" ? "00000000-0000-4000-8000-000000000001" : "00000000-0000-4000-8000-000000000002", occurredAt: "2026-09-02T00:00:00.000Z", profileId: "test", attribution: { kind: "unattributed" }, spendMode: "direct_api", credentialLineage: "10000000-0000-4000-8000-000000000001", model: "test", tokens: { input, output, cacheRead, cacheWrite: 0, reasoning: 0 }, classification: "real_spend", price: { kind: "priced", estimatedUsd: cost, rateCard: {}, provenance: "test" }, currency: "USD", coverage: "complete" },
          budget_stream_id: "source-stream",
        },
      });
    }
    accounting.finish();
    accounting.finish();

    expect(published).toHaveLength(3);
    expect(published[0]).toMatchObject({ type: "model.usage.measured", data: { budget_stream_id: "learning-review:review-1", usage_entry: { price: { kind: "priced", estimatedUsd: 0.03 } } } });
    expect(published[1]).toMatchObject({ type: "model.usage.measured", data: { budget_stream_id: "learning-review:review-1", usage_entry: { price: { kind: "priced", estimatedUsd: 0.02 } } } });
    expect(published[2]).toEqual({ type: "budget.stream.completed", data: { budget_stream_id: "learning-review:review-1" } });
    expect(accounting.usage()).toEqual({
      costUsd: 0.05,
      inputTokens: 500,
      outputTokens: 50,
      cacheReadTokens: 150,
    });
  });
});

describe("global recommendations are recorded, never written", () => {
  const RECOMMENDATION = {
    recommendationId: "a".repeat(64),
    name: "deploy-runbook",
    action: "promote" as const,
    reach: "global" as const,
    packageIdentity: { sha256: "b".repeat(64), bytes: 128 },
    summary: "Promote project skill \"deploy-runbook\" to global reach.",
  };

  it("records a recommendation, notifies the live agent, and writes no transcript notice", async () => {
    const review = makeReview({ memoryIntervalTurns: 1 });
    await completeUserTurn(review);

    specs[0]?.learningReview.onRecommended(RECOMMENDATION);
    await finishReview(review);

    // A recommendation writes nothing, so it is not a skill action, but the
    // review still acted: the fact carries the identity a later turn asks about.
    expect(recorded[0]?.payload.outcome).toBe("acted");
    expect(recorded[0]?.payload.actions).toEqual([]);
    expect(recorded[0]?.payload.recommendations).toEqual([
      { recommendationId: RECOMMENDATION.recommendationId, name: "deploy-runbook", action: "promote", reach: "global" },
    ]);
    // Live half of delivery: the host is offered the recommendation for a
    // between-tool-calls notification. Durable delivery stays with the
    // reconciliation sweep, so no transcript notice is written here.
    expect(notified).toEqual([RECOMMENDATION]);
    expect(notices).toEqual([]);
  });
});
