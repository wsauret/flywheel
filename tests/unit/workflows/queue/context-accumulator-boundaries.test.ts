import { describe, expect, test } from "bun:test";
import { createContextAccumulator, expandJoinReferences, JOIN_EXPANSION_CAP_BYTES } from "../../../../src/workflows/context-bundle/context";
import { makeEntry } from "./_context-accumulator-fixtures";
import { renderWorkflowRequest } from "../../../../src/workflows/context-bundle/workflow-request";

describe("pipeline context liveness", () => {
  test("a transient handoff is available only until the next accepted handoff", () => {
    const accumulator = createContextAccumulator();
    accumulator.accumulate(makeEntry({
      entryId: "plan",
      agentName: "Plan",
      writes: [{ id: "plan", lifetime: "transient" }],
      handoff: { summary: "raw plan" },
    }));
    expect(accumulator.getContext().priorHandoff?.entryId).toBe("plan");
    expect(accumulator.getContext().artifacts).toEqual([]);

    accumulator.accumulate(makeEntry({
      entryId: "review",
      agentName: "Review",
      writes: [{ id: "reviewed-plan", lifetime: "durable", supersedes: ["plan"] }],
      handoff: { summary: "reviewed plan" },
    }));
    expect(accumulator.getContext().priorHandoff).toBeNull();
    expect(accumulator.getContext().artifacts.map(({ id }) => id)).toEqual(["reviewed-plan"]);
  });

  test("reviewed-plan suppresses plan even after a stale same-id plan write", () => {
    const accumulator = createContextAccumulator();
    for (const [entryId, id, supersedes, version] of [
      ["plan-1", "plan", [], 1],
      ["review", "reviewed-plan", ["plan"], 2],
      ["plan-2", "plan", [], 3],
    ] as const) {
      accumulator.accumulate(makeEntry({
        entryId,
        agentName: entryId,
        writes: [{ id, lifetime: "durable", supersedes: [...supersedes] }],
        handoff: { version },
      }));
    }
    expect(accumulator.getContext().artifacts).toMatchObject([
      { id: "reviewed-plan", value: { version: 2 } },
    ]);
  });

  test("same-id durable writes keep the latest value", () => {
    const accumulator = createContextAccumulator();
    for (const version of [1, 2]) {
      accumulator.accumulate(makeEntry({
        entryId: `implementation-${version}`,
        agentName: "Implement",
        writes: [{ id: "implementation", lifetime: "durable", supersedes: [] }],
        handoff: { version },
      }));
    }
    expect(accumulator.getContext().artifacts).toMatchObject([
      { id: "implementation", value: { version: 2 } },
    ]);
  });
});

describe("workflow context scope", () => {
  test("gives a workflow-scope attempt its frozen bundle only, never a sibling entry recorded after it started", () => {
    const accumulator = createContextAccumulator();
    // Evidence that a recovery root inherited names no attempt of the run.
    accumulator.accumulate(makeEntry({ entryId: "prior-attempt", agentName: "Prior", writes: [{ id: "retained", lifetime: "durable", supersedes: [] }], handoff: { summary: "inherited" } }));
    accumulator.accumulate(makeEntry({ entryId: "flow:node:1:attempt:1", agentName: "Plan", writes: [{ id: "plan", lifetime: "durable", supersedes: [] }], handoff: { summary: "plan" } }));
    // Sibling a runs beside b and commits while b still runs.
    accumulator.accumulate(makeEntry({ entryId: "flow:node:2:attempt:1", agentName: "A", writes: [{ id: "a-out", lifetime: "durable", supersedes: [] }], handoff: { summary: "a" } }));
    const context = accumulator.getContext({ attemptId: "flow:node:3:attempt:1", scope: { _tag: "workflow", sharedEntryIds: ["flow:node:1:attempt:1"] } });
    expect(context.artifacts.map(({ id }) => id).toSorted()).toEqual(["plan", "retained"]);
    expect(context.exclusions).toEqual([{ kind: "entry", id: "flow:node:2:attempt:1", reason: "after_admission" }]);
    // Without a bundle the scope is the whole workflow.
    expect(accumulator.getContext({ attemptId: null, scope: { _tag: "workflow" } }).artifacts.map(({ id }) => id).toSorted()).toEqual(["a-out", "plan", "retained"]);
  });
});

describe("branch context scope", () => {
  const group = "flow:node:2";
  const scope = (ordinal: number, key: string) => ({ _tag: "item", listNodeId: group, itemNodeId: `${group}:branch:${ordinal}`, key } as const);
  const addendum = (key: string, extra: { readonly personWords?: string } = {}) => ({
    key,
    source: { kind: "parent", name: "parent" } as const,
    text: `reply ${key}`,
    ...extra,
    readBy: { attemptId: "reader", agentName: "Reader", conversationId: "conversation" },
  });
  const origin = { position: 1, aggregateId: "workflow:test" };
  const branchEntry = (ordinal: number, key: string, content: { readonly [field: string]: unknown } = { summary: `done ${key}` }) => makeEntry({
    timestamp: 1,
    entryId: `${group}:branch:${ordinal}:stage:1:attempt:1`,
    agentName: "Implement",
    writes: [{ id: "change", lifetime: "transient" }],
    handoff: content,
  });
  const joinEntry = (keys: readonly string[]) => makeEntry({
    timestamp: 2,
    entryId: `${group}:join`,
    agentName: "Per item",
    definitionId: "per-item",
    writes: [{ id: "reviews", lifetime: "durable", supersedes: [] }],
    handoff: {
      total: keys.length, completed: keys.length, failed: 0,
      items: keys.toSorted().map((key, index) => ({ key, disposition: "completed", handoff: { step_id: `${group}:branch:${index + 1}:stage:1:attempt:1`, sha256: "0".repeat(64) } })),
    },
  });
  const plan = makeEntry({ timestamp: 0, entryId: "plan-1", agentName: "Plan", writes: [{ id: "plan", lifetime: "durable", supersedes: [] }], handoff: { summary: "plan" } });

  /** One run: the plan, then branches a and b settle in `order`, each with a
   *  group-local parent reply, then the join. */
  function settled(order: readonly ("a" | "b")[]) {
    const accumulator = createContextAccumulator();
    accumulator.seedInput({ workflowDefinitionId: "flow", userRequest: "Do it.", timestamp: 1 });
    accumulator.accumulate(plan);
    for (const key of order) {
      const ordinal = key === "a" ? 1 : 2;
      accumulator.add(addendum(`reply-${key}`), origin, scope(ordinal, key));
      accumulator.accumulate(branchEntry(ordinal, key), scope(ordinal, key));
    }
    accumulator.accumulate(joinEntry(["a", "b"]));
    return accumulator;
  }

  test("gives a branch the frozen shared bundle, its own records, and every live person record", () => {
    const accumulator = createContextAccumulator();
    accumulator.seedInput({ workflowDefinitionId: "flow", userRequest: "Do it.", timestamp: 1 });
    accumulator.accumulate(plan);
    accumulator.add(addendum("person", { personWords: "Use the new API." }), origin);
    accumulator.add(addendum("reply-b"), origin, scope(2, "b"));
    accumulator.accumulate(branchEntry(2, "b"), scope(2, "b"));
    accumulator.accumulate(makeEntry({ entryId: "late-1", agentName: "Late", writes: [{ id: "late", lifetime: "durable", supersedes: [] }], handoff: { summary: "late" } }));
    const context = accumulator.getContext({ attemptId: `${group}:branch:1:stage:1:attempt:1`, scope: { ...scope(1, "a"), sharedEntryIds: ["plan-1"] } });
    expect(context.artifacts.map(({ id }) => id)).toEqual(["plan"]);
    expect(context.request?.addenda.map(({ key }) => key)).toEqual(["person"]);
    expect(context.exclusions).toEqual([
      { kind: "addendum", id: "reply-b", reason: "sibling_item" },
      { kind: "entry", id: `${group}:branch:2:stage:1:attempt:1`, reason: "sibling_item" },
      { kind: "entry", id: "late-1", reason: "after_admission" },
    ]);
    const own = accumulator.getContext({ attemptId: `${group}:branch:2:stage:2:attempt:1`, scope: { ...scope(2, "b"), sharedEntryIds: ["plan-1"] } });
    expect(own.priorHandoff?.entryId).toBe(`${group}:branch:2:stage:1:attempt:1`);
    expect(own.request?.addenda.map(({ key }) => key)).toEqual(["person", "reply-b"]);
    // The workflow scope sees no group-local record before the join.
    expect(accumulator.getContext().exclusions).toContainEqual({ kind: "addendum", id: "reply-b", reason: "list_local" });
  });

  test("gives a message addressed to two of four lanes to those lanes only, and to everyone after their join", () => {
    const accumulator = createContextAccumulator();
    accumulator.seedInput({ workflowDefinitionId: "flow", userRequest: "Do it.", timestamp: 1 });
    accumulator.accumulate(plan);
    accumulator.address({
      key: "msg:parent:call-1",
      source: { kind: "parent", name: "parent" },
      text: "Keep the old flag names.",
      addressedTo: [scope(2, "b"), scope(4, "d")],
    }, origin);
    accumulator.address({ key: "person-1", source: { kind: "person" }, text: "Cite the ADR.", addressedTo: [{ _tag: "agent", nodeId: "flow:node:3:node:2", definitionId: "review" }] }, origin);
    const lane = (ordinal: number, key: string, stage = 1) => accumulator.getContext({
      attemptId: `${group}:branch:${ordinal}:stage:${stage}:attempt:1`,
      nodeId: `${group}:branch:${ordinal}:stage:${stage}`,
      scope: { ...scope(ordinal, key), sharedEntryIds: ["plan-1"] },
    });
    const addressed = (ordinal: number, key: string, stage?: number) => lane(ordinal, key, stage).request?.addenda.map(({ key: addendumKey }) => addendumKey);
    expect(addressed(2, "b")).toEqual(["msg:parent:call-1"]);
    expect(addressed(4, "d", 2)).toEqual(["msg:parent:call-1"]);
    expect(addressed(1, "a")).toEqual([]);
    expect(addressed(3, "c")).toEqual([]);
    expect(lane(1, "a").exclusions).toContainEqual({ kind: "addendum", id: "msg:parent:call-1", reason: "sibling_item" });
    expect(renderWorkflowRequest(lane(2, "b").request!)).toContain('1. From the parent "parent", addressed to item "b" and item "d":\nKeep the old flag names.');
    // The workflow scope reads the lanes' message only after their join, and
    // the step's message never.
    expect(accumulator.getContext().exclusions).toEqual([
      { kind: "addendum", id: "msg:parent:call-1", reason: "addressed_elsewhere" },
      { kind: "addendum", id: "person-1", reason: "addressed_elsewhere" },
    ]);
    expect(accumulator.getContext({ attemptId: "review", nodeId: "flow:node:3:node:2", scope: { _tag: "workflow" } }).request?.addenda.map(({ key }) => key)).toEqual(["person-1"]);
    accumulator.accumulate(joinEntry(["a", "b", "c", "d"]));
    expect(accumulator.getContext().request?.addenda.map(({ key }) => key)).toEqual(["msg:parent:call-1"]);
    expect(() => accumulator.address({ key: "person-1", source: { kind: "person" }, text: "Again.", addressedTo: [scope(1, "a")] }, origin)).toThrow("already recorded");
  });

  test("gives a message addressed to the whole workflow to every lane and every later step at once, and once after the join", () => {
    const accumulator = createContextAccumulator();
    accumulator.seedInput({ workflowDefinitionId: "flow", userRequest: "Do it.", timestamp: 1 });
    accumulator.accumulate(plan);
    accumulator.address({ key: "msg:parent:call-1", source: { kind: "parent", name: "parent" }, text: "Use the new API.", addressedTo: [{ _tag: "workflow" }] }, origin);
    const lane = (ordinal: number, key: string, stage = 1) => accumulator.getContext({
      attemptId: `${group}:branch:${ordinal}:stage:${stage}:attempt:1`,
      nodeId: `${group}:branch:${ordinal}:stage:${stage}`,
      // Every lane froze its shared bundle before the message, which the
      // bundle does not hold.
      scope: { ...scope(ordinal, key), sharedEntryIds: ["plan-1"] },
    });
    const addenda = (ordinal: number, key: string, stage?: number) => lane(ordinal, key, stage).request?.addenda.map(({ key: addendumKey }) => addendumKey);
    for (const [ordinal, key] of [[1, "a"], [2, "b"], [3, "c"], [4, "d"]] as const) expect(addenda(ordinal, key)).toEqual(["msg:parent:call-1"]);
    expect(addenda(1, "a", 2)).toEqual(["msg:parent:call-1"]);
    expect(lane(3, "c").exclusions).toEqual([]);
    expect(renderWorkflowRequest(lane(3, "c").request!)).toContain('1. From the parent "parent", addressed to the workflow:\nUse the new API.');
    accumulator.accumulate(joinEntry(["a", "b", "c", "d"]));
    expect(accumulator.getContext().request?.addenda.map(({ key }) => key)).toEqual(["msg:parent:call-1"]);
    expect(accumulator.getContext().exclusions.filter(({ kind }) => kind === "addendum")).toEqual([]);
  });

  test("gives each read output only to the step that names it, once, under its id, with the join expanded", () => {
    const accumulator = createContextAccumulator();
    accumulator.seedInput({ workflowDefinitionId: "flow", userRequest: "Do it.", timestamp: 1 });
    const scout = (attempt: number) => makeEntry({ entryId: `flow:node:1:attempt:${attempt}`, agentName: "Scout", definitionId: "scout", writes: [{ id: "scout", lifetime: "transient" }], handoff: { modules: [`try ${attempt}`] } });
    accumulator.accumulate(scout(1));
    accumulator.accumulate(scout(2));
    // A follow-up of the `then` chain runs at the same node; reading the
    // step entry reads the named step's handoff, not the follow-up's.
    accumulator.accumulate(makeEntry({ entryId: "flow:node:1:attempt:3", agentName: "Confirm", definitionId: "confirm", writes: [{ id: "confirm", lifetime: "transient" }], handoff: { summary: "confirmed" } }));
    for (const [ordinal, key] of [[1, "a"], [2, "b"]] as const) accumulator.accumulate(branchEntry(ordinal, key), scope(ordinal, key));
    accumulator.accumulate(joinEntry(["a", "b"]));
    accumulator.accumulate(makeEntry({ entryId: "flow:node:3:attempt:1", agentName: "Check", writes: [{ id: "check", lifetime: "transient" }], handoff: { summary: "checked" } }));
    const reads = [
      { id: "reviews", kind: "join", nodeId: group },
      { id: "scout", kind: "agent", nodeId: "flow:node:1", definitionId: "scout" },
      { id: "check", kind: "agent", nodeId: "flow:node:3", definitionId: "test-step" },
    ] as const;

    const reader = accumulator.getContext({ attemptId: "flow:node:4:attempt:1", nodeId: "flow:node:4", scope: { _tag: "workflow" }, reads });
    expect(reader.reads.map(({ id, entry }) => [id, entry.entryId])).toEqual([["reviews", `${group}:join`], ["scout", "flow:node:1:attempt:2"], ["check", "flow:node:3:attempt:1"]]);
    expect(reader.reads[0]?.entry.handoff.items).toMatchObject([{ key: "a", handoff: { content: { summary: "done a" } } }, { key: "b", handoff: { content: { summary: "done b" } } }]);
    // A read output is neither the prior handoff nor a durable artifact too.
    expect(reader.priorHandoff).toBeNull();
    expect(reader.artifacts).toEqual([]);

    // A step that names no reads keeps the lean default.
    const sibling = accumulator.getContext({ attemptId: "flow:node:5:attempt:1", nodeId: "flow:node:5", scope: { _tag: "workflow" } });
    expect(sibling.reads).toEqual([]);
    expect(sibling.priorHandoff?.entryId).toBe("flow:node:3:attempt:1");
    expect(sibling.artifacts.map(({ id }) => id)).toEqual(["reviews"]);
    // A lane reads only an output in its frozen shared bundle.
    const lane = (laneReads?: typeof reads) => accumulator.getContext({ attemptId: `${group}:branch:1:stage:1:attempt:1`, scope: { ...scope(1, "a"), sharedEntryIds: ["flow:node:1:attempt:2"] }, ...(laneReads === undefined ? {} : { reads: laneReads }) });
    expect(lane().reads).toEqual([]);
    expect(lane(reads).reads.map(({ id }) => id)).toEqual(["scout"]);
  });

  test("gives byte-identical views whatever order the branches settled in", () => {
    const forward = settled(["a", "b"]);
    const reverse = settled(["b", "a"]);
    expect(JSON.stringify(reverse.getContext())).toBe(JSON.stringify(forward.getContext()));
    expect(forward.getContext().request?.addenda.map(({ key }) => key)).toEqual(["reply-a", "reply-b"]);
    const recipient = { attemptId: "next", scope: { _tag: "workflow" } } as const;
    expect(JSON.stringify(reverse.getContext(recipient))).toBe(JSON.stringify(forward.getContext(recipient)));
  });

  test("expands each referenced branch handoff into the join artifact that still fits the cap", () => {
    const accumulator = createContextAccumulator();
    accumulator.accumulate(branchEntry(1, "a", { summary: "x".repeat(JOIN_EXPANSION_CAP_BYTES) }), scope(1, "a"));
    accumulator.accumulate(branchEntry(2, "b", { summary: "small" }), scope(2, "b"));
    accumulator.accumulate(joinEntry(["a", "b"]));
    const context = accumulator.getContext();
    const [reviews] = context.artifacts;
    expect(reviews?.value.items).toMatchObject([
      { key: "a", handoff: { step_id: `${group}:branch:1:stage:1:attempt:1` } },
      { key: "b", handoff: { content: { summary: "small" } } },
    ]);
    expect(JSON.stringify(reviews?.value.items)).not.toContain("x".repeat(100));
    expect(context.exclusions).toContainEqual({ kind: "join_reference", id: `${group}:branch:1:stage:1:attempt:1`, reason: "join_expansion_cap", key: "a", bytes: JOIN_EXPANSION_CAP_BYTES + 14, join: `${group}:join`, shownBytes: JSON.stringify({ summary: "small" }).length });
    // The completion message reads the same expansion: the same value, and
    // the same reference left unexpanded.
    const contents = new Map<string, { readonly [field: string]: unknown }>([
      [`${group}:branch:1:stage:1:attempt:1`, { summary: "x".repeat(JOIN_EXPANSION_CAP_BYTES) }],
      [`${group}:branch:2:stage:1:attempt:1`, { summary: "small" }],
    ]);
    const shared = expandJoinReferences(joinEntry(["a", "b"]).handoff, (entryId) => contents.get(entryId));
    expect(shared).toEqual({ value: { ...joinEntry(["a", "b"]).handoff, items: reviews?.value.items }, unexpanded: [`${group}:branch:1:stage:1:attempt:1`], shownBytes: JSON.stringify({ summary: "small" }).length });
  });

  test("gives every recipient, in every branch, the structured launch input as request context", () => {
    const input = { goal: "Ship.", items: [{ id: "a" }, { id: "b" }] };
    const accumulator = createContextAccumulator();
    accumulator.seedInput({ workflowDefinitionId: "flow", userRequest: "Do it.", input, timestamp: 1 });
    accumulator.accumulate(plan);
    expect(accumulator.getContext().request).toEqual({ original: "Do it.", input, addenda: [] });
    const branch = accumulator.getContext({ attemptId: `${group}:branch:2:stage:1:attempt:1`, scope: { ...scope(2, "b"), sharedEntryIds: [] } });
    expect(branch.request).toEqual({ original: "Do it.", input, addenda: [] });
    // A launch with the text request only has no input key.
    expect(settled(["a"]).getContext().request).not.toHaveProperty("input");
  });

  test("gives a first stage no prior handoff and a later stage only its own predecessor, never a sibling objective", () => {
    const accumulator = createContextAccumulator();
    accumulator.seedInput({ workflowDefinitionId: "flow", userRequest: "Do it.", timestamp: 1 });
    // The source writes the default transient handoff, which lists every item.
    accumulator.accumulate(makeEntry({ entryId: "plan-1", agentName: "Plan", writes: [{ id: "plan", lifetime: "transient" }], handoff: { items: ["objective a", "objective b"] } }));
    const shared = { sharedEntryIds: ["plan-1"] };
    const first = accumulator.getContext({ attemptId: `${group}:branch:1:stage:1:attempt:1`, scope: { ...scope(1, "a"), ...shared } });
    expect(first.priorHandoff).toBeNull();
    expect(JSON.stringify(first)).not.toContain("objective b");
    // A stage that writes only a durable artifact still hands off to the next
    // stage of its own branch.
    accumulator.accumulate(makeEntry({
      entryId: `${group}:branch:1:stage:1:attempt:1`, agentName: "Implement",
      writes: [{ id: "notes", lifetime: "durable", supersedes: [] }], handoff: { summary: "notes a" },
    }), scope(1, "a"));
    const second = accumulator.getContext({ attemptId: `${group}:branch:1:stage:2:attempt:1`, scope: { ...scope(1, "a"), ...shared } });
    expect(second.priorHandoff?.entryId).toBe(`${group}:branch:1:stage:1:attempt:1`);
    expect(second.artifacts).toEqual([]);
  });

  test("keeps a branch's durable writes out of every artifact index", () => {
    const accumulator = createContextAccumulator();
    accumulator.accumulate(plan);
    accumulator.accumulate(makeEntry({
      entryId: `${group}:branch:1:stage:1:attempt:1`, agentName: "Implement",
      writes: [{ id: "notes", lifetime: "durable", supersedes: ["plan"] }], handoff: { summary: "notes a" },
    }), scope(1, "a"));
    accumulator.accumulate(makeEntry({
      entryId: `${group}:branch:1:stage:2:attempt:1`, agentName: "Review",
      writes: [{ id: "review", lifetime: "transient" }], handoff: { summary: "review a" },
    }), scope(1, "a"));
    const third = accumulator.getContext({ attemptId: `${group}:branch:1:stage:3:attempt:1`, scope: { ...scope(1, "a"), sharedEntryIds: ["plan-1"] } });
    expect(third.artifacts.map(({ id, writerEntryId }) => [id, writerEntryId])).toEqual([["plan", "plan-1"]]);
    expect(third.priorHandoff?.entryId).toBe(`${group}:branch:1:stage:2:attempt:1`);
    expect(accumulator.getContext().artifacts.map(({ id }) => id)).toEqual(["plan"]);
  });

  test("names only the handoffs that a post-join artifact references as folded into the join", () => {
    const accumulator = createContextAccumulator();
    accumulator.accumulate(plan);
    accumulator.accumulate(makeEntry({
      entryId: `${group}:branch:1:stage:1:attempt:1`, agentName: "Implement",
      writes: [{ id: "change", lifetime: "transient" }], handoff: { summary: "implemented a" },
    }), scope(1, "a"));
    accumulator.accumulate(makeEntry({
      entryId: `${group}:branch:1:stage:2:attempt:1`, agentName: "Review",
      writes: [{ id: "review", lifetime: "transient" }], handoff: { summary: "reviewed a" },
    }), scope(1, "a"));
    accumulator.accumulate(makeEntry({
      timestamp: 2, entryId: `${group}:join`, agentName: "Per item", definitionId: "per-item",
      writes: [{ id: "reviews", lifetime: "durable", supersedes: [] }],
      handoff: { total: 1, completed: 1, failed: 0, items: [{ key: "a", disposition: "completed", handoff: { step_id: `${group}:branch:1:stage:2:attempt:1`, sha256: "0".repeat(64) } }] },
    }));
    expect(accumulator.getContext().exclusions).toEqual([
      { kind: "entry", id: `${group}:branch:1:stage:1:attempt:1`, reason: "item_evidence" },
      { kind: "entry", id: `${group}:branch:1:stage:2:attempt:1`, reason: "folded_into_join" },
    ]);
  });
});

describe("loop round context", () => {
  const loop = "flow:node:1";
  const finding = (site: string, claim = `bug at ${site}`) => ({ site, claim });
  const roundJoin = (rounds: string, round: number, kept: readonly { readonly site: string; readonly claim: string }[], dropped: readonly { readonly key: string | null; readonly reason: string }[] = []) => makeEntry({
    entryId: `${rounds}:round:${round}:join`,
    agentName: "Finds",
    definitionId: "finds",
    writes: [{ id: "finds", lifetime: "durable", supersedes: [] }],
    handoff: { kept: kept.map((item) => ({ ...item, branch: "a" })), dropped: dropped.map((entry) => ({ ...entry, branch: "b" })), failed: [] },
  });
  const lane = (accumulator: ReturnType<typeof createContextAccumulator>, round: number, sharedEntryIds: readonly string[]) => accumulator.getContext({
    attemptId: `${loop}:round:${round}:branch:1:stage:1:attempt:1`,
    scope: { _tag: "item", listNodeId: `${loop}:round:${round}`, itemNodeId: `${loop}:round:${round}:branch:1`, key: "a", sharedEntryIds: [...sharedEntryIds], bundleOrder: true },
  });

  test("gives a later round's lane what each earlier round of its own loop reported, round 1 first, once", () => {
    const accumulator = createContextAccumulator();
    accumulator.accumulate(roundJoin(loop, 1, [finding("a.ts:1")], [{ key: "a.ts:1", reason: "duplicate of a" }, { key: null, reason: "has no \"site\"" }]));
    accumulator.accumulate(roundJoin("flow:node:9", 1, [finding("z.ts:9")]));
    accumulator.accumulate(roundJoin(loop, 2, [finding("b.ts:2")]));
    const shared = [`${loop}:round:2:join`, "flow:node:9:round:1:join", `${loop}:round:1:join`];
    const round3 = lane(accumulator, 3, shared);
    // An entry without a key names no item, and the round of another loop
    // is not this loop's history.
    expect(round3.earlierRounds).toEqual([
      { round: 1, kept: [finding("a.ts:1")], dropped: [{ key: "a.ts:1", reason: "duplicate of a" }], omitted: 0 },
      { round: 2, kept: [finding("b.ts:2")], dropped: [], omitted: 0 },
    ]);
    // The durable artifact that the rounds write reaches the lane only as
    // what they reported.
    expect(round3.artifacts).toEqual([]);
    // A lane of round 2 reads round 1 only, and a recipient outside a round
    // reads none.
    expect(lane(accumulator, 2, [`${loop}:round:1:join`]).earlierRounds.map(({ round }) => round)).toEqual([1]);
    expect(accumulator.getContext({ attemptId: "flow:node:2:attempt:1", scope: { _tag: "workflow", sharedEntryIds: shared } }).earlierRounds).toEqual([]);
  });

  test("keeps the kept items of every round before any dropped entry within the cap, and counts what did not fit", () => {
    const accumulator = createContextAccumulator();
    const big = finding("a.ts:1", "x".repeat(JOIN_EXPANSION_CAP_BYTES - 100));
    accumulator.accumulate(roundJoin(loop, 1, [big], [{ key: "a.ts:1", reason: "duplicate of a" }]));
    accumulator.accumulate(roundJoin(loop, 2, [finding("b.ts:2", "y".repeat(200)), finding("c.ts:3")]));
    expect(lane(accumulator, 3, [`${loop}:round:1:join`, `${loop}:round:2:join`]).earlierRounds).toEqual([
      { round: 1, kept: [big], dropped: [], omitted: 1 },
      { round: 2, kept: [finding("c.ts:3")], dropped: [], omitted: 1 },
    ]);
  });
});
