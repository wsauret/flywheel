import { afterEach, describe, expect, it } from "bun:test";
import { Schema } from "effect";
import { agentReads, isRepeat, WorkflowDefinitionSchema, type WorkflowPhase } from "../../../../src/workflows/workflow-schema.js";
import { testSkillRevision } from "../../../helpers/skill-fixtures.js";
import type { AccumulatedContext } from "../../../../src/workflows/context-bundle/context.js";
import type { WorkflowVmHostDeps } from "../../../../src/workflows/vm/host-types.js";
import { hashDefinition } from "../../../../src/workflows/definition-hash.js";
import { replayWorkflowControl, resumesFailedAgents } from "../../../../src/workflows/vm/fact-fold.js";
import { attemptScope } from "../../../../src/workflows/vm/list-transitions.js";
import { queuedAttempts } from "../../../../src/workflows/vm/structural-admission.js";
import { CURRENT_PROPOSAL_ENCODING } from "../../../../src/workflows/vm/events.js";
import { classifyWorkflowHistory } from "../../../../src/workflows/vm/recovery-fold.js";
import { failedAgents } from "../../../../src/workflows/output-contract/workflow-completion.js";
import { workflowTree } from "../../../../src/workflows/vm/view-tree.js";
import { attemptOf, FINDINGS_CHECKS, FINDINGS_FILES, FINDINGS_REPORT, FINDINGS_REVIEWS, findingsAnswer, findingsWorkflow, mapSkills, VOTES_CHECKS, VOTES_REPORT, votesAnswer, votesWorkflow } from "./_map-fixtures.js";
import { mapHost, SqliteVmDriver } from "./_sqlite-vm-driver.js";
import { listJoin } from "./_tree-fixtures.js";
import { buildAttemptContextBundle } from "../../../../src/workflows/context-bundle/attempt-artifacts.js";

const drivers: SqliteVmDriver[] = [];

afterEach(() => {
  for (const driver of drivers.splice(0)) driver.close();
});

const finding = (id: string, area: string) => ({ id, title: `Finding ${id}`, area });

describe("selecting joins through the production host", () => {
  it("reviews each file, dedupes the findings, verifies each kept finding, and gives each area a quorum verdict", async () => {
    const vm = new SqliteVmDriver({ workflow: findingsWorkflow, skills: mapSkills, input: { files: FINDINGS_FILES } });
    drivers.push(vm);
    await vm.initialize();
    const verified: unknown[] = [];
    const seen = new Map<string, AccumulatedContext>();
    const answer: WorkflowVmHostDeps["attemptRunner"]["run"] = async (input, active) => {
      seen.set(input.attemptId, await vm.workflowStores().contextStore.getContext({ attemptId: input.attemptId, scope: input.scope }));
      if (input.definitionId === "checks") verified.push(input.item);
      const outcome = findingsAnswer(input.attemptId);
      if ("fail" in outcome) {
        return { kind: "invalid_handoff", attemptId: input.attemptId, conversationId: active.conversationId, reason: outcome.fail, content: {}, issues: [{ path: "summary", message: outcome.fail }] };
      }
      return { kind: "success", attemptId: input.attemptId, conversationId: active.conversationId, handoff: outcome.handoff, reassessment: null };
    };

    // Every phase runs, and the failed review fails the run, which a Resume
    // can run again.
    expect((await mapHost(vm, "launch", answer).run()).kind).toBe("failed");

    // The dedupe join keeps the first finding per id in file order, names the
    // file whose finding repeated it, and lists the failed review.
    const settled = vm.events().filter(({ type }) => type === "group.settled");
    expect(settled.map(({ payload }) => payload.reducer)).toEqual([{ id: "dedupe", version: 2 }, { id: "quorum", version: 1 }]);
    // A join outside a loop hashes its slots alone, as every settlement
    // that a build before loops over maps stored.
    for (const { payload } of settled) expect(payload.inputSha256).toBe(hashDefinition(payload.input).sha256);
    expect(settled[0]?.payload.output).toEqual({
      kept: [{ ...finding("F1", "core"), branch: "a.ts" }, { ...finding("F2", "ui"), branch: "a.ts" }],
      dropped: [{ key: "F1", branch: "b.ts", reason: "duplicate of a.ts" }],
      failed: ["c.ts"],
    });
    // The second map fans out over the kept findings only, each one its own
    // branch with the finding as its item.
    expect(verified).toEqual([{ ...finding("F1", "core"), branch: "a.ts" }, { ...finding("F2", "ui"), branch: "a.ts" }]);
    expect(settled[1]?.payload.output).toEqual({
      passed: [{ group: "core", valid: 1, refuted: 0, abstain: 0, reason: "1 valid, at least 1; 0 refuted, at most 0" }],
      rejected: [{ group: "ui", valid: 0, refuted: 1, abstain: 0, reason: "0 valid, fewer than 1; 1 refuted, more than 0" }],
      failed: [],
    });
    const report = seen.get(attemptOf(FINDINGS_REPORT))?.priorHandoff;
    expect(report?.entryId).toBe(`${FINDINGS_CHECKS}:join`);
    expect<unknown>(report?.handoff).toEqual(settled[1]?.payload.output);

    // The tree carries what each join kept and dropped, and strict replay
    // derives the same control and the same tree again.
    const events = vm.events();
    expect(replayWorkflowControl(events)).toEqual(vm.freshViews().control);
    const tree = vm.queue()?.tree;
    expect(tree).toEqual(workflowTree(replayWorkflowControl(events), (id) => vm.queue()!.attempts.find(({ definitionId }) => definitionId === id)!.name));
    expect(listJoin(tree, FINDINGS_REVIEWS)).toEqual({
      reducer: "dedupe@2", state: "settled", slots: 3, completed: 2, failed: 1, pending: 0, missing: 0, selection: { verb: "kept", kept: 2, dropped: 1 },
    });
    expect(listJoin(tree, FINDINGS_CHECKS)).toEqual({
      reducer: "quorum@1", state: "settled", slots: 2, completed: 2, failed: 0, pending: 0, missing: 0, selection: { verb: "passed", kept: 1, dropped: 1 },
    });
    // Every list records its expansion at version 3, with or without votes.
    expect(events.filter(({ type }) => type === "group.expanded").map(({ version }) => version)).toEqual([3, 3]);
  });

  it("casts three votes on each kept finding and gives each finding one quorum verdict that names it, with a failed lane abstaining", async () => {
    const vm = new SqliteVmDriver({ workflow: votesWorkflow, skills: mapSkills, input: { files: FINDINGS_FILES } });
    drivers.push(vm);
    await vm.initialize();
    const lanes: { readonly item: unknown; readonly vote: unknown }[] = [];
    const seen = new Map<string, AccumulatedContext>();
    const answer: WorkflowVmHostDeps["attemptRunner"]["run"] = async (input, active) => {
      seen.set(input.attemptId, await vm.workflowStores().contextStore.getContext({ attemptId: input.attemptId, scope: input.scope }));
      if (input.definitionId === "checks") lanes.push({ item: input.item, vote: input.vote });
      else expect(input.vote).toBeUndefined();
      const outcome = votesAnswer(input.attemptId);
      if ("fail" in outcome) {
        return { kind: "invalid_handoff", attemptId: input.attemptId, conversationId: active.conversationId, reason: outcome.fail, content: {}, issues: [{ path: "summary", message: outcome.fail }] };
      }
      return { kind: "success", attemptId: input.attemptId, conversationId: active.conversationId, handoff: outcome.handoff, reassessment: null };
    };

    // Every phase runs, and the failed vote fails the run.
    expect((await mapHost(vm, "launch", answer).run()).kind).toBe("failed");

    // Each kept finding runs three lanes, each with the finding as its item
    // and its own vote number.
    const f1 = { ...finding("F1", "core"), branch: "a.ts" };
    const f2 = { ...finding("F2", "ui"), branch: "a.ts" };
    expect(lanes.toSorted((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)))).toEqual([
      { item: f1, vote: { number: 1, count: 3 } }, { item: f1, vote: { number: 2, count: 3 } }, { item: f1, vote: { number: 3, count: 3 } },
      { item: f2, vote: { number: 1, count: 3 } }, { item: f2, vote: { number: 2, count: 3 } }, { item: f2, vote: { number: 3, count: 3 } },
    ]);
    const events = vm.events();
    const expanded = events.filter(({ type }) => type === "group.expanded");
    expect(expanded.map(({ version }) => version)).toEqual([3, 3]);
    expect(expanded[1]?.payload.itemCount).toBe(2);

    // The quorum gives each finding one verdict over its three votes. The
    // failed vote on F1 abstains, and each verdict names its finding.
    const settled = events.filter(({ type }) => type === "group.settled");
    expect(settled[1]?.payload.output).toEqual({
      passed: [{ key: "F1", label: "Finding F1", valid: 2, refuted: 0, abstain: 1, reason: "2 valid, at least 2; 0 refuted, at most 1" }],
      rejected: [{ key: "F2", label: "Finding F2", valid: 1, refuted: 2, abstain: 0, reason: "1 valid, fewer than 2; 2 refuted, more than 1" }],
      failed: ["F1#3"],
    });
    const report = seen.get(attemptOf(VOTES_REPORT))?.priorHandoff;
    expect(report?.entryId).toBe(`${VOTES_CHECKS}:join`);
    expect<unknown>(report?.handoff).toEqual(settled[1]?.payload.output);

    // Each lane shows its item's label and its vote, strict replay derives
    // the same control and tree, and the join counts every lane.
    expect(replayWorkflowControl(events)).toEqual(vm.freshViews().control);
    const tree = vm.queue()?.tree;
    expect(tree).toEqual(workflowTree(replayWorkflowControl(events), (id) => vm.queue()!.attempts.find(({ definitionId }) => definitionId === id)!.name));
    const votes = tree?.nodes.flatMap((node) => node.kind === "agent" && node.parentId === `${VOTES_CHECKS}:phase:1` && node.item !== undefined ? [node.item] : []);
    expect(votes?.map(({ key, label }) => [key, label])).toEqual([
      ["F1#1", "Finding F1 #1"], ["F1#2", "Finding F1 #2"], ["F1#3", "Finding F1 #3"],
      ["F2#1", "Finding F2 #1"], ["F2#2", "Finding F2 #2"], ["F2#3", "Finding F2 #3"],
    ]);
    expect(listJoin(tree, VOTES_CHECKS)).toEqual({
      reducer: "quorum@1", state: "settled", slots: 6, completed: 5, failed: 1, pending: 0, missing: 0, selection: { verb: "passed", kept: 1, dropped: 1 },
    });
  });
});

describe("joins of named agents through the production host", () => {
  const findings = { type: "list", max: 5, optional: true, description: "The findings.", of: { type: "object", fields: { site: { type: "string", description: "The site." } } } };
  /** A phase of named agents that share the phase's one brief, joined by
   *  `join`, and a phase after it. */
  const reviewWorkflow = (join?: { readonly [key: string]: unknown }) => Schema.decodeUnknownSync(WorkflowDefinitionSchema)({
    id: "shared",
    name: "Shared",
    phases: [
      { phase: "review", brief: "Review.", output: { summary: "The review.", fields: { findings } }, writes: [], agents: ["security", "perf"], ...(join === undefined ? {} : { join }) },
      { phase: "after", brief: "Report.", writes: [], ...(join === undefined ? { if: "review.items" } : {}) },
    ],
  });
  const run = async (join: { readonly [key: string]: unknown }) => {
    const vm = new SqliteVmDriver({ workflow: reviewWorkflow(join), skills: testSkillRevision([]) });
    drivers.push(vm);
    await vm.initialize();
    const result = await mapHost(vm, "launch", async (input, active) => ({
      kind: "success",
      attemptId: input.attemptId,
      conversationId: active.conversationId,
      handoff: input.definitionId === "after" ? { summary: "Done." } : { summary: input.definitionId, findings: [{ site: `${input.definitionId}.ts` }] },
      reassessment: null,
    })).run();
    return { result, settled: vm.events().filter(({ type }) => type === "group.settled") };
  };

  it("keys each agent's slot by its agent id, which its brief does not share", async () => {
    const deduped = await run({ reducer: "dedupe", with: { items: "findings", by: "site" } });
    expect(deduped.result.kind).toBe("completed");
    // A reducer reads its slots in key order, so perf comes first.
    expect(deduped.settled[0]?.payload.output).toEqual({
      kept: [{ site: "perf.ts", branch: "perf" }, { site: "security.ts", branch: "security" }],
      dropped: [],
      failed: [],
    });
    const collected = await run({ reducer: "collect", write: "review-all" });
    expect(collected.result.kind).toBe("completed");
  });

  it("keeps authored durable artifacts past an automatic named join with the same name", async () => {
    const ids = ["review", "review:join", "review:join:join"];
    const workflow = Schema.decodeUnknownSync(WorkflowDefinitionSchema)({
      id: "retained",
      name: "Retained",
      phases: [
        { phase: "review", agents: ["one", "two"], brief: "Review.", writes: ids.map((id) => ({ id, lifetime: "durable", supersedes: [] })) },
        { phase: "middle", brief: "Continue.", writes: [] },
        { phase: "tail", brief: "Report.", writes: [] },
      ],
    });
    const vm = new SqliteVmDriver({ workflow, skills: testSkillRevision([]) });
    drivers.push(vm);
    await vm.initialize();
    const seen = new Map<string, AccumulatedContext>();
    const result = await mapHost(vm, "launch", async (input, active) => {
      seen.set(input.definitionId, await vm.workflowStores().contextStore.getContext({ attemptId: input.attemptId, scope: input.scope }));
      return {
        kind: "success", attemptId: input.attemptId, conversationId: active.conversationId,
        handoff: { summary: `${input.definitionId} done` }, reassessment: null,
      };
    }).run();
    expect(result.kind).toBe("completed");
    expect(seen.get("middle")?.priorHandoff?.handoff.items).toMatchObject([
      { key: "one", handoff: { content: { summary: "one done" } } },
      { key: "two", handoff: { content: { summary: "two done" } } },
    ]);
    expect(seen.get("tail")?.artifacts.map(({ id }) => id)).toEqual(ids);
    expect(seen.get("tail")?.artifacts.every(({ writerDefinitionId }) => writerDefinitionId === "one" || writerDefinitionId === "two")).toBe(true);
    expect(replayWorkflowControl(vm.events()).status).toBe("completed");
  });

  it.each([["security", "perf"], ["perf", "security"]])("includes every named handoff in the next context bundle when %s finishes before %s", async (first, last) => {
    const vm = new SqliteVmDriver({ workflow: reviewWorkflow(), skills: testSkillRevision([]) });
    drivers.push(vm);
    await vm.initialize();
    await vm.startAttempt("after", "conversation-security");
    await vm.drive({ type: "ATTEMPT_STARTED", attemptId: "shared:node:1:node:2:attempt:1", conversationId: "conversation-perf" });
    for (const id of [first, last]) {
      const attempt = vm.committed.attempts.find(({ definitionId }) => definitionId === id);
      if (!attempt) throw new Error(`Missing agent ${id}`);
      await vm.drive({
        type: "ATTEMPT_SUCCEEDED",
        outcome: {
          attemptId: attempt.id, conversationId: attempt.conversationId, reassessment: null,
          handoff: { summary: `${id} reviewed`, findings: id === "security" ? [{ site: "security.ts" }] : [] },
        },
      });
    }
    const after = vm.queue()?.attempts.find(({ definitionId }) => definitionId === "after");
    if (!after) throw new Error("Missing successor");
    expect(vm.committed.graph.nodes.find(({ id }) => id === "shared:node:2")?.state._tag).toBe("ready");
    const recipient = { attemptId: after.id, nodeId: "shared:node:2", scope: { _tag: "workflow" as const } };
    const context = await vm.workflowStores().contextStore.getContext(recipient);
    expect(context.priorHandoff?.handoff.items).toMatchObject([
      { key: "perf", handoff: { content: { summary: "perf reviewed", findings: [] } } },
      { key: "security", handoff: { content: { summary: "security reviewed", findings: [{ site: "security.ts" }] } } },
    ]);
    const bundle = await buildAttemptContextBundle(after, context, { signal: new AbortController().signal, workflowSessionId: "workflow-session" });
    expect(bundle).toContain("## Output of the Phase Before");
    expect(bundle).toContain('"key": "perf"');
    expect(bundle).toContain('"key": "security"');
    expect(bundle).toContain("security.ts");
    const explicit = await vm.workflowStores().contextStore.getContext({ ...recipient, reads: agentReads(vm.workflow, ["review", "security"]) });
    expect(explicit.reads.map(({ id }) => id)).toEqual(["review", "security"]);
    expect(explicit.reads[0]?.entry.handoff).toEqual(context.priorHandoff?.handoff);
    expect(explicit.reads[1]?.entry.handoff).toEqual({ summary: "security reviewed", findings: [{ site: "security.ts" }] });
    expect(replayWorkflowControl(vm.events())).toEqual(vm.committed);
  });
});

describe("the Resume of a run whose item agent failed", () => {
  const itemFields = { type: "list", description: "The items.", max: 3, unique: "id", of: { type: "object", fields: { id: { type: "string", description: "The item id." } } } };
  /** A review over three items with a transient join; `direct` reads the
   *  join as its prior handoff and writes only a durable artifact, so
   *  `keep` reads no prior and nothing it declares; `transitive` declares a
   *  read of `direct`; `recheck` is another list whose items read the
   *  context that their list froze. */
  const workflow = Schema.decodeUnknownSync(WorkflowDefinitionSchema)({
    id: "resumed",
    name: "Resumed",
    input: { fields: { items: itemFields } },
    phases: [
      { phase: "review", over: "input.items", brief: "Review one item.", name: "Review", output: { summary: "The review." }, join: { reducer: "collect" } },
      { phase: "direct", brief: "Summarize the reviews.", name: "Direct", output: { summary: "The summary." }, writes: [{ id: "summary", lifetime: "durable", supersedes: [] }] },
      { phase: "keep", brief: "Note the date.", name: "Keep", output: { summary: "The note." } },
      { phase: "transitive", brief: "Report the summary.", name: "Transitive", output: { summary: "The report." }, reads: ["direct"] },
      { phase: "recheck", over: "input.items", brief: "Recheck one item.", name: "Recheck", output: { summary: "The recheck." } },
    ],
  });

  /** Launch the run, in which the review of item `b` fails once, then
   *  resume it. */
  const launchAndResume = async () => {
    const vm = new SqliteVmDriver({ workflow, skills: testSkillRevision([]), input: { items: [{ id: "a" }, { id: "b" }, { id: "c" }] } });
    drivers.push(vm);
    await vm.initialize();
    const runs: string[] = [];
    const seen = new Map<string, AccumulatedContext>();
    const answer: WorkflowVmHostDeps["attemptRunner"]["run"] = async (input, active) => {
      const { item } = input;
      runs.push(`${input.definitionId}${typeof item === "object" && item !== null && "id" in item ? `:${String(item.id)}` : ""}`);
      const phase = workflow.phases.find((entry): entry is WorkflowPhase => !isRepeat(entry) && entry.phase === input.definitionId);
      seen.set(input.attemptId, await vm.workflowStores().contextStore.getContext({ attemptId: input.attemptId, scope: input.scope, nodeId: input.logicalNodeId, reads: agentReads(workflow, phase?.reads) }));
      if (runs.filter((run) => run === "review:b").length === 1 && runs.at(-1) === "review:b") {
        return { kind: "fatal", attemptId: input.attemptId, reason: "provider rejected the request", conversationId: active.conversationId };
      }
      return { kind: "success", attemptId: input.attemptId, conversationId: active.conversationId, handoff: { summary: `${runs.at(-1)} run ${runs.filter((run) => run === runs.at(-1)).length}` }, reassessment: null };
    };
    const launched = await mapHost(vm, "launch", answer).run();
    const failed = { kind: launched.kind, status: vm.freshViews().control.status, resumable: resumesFailedAgents(vm.events(), vm.freshViews().control), failedAgents: failedAgents(vm.events(), vm.queue()!.attempts) };
    const launchRuns = runs.length;
    const resumed = await mapHost(vm, "operator_resume", answer).run();
    return { vm, runs, launchRuns, seen, failed, resumed };
  };

  it("ends failed and resumable, then reruns the item, refolds its join, and reruns each later phase that reads the join", async () => {
    const { vm, runs, launchRuns, seen, failed, resumed } = await launchAndResume();
    // Every later phase still ran before the run ended failed.
    expect(runs.slice(0, launchRuns).toSorted()).toEqual(["direct", "keep", "recheck:a", "recheck:b", "recheck:c", "review:a", "review:b", "review:c", "transitive"]);
    expect(failed).toEqual({ kind: "failed", status: "failed", resumable: true, failedAgents: [{ name: "Review, item b", reason: "provider rejected the request" }] });

    expect(resumed.kind).toBe("completed");
    // The Resume reruns the item, the reader of the join's prior handoff,
    // the reader that declares that reader, and the list whose items read
    // that reader as their prior handoff; `keep` reads none of them.
    expect(runs.slice(launchRuns)).toEqual(["review:b", "direct", "transitive", "recheck:a", "recheck:b", "recheck:c"]);
    const events = vm.events();
    const settled = events.filter(({ type, payload }) => type === "group.settled" && payload.groupNodeId === "resumed:node:1");
    expect(settled.map(({ payload }) => payload.summary)).toEqual([{ total: 3, completed: 2, failed: 1 }, { total: 3, completed: 3, failed: 0 }]);
    // The rerun reader reads and renders only the newest join output.
    const direct = [...seen].filter(([id]) => id.startsWith("resumed:node:2:"));
    expect(direct.map(([, context]) => context.priorHandoff?.handoff)).toMatchObject([{ completed: 2, failed: 1 }, { completed: 3, failed: 0 }]);
    const [rerunId, rerunContext] = direct[1]!;
    const bundle = await buildAttemptContextBundle(vm.queue()!.attempts.find(({ id }) => id === rerunId)!, rerunContext, { signal: new AbortController().signal, workflowSessionId: "workflow-session" });
    expect(bundle).toContain("review:b run 2");
    expect(bundle).not.toContain('"disposition": "failed"');
    // The tree shows each item and each rerun phase once, by its latest
    // attempt, as it shows a retry.
    const agents = vm.queue()!.tree.nodes.flatMap((node) => node.kind === "agent" ? [`${node.item?.key ?? node.label} ${node.disposition} ${node.attempts} ${node.currentAttemptId}`] : []);
    expect(agents).toEqual([
      "a completed 1 resumed:node:1:item:1:phase:1:attempt:1",
      "b completed 2 resumed:node:1:item:2:phase:1:attempt:2",
      "c completed 1 resumed:node:1:item:3:phase:1:attempt:1",
      "Direct completed 2 resumed:node:2:attempt:2",
      "Keep completed 1 resumed:node:3:attempt:1",
      "Transitive completed 2 resumed:node:4:attempt:2",
      "a completed 1 resumed:node:5:run:2:item:1:phase:1:attempt:1",
      "b completed 1 resumed:node:5:run:2:item:2:phase:1:attempt:1",
      "c completed 1 resumed:node:5:run:2:item:3:phase:1:attempt:1",
    ]);
    // Strict replay accepts the second settlement of the list, and the
    // stored rows keep each rerun after its earlier attempt, so the whole
    // history still classifies as a run that can execute.
    expect(replayWorkflowControl(events)).toEqual(vm.freshViews().control);
    expect(vm.queue()!.attempts.map(({ id }) => id)).toEqual(vm.freshViews().control.attempts.map(({ id }) => id));
    expect(classifyWorkflowHistory(events).plan.executable).toBe(true);
  });

  it("runs another list that reads changed work again as a new run beside its superseded items, and replay derives the same control", async () => {
    const { vm } = await launchAndResume();
    const control = vm.freshViews().control;
    const recheck = control.graph.nodes.filter(({ kind, ownership }) => kind === "item" && ownership._tag === "list" && ownership.parentNodeId === "resumed:node:5");
    expect(recheck.map(({ id, state }) => [id, state._tag])).toEqual([
      ["resumed:node:5:item:1", "superseded"], ["resumed:node:5:item:2", "superseded"], ["resumed:node:5:item:3", "superseded"],
      ["resumed:node:5:run:2:item:1", "completed"], ["resumed:node:5:run:2:item:2", "completed"], ["resumed:node:5:run:2:item:3", "completed"],
    ]);
    // The earlier run's results stay as they were, and only the new run is
    // the list's join.
    expect(control.attempts.filter(({ definitionId }) => definitionId === "recheck").map(({ state }) => state._tag)).toEqual(["completed", "completed", "completed", "completed", "completed", "completed"]);
    expect(control.graph.joins.find(({ nodeId }) => nodeId === "resumed:node:5")?.requiredNodeIds).toEqual(["resumed:node:5:run:2:item:1", "resumed:node:5:run:2:item:2", "resumed:node:5:run:2:item:3"]);
    expect(replayWorkflowControl(vm.events())).toEqual(control);
  });

  it("checks a finding that a resumed finder adds, and the report reads it", async () => {
    // The review of c.ts fails at launch; its rerun finds F3, which the
    // dedupe join keeps, so the checks over the kept findings run again as a
    // new run that checks F3, and the report reads the new verdicts.
    const vm = new SqliteVmDriver({ workflow: findingsWorkflow, skills: mapSkills, input: { files: FINDINGS_FILES } });
    drivers.push(vm);
    await vm.initialize();
    let resuming = false;
    const checked: unknown[] = [];
    const seen = new Map<string, AccumulatedContext>();
    const answer: WorkflowVmHostDeps["attemptRunner"]["run"] = async (input, active) => {
      seen.set(input.attemptId, await vm.workflowStores().contextStore.getContext({ attemptId: input.attemptId, scope: input.scope }));
      const succeed = (handoff: { readonly [key: string]: unknown }) => ({ kind: "success", attemptId: input.attemptId, conversationId: active.conversationId, handoff, reassessment: null }) as const;
      if (input.definitionId === "checks") {
        if (resuming) checked.push(input.item);
        const id = typeof input.item === "object" && input.item !== null && "id" in input.item ? input.item.id : undefined;
        return succeed({ summary: "The verdict.", verdict: id === "F2" ? "refuted" : "valid" });
      }
      if (resuming && input.definitionId === "reviews" && input.attemptId.includes(":item:3:")) return succeed({ summary: "The review.", findings: [finding("F3", "core")] });
      const outcome = findingsAnswer(input.attemptId);
      if ("fail" in outcome) return { kind: "invalid_handoff", attemptId: input.attemptId, conversationId: active.conversationId, reason: outcome.fail, content: {}, issues: [{ path: "summary", message: outcome.fail }] };
      return succeed(outcome.handoff);
    };
    expect((await mapHost(vm, "launch", answer).run()).kind).toBe("failed");
    resuming = true;
    expect((await mapHost(vm, "operator_resume", answer).run()).kind).toBe("completed");

    expect(checked).toEqual([{ ...finding("F1", "core"), branch: "a.ts" }, { ...finding("F2", "ui"), branch: "a.ts" }, { ...finding("F3", "core"), branch: "c.ts" }]);
    const verdicts = vm.events().filter(({ type, payload }) => type === "group.settled" && payload.groupNodeId === FINDINGS_CHECKS).at(-1)?.payload.output;
    expect(verdicts).toMatchObject({ passed: [{ group: "core", valid: 2 }] });
    const report = [...seen].filter(([id]) => id.startsWith(`${FINDINGS_REPORT}:`)).at(-1)?.[1].priorHandoff;
    expect(report?.entryId).toBe(`${FINDINGS_CHECKS}:join`);
    expect<unknown>(report?.handoff).toEqual(verdicts);
    expect(replayWorkflowControl(vm.events())).toEqual(vm.freshViews().control);
    expect(classifyWorkflowHistory(vm.events()).plan.executable).toBe(true);
  });
});

describe("the Resume of a run whose repeats read a refolded join", () => {
  const itemFields = { type: "list", description: "The items.", max: 3, unique: "id", of: { type: "object", fields: { id: { type: "string", description: "The item id." } } } };
  /** `plan` reads the review join and names the items of the `each`
   *  repeat; each round of the `while` repeat's `probe` declares a read of
   *  the review join; `report` declares a read of `probe`. */
  const workflow = Schema.decodeUnknownSync(WorkflowDefinitionSchema)({
    id: "rounds",
    name: "Rounds",
    // The new runs fit this limit only when the earlier runs count toward it
    // no more.
    guardrails: { max_attempts: 12 },
    input: { fields: { items: itemFields } },
    phases: [
      { phase: "review", over: "input.items", brief: "Review one item.", name: "Review", output: { summary: "The review." }, join: { reducer: "collect" } },
      { phase: "plan", brief: "Plan the work.", name: "Plan", output: { summary: "The plan.", fields: { todo: itemFields } }, reads: ["review"] },
      { repeat: { each: "plan.todo" }, phases: [{ phase: "work", brief: "Do one item.", name: "Work", output: { summary: "The work." } }] },
      { repeat: { while: "probe.more", max: 3 }, phases: [{ phase: "probe", brief: "Probe again.", name: "Probe", output: { summary: "The probe.", fields: { more: { type: "list", description: "What is left.", of: { type: "string" } } } }, reads: ["review"] }] },
      { phase: "report", brief: "Report.", name: "Report", output: { summary: "The report." }, reads: ["probe"] },
    ],
  });

  it("runs each repeat again as a new run whose rounds read only that run, within the attempt limit", async () => {
    const vm = new SqliteVmDriver({ workflow, skills: testSkillRevision([]), input: { items: [{ id: "a" }, { id: "b" }] } });
    drivers.push(vm);
    await vm.initialize();
    let resuming = false;
    const runs: string[] = [];
    const answer: WorkflowVmHostDeps["attemptRunner"]["run"] = async (input, active) => {
      const { item } = input;
      const label = `${input.definitionId}${typeof item === "object" && item !== null && "id" in item ? `:${String(item.id)}` : ""}`;
      runs.push(label);
      const succeed = (handoff: { readonly [key: string]: unknown }) => ({ kind: "success", attemptId: input.attemptId, conversationId: active.conversationId, handoff, reassessment: null }) as const;
      if (!resuming && label === "review:b") return { kind: "fatal", attemptId: input.attemptId, reason: "provider rejected the request", conversationId: active.conversationId };
      if (input.definitionId === "plan") return succeed({ summary: "The plan.", todo: resuming ? [{ id: "x" }, { id: "y" }, { id: "z" }] : [{ id: "x" }, { id: "y" }] });
      if (input.definitionId === "probe") return succeed({ summary: "The probe.", more: /:round:1:/.test(input.attemptId) ? ["left"] : [] });
      return succeed({ summary: `${label} done` });
    };
    expect((await mapHost(vm, "launch", answer).run()).kind).toBe("failed");
    const launchRuns = runs.length;
    resuming = true;
    expect((await mapHost(vm, "operator_resume", answer).run()).kind).toBe("completed");

    // The each repeat reads the new plan's three items, the while repeat
    // runs its two rounds again, and the report reads the new probes.
    expect(runs.slice(launchRuns)).toEqual(["review:b", "plan", "work:x", "work:y", "work:z", "probe", "probe", "report"]);
    const control = vm.freshViews().control;
    const rounds = (repeatId: string) => control.graph.nodes.filter(({ ownership }) => ownership._tag === "round" && ownership.parentNodeId === repeatId).map(({ id, state }) => `${id} ${state._tag}`);
    expect(rounds("rounds:node:4")).toEqual([
      "rounds:node:4:round:1:node:1 superseded", "rounds:node:4:round:2:node:1 superseded",
      "rounds:node:4:run:2:round:1:node:1 completed", "rounds:node:4:run:2:round:2:node:1 completed",
    ]);
    expect(rounds("rounds:node:3").filter((round) => round.includes(":run:2:"))).toHaveLength(3);

    // A later round of the new run reads the earlier rounds of that run only.
    const second = control.attempts.find(({ logicalNodeId }) => logicalNodeId === "rounds:node:4:run:2:round:2:node:1")!;
    const shared = attemptScope(control, second, CURRENT_PROPOSAL_ENCODING).sharedEntryIds ?? [];
    expect(shared.filter((id) => id.startsWith("rounds:node:4:"))).toEqual(["rounds:node:4:run:2:round:1:node:1:attempt:1"]);
    // A reader after the repeat reads the rounds of its new run only.
    const report = control.attempts.findLast(({ definitionId }) => definitionId === "report")!;
    expect((attemptScope(control, report, CURRENT_PROPOSAL_ENCODING).sharedEntryIds ?? []).filter((id) => id.startsWith("rounds:node:4:"))).toEqual(["rounds:node:4:run:2:round:1:node:1:attempt:1", "rounds:node:4:run:2:round:2:node:1:attempt:1"]);

    // The attempts of the earlier runs count toward no limit.
    expect(control.attempts).toHaveLength(16);
    expect(queuedAttempts(control)).toBe(10);
    expect(vm.queue()!.tree.nodes.filter(({ kind, label }) => kind === "agent" && label === "Probe")).toHaveLength(2);
    expect(replayWorkflowControl(vm.events())).toEqual(control);
    expect(classifyWorkflowHistory(vm.events()).plan.executable).toBe(true);
  });

  /** Run the `repeat` phase over the two items, with `report` after it, and
   *  fail the review of item b in round 2 once. Returns what the Resume ran
   *  and the control after it. */
  async function resumeAfterRound2Failure(repeat: (typeof WorkflowDefinitionSchema.Encoded)["phases"][number]) {
    const vm = new SqliteVmDriver({
      workflow: Schema.decodeUnknownSync(WorkflowDefinitionSchema)({
        id: "later",
        name: "Later",
        input: { fields: { items: itemFields } },
        phases: [
          repeat,
          { phase: "report", brief: "Report.", name: "Report", output: { summary: "The report." }, reads: ["review"] },
        ],
      }),
      skills: testSkillRevision([]),
      input: { items: [{ id: "a" }, { id: "b" }] },
    });
    drivers.push(vm);
    await vm.initialize();
    let resuming = false;
    const runs: string[] = [];
    const answer: WorkflowVmHostDeps["attemptRunner"]["run"] = async (input, active) => {
      runs.push(input.attemptId);
      const succeed = (handoff: { readonly [key: string]: unknown }) => ({ kind: "success", attemptId: input.attemptId, conversationId: active.conversationId, handoff, reassessment: null }) as const;
      if (!resuming && input.definitionId === "review" && input.attemptId.includes(":round:2:node:1:item:2:")) return { kind: "fatal", attemptId: input.attemptId, reason: "provider rejected the request", conversationId: active.conversationId };
      if (input.definitionId === "check") return succeed({ summary: "The check.", more: /:round:1:/.test(input.attemptId) ? ["left"] : [] });
      return succeed({ summary: `${input.attemptId} done` });
    };
    expect((await mapHost(vm, "launch", answer).run()).kind).toBe("failed");
    const launchRuns = runs.length;
    resuming = true;
    expect((await mapHost(vm, "operator_resume", answer).run()).kind).toBe("completed");
    const control = vm.freshViews().control;
    expect(replayWorkflowControl(vm.events())).toEqual(control);
    return { resumed: runs.slice(launchRuns), control };
  }
  const review = { phase: "review", over: "input.items", brief: "Review one item.", name: "Review", output: { summary: "The review." }, join: { reducer: "collect" } } as const;

  it("reruns a reader after the repeat when an item of a later round fails, and keeps the repeat's run", async () => {
    const { resumed } = await resumeAfterRound2Failure({ repeat: { each: "input.items" }, phases: [review] });
    expect(resumed).toEqual(["later:node:1:round:2:node:1:item:2:phase:1:attempt:2", "later:node:2:attempt:2"]);
  });

  it("leaves no attempt of an earlier run of a repeat to run when the repeat runs again", async () => {
    const check = { phase: "check", brief: "Check the reviews.", name: "Check", output: { summary: "The check.", fields: { more: { type: "list", description: "What is left.", of: { type: "string" } } } } } as const;
    const { resumed, control } = await resumeAfterRound2Failure({ repeat: { while: "check.more", max: 2 }, phases: [review, check] });
    expect(resumed.filter((id) => id.startsWith("later:node:1:"))).toHaveLength(6);
    expect(resumed.every((id) => !id.startsWith("later:node:1:") || id.startsWith("later:node:1:run:2:"))).toBe(true);
    expect(control.attempts.filter(({ state }) => state._tag === "pending")).toEqual([]);
  });
});
