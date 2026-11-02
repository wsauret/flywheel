import { describe, expect, it } from "bun:test";
import { Schema } from "effect";
import storedVersionTenRoots from "./golden/committed-v10-roots.json";
import { replayWorkflowControl } from "../../../../src/workflows/vm/fact-fold.js";
import { recoverWorkflowControl } from "../../../../src/workflows/vm/recovery.js";
import { parseWorkflowSessionFact } from "../../../../src/workflows/vm/session-facts.js";

// Immutable roots and expansions of the VM producer from the last build
// before phases: each map fixture compiled as a version 10 root. The roots of
// older versions below are each a version 10 root reduced to what the builds
// of that version wrote.
const OpenRecord = Schema.Record(Schema.String, Schema.Unknown);
const StoredNodeSchema = Schema.StructWithRest(Schema.Struct({
  kind: Schema.String,
  reducer: Schema.optionalKey(Schema.StructWithRest(Schema.Struct({ id: Schema.String, version: Schema.Number, contract: Schema.optionalKey(Schema.Unknown) }), [OpenRecord])),
}), [OpenRecord]);
const StoredRootSchema = Schema.Struct({
  type: Schema.String,
  version: Schema.Number,
  actor: Schema.String,
  payload: Schema.StructWithRest(Schema.Struct({
    control: Schema.StructWithRest(Schema.Struct({
      graph: Schema.StructWithRest(Schema.Struct({ nodes: Schema.Array(StoredNodeSchema) }), [OpenRecord]),
      guardrails: OpenRecord,
    }), [OpenRecord]),
  }), [OpenRecord]),
});
type StoredRoot = typeof StoredRootSchema.Type;
// The JSON module types each row as its literal shape; the tests read every
// root through the stored shape that they reduce.
const decodeStoredRoot = Schema.decodeUnknownSync(StoredRootSchema);
const rootNamed = (name: "mapped" | "survey" | "findings" | "votes" | "mappedRecovered"): StoredRoot => decodeStoredRoot(storedVersionTenRoots[name]);

describe("map runs from before a group pinned its output contract", () => {
  /** The version 6 root of a stored version 10 root: each group names its
   *  reducer without the output contract, as builds before version 7 wrote
   *  it. */
  function versionSixRoot(current: StoredRoot) {
    const nodes = current.payload.control.graph.nodes.map((node) => {
      if (node.kind !== "group" || node.reducer === undefined) return node;
      const { contract: _contract, ...reducer } = node.reducer;
      return { ...node, reducer };
    });
    return { ...current, version: 6, payload: { control: { ...current.payload.control, graph: { ...current.payload.control.graph, nodes } } } };
  }

  it.each([["collect", "mapped"], ["coverage", "survey"]] as const)("pins the %s contract that the last build pinned on a stored version 6 group", (_reducer, workflowId) => {
    const current = rootNamed(workflowId);
    const root = versionSixRoot(current);
    expect<unknown>(parseWorkflowSessionFact(root)).toEqual(root);
    const control = replayWorkflowControl([{ ...root, seq: 0 }]);
    expect(control).toEqual(replayWorkflowControl([{ ...current, seq: 0 }]));
    expect(recoverWorkflowControl([{ ...root, seq: 0 }])).toMatchObject({ executable: true, control });
  });

  it("refuses a stored version 6 group whose reducer reads the contracts around its join, which only a pinned contract can carry", () => {
    const root = versionSixRoot(rootNamed("findings"));
    expect(() => replayWorkflowControl([{ ...root, seq: 0 }])).toThrow('rejected stored group reducer "dedupe@2" without a pinned output contract');
    expect(recoverWorkflowControl([{ ...root, seq: 0 }]).executable).toBe(false);
  });
});

describe("map runs from before a loop over a map existed", () => {
  /** The version 7 root of the findings workflow as builds before version 8
   *  wrote it: each group pins its contract, and a dedupe join names
   *  `dedupe@1`, the only dedupe version that those builds had. */
  function versionSevenRoot() {
    const current = rootNamed("findings");
    const nodes = current.payload.control.graph.nodes.map((node) => node.kind === "group" && node.reducer?.id === "dedupe" ? { ...node, reducer: { ...node.reducer, version: 1 } } : node);
    const control = { ...current.payload.control, graph: { ...current.payload.control.graph, nodes } };
    return { control, root: { ...current, version: 7, payload: { control } } };
  }

  it("replays and recovers a stored version 7 root as the same root at version 10, with its dedupe@1 join", () => {
    const { control, root } = versionSevenRoot();
    expect<unknown>(parseWorkflowSessionFact(root)).toEqual(root);
    const replayed = replayWorkflowControl([{ ...root, seq: 0 }]);
    expect(replayed).toEqual(replayWorkflowControl([{ ...root, version: 10, seq: 0 }]));
    expect(replayed.graph.nodes.find(({ kind }) => kind === "list")).toMatchObject({ reducer: { id: "dedupe", version: 1 } });
    expect(recoverWorkflowControl([{ ...root, seq: 0 }])).toMatchObject({ executable: true, control: replayed });
    expect(control.graph.nodes).toHaveLength(root.payload.control.graph.nodes.length);
  });

  it("refuses a loop over a map in a stored version 7 root, which its graph cannot hold", () => {
    const { root } = versionSevenRoot();
    const [first] = root.payload.control.graph.nodes;
    if (!first) throw new Error("Expected a node");
    const { id, workflowDefinitionId, order, ownership, state } = first;
    const rounds = { kind: "rounds", id, workflowDefinitionId, order, ownership, state, mapId: "reviews", field: "kept", maxIterations: 3 };
    const stored = (version: number) => ({ ...root, version, payload: { control: { ...root.payload.control, graph: { ...root.payload.control.graph, nodes: [rounds] } } } });
    expect<unknown>(parseWorkflowSessionFact(stored(8))).toEqual(stored(8));
    expect(() => parseWorkflowSessionFact(stored(7))).toThrow();
  });
});

describe("runs from before an author could cap parallel attempts", () => {
  it("replays a stored version 8 root, which names no cap, as a run with no cap on its parallel attempts", () => {
    const current = rootNamed("mapped");
    const { maxParallel: _absent, ...guardrails } = current.payload.control.guardrails;
    const control = { ...current.payload.control, guardrails };
    const root = { ...current, version: 8, payload: { control } };
    expect<unknown>(parseWorkflowSessionFact(root)).toEqual(root);
    const replayed = replayWorkflowControl([{ ...root, seq: 0 }]);
    expect(replayed).toEqual(replayWorkflowControl([{ ...root, version: 10, seq: 0 }]));
    expect(replayed.guardrails).not.toHaveProperty("maxParallel");
    expect(recoverWorkflowControl([{ ...root, seq: 0 }])).toMatchObject({ executable: true, control: replayed });
    // A cap in a version 8 root is a shape no build wrote.
    expect(() => parseWorkflowSessionFact({ ...root, payload: { control: { ...control, guardrails: { ...guardrails, maxParallel: 2 } } } })).toThrow();
  });
});

describe("runs from before a map could cast votes", () => {
  it("replays a stored version 9 root, which names no votes, as a run with one item agent for each item", () => {
    const current = rootNamed("mapped");
    const root = { ...current, version: 9 };
    expect<unknown>(parseWorkflowSessionFact(root)).toEqual(root);
    const replayed = replayWorkflowControl([{ ...root, seq: 0 }]);
    expect(replayed).toEqual(replayWorkflowControl([{ ...current, seq: 0 }]));
    expect(replayed.graph.nodes.filter(({ kind }) => kind === "list")).not.toContainEqual(expect.objectContaining({ votes: expect.anything() }));
    expect(recoverWorkflowControl([{ ...root, seq: 0 }])).toMatchObject({ executable: true, control: replayed });
  });

  it("replays a stored version 9 recovered root, which names no votes, as the same control", () => {
    const current = rootNamed("mappedRecovered");
    const root = { ...current, version: 9 };
    expect<unknown>(parseWorkflowSessionFact(root)).toEqual(root);
    expect(replayWorkflowControl([{ ...root, seq: 0 }])).toEqual(replayWorkflowControl([{ ...current, seq: 0 }]));
  });

  it("refuses votes in a version 9 root and a lane vote in a version 1 expansion, which no build wrote", () => {
    const votes = rootNamed("votes");
    expect(votes.payload.control.graph.nodes).toContainEqual(expect.objectContaining({ kind: "group", votes: 3 }));
    expect<unknown>(parseWorkflowSessionFact(votes)).toEqual(votes);
    expect(() => parseWorkflowSessionFact({ ...votes, version: 9 })).toThrow();

    const expanded = storedVersionTenRoots.votesExpanded;
    expect(expanded.version).toBe(2);
    expect<unknown>(parseWorkflowSessionFact(expanded)).toEqual(expanded);
    expect(() => parseWorkflowSessionFact({ ...expanded, version: 1 })).toThrow(/vote/);
    // The same lane without its vote is the version 1 shape.
    const plain = storedVersionTenRoots.votesExpandedPlain;
    expect(plain.version).toBe(1);
    expect<unknown>(parseWorkflowSessionFact(plain)).toEqual(plain);
  });
});
