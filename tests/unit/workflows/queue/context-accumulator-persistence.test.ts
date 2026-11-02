import { describe, expect, test } from "bun:test";
import { accumulatorStateFromProjection, contextFromProjection, createWorkflowContextProjection, loadAccumulatedContextFromEvents, loadContextStateFromEvents } from "../../../../src/workflows/context-bundle/context-projection.js";
import { buildContextAccumulatedFact, buildContextInputAddedFact, buildContextInputSeededFact, parseWorkflowContextFact, type WorkflowContextFact } from "../../../../src/workflows/context-bundle/context-facts.js";
import { makeEntry } from "./_context-accumulator-fixtures.js";
import { inMemoryEventReader } from "../../../helpers/in-memory-event-reader.js";
import { initializedWorkflowRoot, recoveredWorkflowRoot, storedWorkflowFacts } from "../../../helpers/workflow-root-fixtures.js";
import { InvariantViolation } from "../../../../src/infra/invariant.js";
import { asAsyncEventReadSurface, type StoredFact } from "../../../../src/infra/event-store-types.js";

function persistedContextFacts(): WorkflowContextFact[] {
  return [
    buildContextInputSeededFact("wf", "verbatim request"),
    buildContextAccumulatedFact(makeEntry({
      entryId: "plan",
      agentName: "Plan",
      writes: [{ id: "plan", lifetime: "durable", supersedes: [] }],
      handoff: { version: 1 },
      timestamp: 2,
    })),
    buildContextAccumulatedFact(makeEntry({
      entryId: "review",
      agentName: "Review",
      writes: [{ id: "reviewed-plan", lifetime: "durable", supersedes: ["plan"] }],
      handoff: { version: 2 },
      timestamp: 3,
    })),
  ];
}

describe("context accumulator persistence", () => {
  test("reads the persisted input through the async authority without changing its facts", async () => {
    const events: StoredFact[] = storedWorkflowFacts([initializedWorkflowRoot, buildContextInputSeededFact("wf", "verbatim request")]);
    const sourceBytes = JSON.stringify(events);
    const projectionReader = asAsyncEventReadSurface(inMemoryEventReader(events));
    const state = await createWorkflowContextProjection(projectionReader, "session").replay();
    expect(JSON.stringify(contextFromProjection(state))).toContain("verbatim request");
    expect(JSON.stringify(events)).toBe(sourceBytes);
  });

  test("retains the ordinary launch seed before initialized control", async () => {
    const initialized = {
      ...initializedWorkflowRoot,
      payload: { control: { ...initializedWorkflowRoot.payload.control, aggregateSeq: 2 } },
    };
    const events = storedWorkflowFacts([buildContextInputSeededFact("wf", "original"), initialized]);
    const projection = createWorkflowContextProjection(asAsyncEventReadSurface(inMemoryEventReader(events)), "session");
    expect(contextFromProjection(await projection.replay()).request?.original).toBe("original");
    expect(loadContextStateFromEvents(events)?.artifacts["user-request"]?.value).toBe("original");
  });

  test.each(["cold", "replay", "apply"] as const)("recovered context drops superseded artifacts before parsing poison on %s", async (mode) => {
    const events = storedWorkflowFacts([initializedWorkflowRoot, ...persistedContextFacts()]);
    const reader = inMemoryEventReader(events);
    const projectionReader = asAsyncEventReadSurface(reader);
    const held = mode === "cold" ? null : createWorkflowContextProjection(projectionReader, "session");
    const snapshot = held ? accumulatorStateFromProjection(await held.replay()) : null;
    events.push({ ...storedWorkflowFacts([buildContextInputSeededFact("wf", "poison")], 4)[0]!, payload: {} });
    events.push(...storedWorkflowFacts([
      recoveredWorkflowRoot(initializedWorkflowRoot.payload.control, 7),
      buildContextInputSeededFact("wf", "recovered request"),
    ], 5));
    const projection = held ?? createWorkflowContextProjection(projectionReader, "session");
    if (mode === "apply") await projection.apply(events.slice(4));
    const state = mode === "apply" ? projection.getState() : await projection.replay();
    expect(contextFromProjection(state)).toMatchObject({ request: { original: "recovered request" }, artifacts: [] });
    expect(projection.getPosition()).toBe(70);
    expect(createWorkflowContextProjection(projectionReader, "session")).toBe(projection);
    expect(loadContextStateFromEvents(events)).toEqual(accumulatorStateFromProjection(state));
    if (snapshot) expect(snapshot.entries).toHaveLength(2);
    const second = storedWorkflowFacts([
      recoveredWorkflowRoot(initializedWorkflowRoot.payload.control, 9),
      buildContextInputSeededFact("wf", "latest request"),
    ], 7);
    events.push(...second);
    if (mode === "apply") await projection.apply(second);
    expect(contextFromProjection(await projection.replay())).toMatchObject({ request: { original: "latest request" }, artifacts: [] });
    expect(Object.keys(loadContextStateFromEvents(events)?.artifacts ?? {})).toEqual(["user-request"]);
    expect(events[4]?.payload).toEqual({});
  });

  test("reads the context facts that builds before the agent lexicon stored under attempt, agent, and item words", () => {
    const list = "wf:node:2";
    const item = `${list}:item:1`;
    const lane = `${item}:phase:1:attempt:1`;
    const branch = { _tag: "branch", groupNodeId: list, branchNodeId: item, key: "a" };
    const readBy = { stepId: "plan-1", stepName: "Plan", conversationId: "conversation-1" };
    const parent = { kind: "parent", name: "Chat" };
    const entry = { stepId: "plan-1", stepName: "Plan", definitionId: "plan", workflowDefinitionId: "wf", recipientStepId: null, writes: [{ id: "plan", lifetime: "transient" }], timestamp: 2, handoff: { summary: "planned" } };
    const stored = [
      { type: "context.accumulated", version: 4, actor: "flywheel", payload: { entry } },
      { type: "context.accumulated", version: 5, actor: "flywheel", payload: { entry: { ...entry, stepId: lane, stepName: "Lane", writes: [{ id: "lane", lifetime: "transient" }], timestamp: 3 }, scope: branch } },
      { type: "step_context.input.added", version: 1, actor: "flywheel", payload: { key: "read", source: parent, text: "Use SQLite.", readBy } },
      { type: "step_context.input.added", version: 2, actor: "flywheel", payload: { key: "lane-read", source: parent, text: "Lane a only.", readBy: { ...readBy, stepId: lane, stepName: "Lane" }, scope: branch } },
      { type: "step_context.input.added", version: 3, actor: "flywheel", payload: { key: "addressed", source: { kind: "person" }, text: "Cite the ADR.", addressedTo: [branch, { _tag: "step", nodeId: "wf:node:3", stepId: "review" }] } },
    ].map(parseWorkflowContextFact);
    const events = storedWorkflowFacts([initializedWorkflowRoot, buildContextInputSeededFact("wf", "request"), ...stored]);

    expect(loadContextStateFromEvents(events)?.entries.map(({ entryId, agentName, recipientAttemptId }) => [entryId, agentName, recipientAttemptId])).toEqual([
      ["plan-1", "Plan", null],
      [lane, "Lane", null],
    ]);
    const reader = loadAccumulatedContextFromEvents(events, { attemptId: `${item}:phase:2:attempt:1`, scope: { _tag: "item", listNodeId: list, itemNodeId: item, key: "a", sharedEntryIds: ["plan-1"] } });
    expect(reader.priorHandoff?.entryId).toBe(lane);
    expect<unknown>(reader.request?.addenda).toEqual([
      { key: "read", source: parent, text: "Use SQLite.", readBy: { attemptId: "plan-1", agentName: "Plan", conversationId: "conversation-1" } },
      { key: "lane-read", source: parent, text: "Lane a only.", readBy: { attemptId: lane, agentName: "Lane", conversationId: "conversation-1" } },
      { key: "addressed", source: { kind: "person" }, text: "Cite the ADR.", addressedTo: [{ _tag: "item", listNodeId: list, itemNodeId: item, key: "a" }, { _tag: "agent", nodeId: "wf:node:3", definitionId: "review" }] },
    ]);
  });

  test("folds request addenda in order beside the prior handoff, and refuses a repeated key", async () => {
    const readBy = { attemptId: "plan-1", agentName: "Plan", conversationId: "conversation-1" };
    const first = buildContextInputAddedFact({ key: "msg:parent:tool-1", source: { kind: "parent", name: "Chat" }, text: "Use SQLite.", readBy });
    const second = buildContextInputAddedFact({
      key: "msg:parent:tool-2", source: { kind: "parent", name: "Chat" }, text: "Skip the CLI.",
      personWords: "no cli please", attachmentCount: 2, readBy,
    });
    const events = storedWorkflowFacts([
      initializedWorkflowRoot,
      buildContextInputSeededFact("wf", "verbatim request"),
      buildContextAccumulatedFact(makeEntry({ entryId: "plan-1", agentName: "Plan", writes: [{ id: "plan", lifetime: "transient" }], handoff: { summary: "raw plan" }, timestamp: 2 })),
      first,
      second,
    ]);
    const projection = createWorkflowContextProjection(asAsyncEventReadSurface(inMemoryEventReader(events)), "session");
    const context = contextFromProjection(await projection.replay());
    expect(context.request).toEqual({ original: "verbatim request", addenda: [first.payload, second.payload] });
    expect(context.priorHandoff?.entryId).toBe("plan-1");
    expect(loadContextStateFromEvents(events)?.addenda).toEqual([first.payload, second.payload]);

    events.push(...storedWorkflowFacts([first], events.length));
    await expect(projection.replay()).rejects.toMatchObject({ _tag: "InvariantViolation", kind: "duplicate-event", eventPosition: events.length * 10 });
  });

  test.each([1, 99])("a malformed recovered root version %s fences every context read", async (version) => {
    const events = storedWorkflowFacts([initializedWorkflowRoot, ...persistedContextFacts()]);
    const reader = inMemoryEventReader(events);
    const projection = createWorkflowContextProjection(asAsyncEventReadSurface(reader), "session");
    // A recovery commits its root with the context seed it starts from in one batch.
    const [recovered, seed] = storedWorkflowFacts([recoveredWorkflowRoot(initializedWorkflowRoot.payload.control, 6), buildContextInputSeededFact("wf", "recovered request")], 4);
    const root = { ...recovered!, version, payload: {} };
    events.push(root, seed!);
    await expect(projection.replay()).rejects.toThrow(InvariantViolation);
    await expect(projection.apply([root, seed!])).rejects.toThrow(InvariantViolation);
    await expect(createWorkflowContextProjection(asAsyncEventReadSurface(inMemoryEventReader(events)), "session").replay()).rejects.toThrow(InvariantViolation);
    expect(() => loadContextStateFromEvents(events)).toThrow(InvariantViolation);
  });
});
