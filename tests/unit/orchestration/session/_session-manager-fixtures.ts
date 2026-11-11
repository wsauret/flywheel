import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { createSqliteEventStore } from "../../../../src/infra/sqlite-event-store.js";
import { asAsyncEventReadSurface, type AsyncGuardedEventWriter, type EventStore, type EventStoreReadSurface } from "../../../../src/infra/event-store-types.js";
import { resolveEventStoreDbFile } from "../../../../src/infra/paths.js";
import type { SessionManager, SessionManagerDeps } from "../../../../src/orchestration/session/manager";
import type { RoleSettings, Session } from "../../../../src/orchestration/session/schemas";
import type { WorkflowLaunchBinding } from "../../../../src/orchestration/session/child-session-publication.js";
import { workflowParentBinding } from "../../../helpers/workflow-parent.js";
import { queueFactsForState } from "../../../../src/workflows/view/view-diff";
import { Schema } from "effect";
import { WorkflowDefinitionSchema } from "../../../../src/workflows/workflow-schema";
import { buildContextInputSeededFact } from "../../../../src/workflows/context-bundle/context-facts";
import { compileWorkflowControl } from "../../../../src/workflows/vm/compile";
import { flattenWorkflowView } from "../../../../src/workflows/vm/view-flatten";
import { buildWorkflowControlInitializedFact, parseWorkflowSessionFact } from "../../../../src/workflows/vm/session-facts";
import { testResolvedAgent, testResolvedAgents, testSkill, testSkillRevision } from "../../../helpers/skill-fixtures.js";
import { buildDurableSubagentCreated, buildSubagentPrompted } from "../../../../src/orchestration/modules/subagents/history/subagent-run-fact-writers.js";
import { prepareSessionFactAppend } from "../../../../src/orchestration/session/session-fact-writer.js";
import { replayWorkflowControl } from "../../../../src/workflows/vm/fact-fold.js";
import { replayWorkflow, transitionWorkflow } from "../../../../src/workflows/vm/transition.js";
import { workflowMembershipReader } from "../../../../src/orchestration/session/workflow-membership.js";
import { composeWorkflowCompanions } from "../../../../src/workflows/vm/companions.js";
import { loadQueueFromEvents } from "../../../../src/workflows/view/view-projection.js";

/** Commits one control transition with the companion facts the runtime publishes. */
export async function advanceTestWorkflow(manager: SessionManager, store: EventStoreReadSurface, workflowId: string, event: Parameters<typeof transitionWorkflow>[1]): Promise<void> {
  const bindings = testResolvedAgents([testResolvedAgent(TEST_BINDING_ID, TEST_SKILL, { name: TEST_SKILL.name })]);
  const facts = store.read({ aggregateId: `workflow:${workflowId}` });
  const control = replayWorkflowControl(facts);
  // One clock read per commit, as the runtime stamps one commit, so durations
  // derived across its facts never depend on when each was mapped.
  const timestamp = Date.now();
  const result = composeWorkflowCompanions(transitionWorkflow(replayWorkflow(control), event), {
    queue: loadQueueFromEvents(facts), resolvedAgents: bindings, timestamp, addenda: [],
  });
  if (result.command.kind !== "commit") throw new Error("Expected a workflow commit");
  const events = result.command.proposal.facts.map((fact, index) => ({
    aggregateId: `workflow:${workflowId}`, sessionId: workflowId, timestamp, ...fact,
    ...(index === 0 && result.command.kind === "commit" ? { expectedSeq: result.command.proposal.expectedSeq } : {}),
  }));
  if ((await manager.commitWorkflow({ workflowId, events })).kind !== "stored") throw new Error("Workflow test publication conflicted");
}

/** Starts the first authored attempt through the production structural publication. */
export async function startTestWorkflowMember(manager: SessionManager, store: EventStoreReadSurface, workflowId: string): Promise<string> {
  await advanceTestWorkflow(manager, store, workflowId, { type: "START" });
  const control = replayWorkflowControl(store.read({ aggregateId: `workflow:${workflowId}` }));
  const attempt = control.attempts[0];
  if (!attempt) throw new Error("Expected an authored attempt");
  await advanceTestWorkflow(manager, store, workflowId, { type: "ATTEMPT_STARTED", attemptId: attempt.id, conversationId: `${workflowId}-conversation` });
  const member = await workflowMembershipReader(asAsyncEventReadSurface(store)).attempt(workflowId, attempt.id);
  if (!member) throw new Error("Expected a published member");
  return member.sessionId;
}

/** Completes the first authored attempt that `startTestWorkflowMember` started, which ends a one-agent run. */
export async function succeedTestWorkflowMember(manager: SessionManager, store: EventStoreReadSurface, workflowId: string): Promise<void> {
  const attempt = replayWorkflowControl(store.read({ aggregateId: `workflow:${workflowId}` })).attempts[0];
  if (!attempt) throw new Error("Expected the started attempt");
  await advanceTestWorkflow(manager, store, workflowId, { type: "ATTEMPT_SUCCEEDED", outcome: { attemptId: attempt.id, conversationId: `${workflowId}-conversation`, handoff: { summary: "Done." }, reassessment: null } });
}

// Each directory sits directly in TMPDIR, so a caller that removes the
// directory it made leaves nothing behind. `cleanupTmpRoot` removes the rest.
const createdTmpDirs: string[] = [];
const ownedStores = new Set<ReturnType<typeof createSqliteEventStore>>();

export function makeTmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "flywheel-session-mgr-test-"));
  createdTmpDirs.push(dir);
  return dir;
}

/** Minimal valid session data. */
export function minimalSession(overrides?: Partial<Extract<Session, { kind: "chat" }>>): Extract<Session, { kind: "chat" }> {
  return {
    label: "plans/test.md",
    name: "",
    lifecycleState: "active" as const,
    executionCwd: os.tmpdir(),
    conversationId: "fixture-conversation",
    lastUpdated: new Date().toISOString(),
    kind: "chat" as const,
    command: "chat" as const,
    ...overrides,
  };
}

/** Build deps with mock create/destroy functions. */
export function makeDeps(
  projectRoot: string,
  overrides?: Partial<SessionManagerDeps>,
): SessionManagerDeps {
  if (overrides && "store" in overrides && overrides.store) return { projectRoot, executionCwd: projectRoot, ...overrides, store: overrides.store };
  return makeDepsWithStore(projectRoot, overrides).deps;
}

export function makeDepsWithStore(
  projectRoot: string,
  overrides?: Partial<Omit<SessionManagerDeps, "store">>,
) {
  const store = createSqliteEventStore(resolveEventStoreDbFile(projectRoot));
  ownedStores.add(store);
  const close = store.close;
  store.close = () => {
    ownedStores.delete(store);
    close();
  };
  const deps = {
    projectRoot,
    executionCwd: projectRoot,
    ...overrides,
    store,
    projectionReader: asAsyncEventReadSurface(store),
  } satisfies SessionManagerDeps;
  return {
    deps,
    store,
  };
}

const TEST_SKILL = testSkill("fixture-step", { name: "Fixture step" });
const TEST_BINDING_ID = "fixture-step";

/** Publishes a one-step workflow. Without `launchedFrom`, it creates the
 *  parent chat that every workflow has. */
export async function publishTestWorkflow(
  manager: SessionManager,
  opts: {
    id?: string;
    name?: string;
    description?: string;
    workflowDefinitionId?: string;
    launchedFrom?: WorkflowLaunchBinding;
    initialRoles?: RoleSettings;
    authProfileId?: string;
    executionCwd?: string;
  } = {},
): Promise<string> {
  const workflowDefinitionId = opts.workflowDefinitionId ?? "fixture-workflow";
  const workflow = Schema.decodeUnknownSync(WorkflowDefinitionSchema)({
    id: workflowDefinitionId,
    name: opts.name ?? "Fixture workflow",
    phases: [{ phase: TEST_BINDING_ID, brief: `Do the ${TEST_SKILL.id} work.`, name: TEST_SKILL.id, writes: [] }],
  });
  const bindings = testResolvedAgents([testResolvedAgent(TEST_BINDING_ID, TEST_SKILL, { name: TEST_SKILL.name })]);
  const control = compileWorkflowControl(workflow, bindings, { skills: testSkillRevision([TEST_SKILL]) });
  const queueFacts = queueFactsForState(null, flattenWorkflowView(control, bindings)).map(parseWorkflowSessionFact);
  return manager.publishWorkflow({
    id: opts.id ?? manager.allocateId(),
    description: opts.description ?? opts.name ?? workflow.name,
    workflowDefinitionId,
    initialRoles: opts.initialRoles ?? {},
    ...(opts.authProfileId !== undefined ? { authProfileId: opts.authProfileId } : {}),
    ...(opts.executionCwd !== undefined ? { executionCwd: opts.executionCwd } : {}),
    facts: [
      buildContextInputSeededFact(workflowDefinitionId, opts.description ?? opts.name ?? workflow.name),
      buildWorkflowControlInitializedFact({ ...control, aggregateSeq: queueFacts.length + 1 }),
      ...queueFacts,
    ],
    launchedFrom: opts.launchedFrom ?? await workflowParentBinding(manager, { workflowDefinitionId }),
  });
}

export async function publishTestSubagent(
  manager: SessionManager,
  projectRoot: string,
  id: string,
  parentSessionId: string,
  parentConversationId = `${parentSessionId}-conversation`,
): Promise<string> {
  const conversationId = `${id}-conversation`;
  const run = buildDurableSubagentCreated({
    childSessionId: id,
    childRunId: `${id}-run`,
    conversationId,
    parentSessionId,
    parentConversationId,
    parentToolCallId: `${id}-tool`,
    persona: { name: "explorer", kind: "persona" },
    capabilityGrant: {
      operation: "subagent",
      required: [],
      capabilities: [],
      moduleIds: [],
      requireWorkflowConfirmation: false,
      workflowsMode: "off",
      identity: "test",
    },
    admittedModuleIds: [],
    skillsRevision: 1,
    model: "test/model",
    tools: ["read"],
    executionCwd: projectRoot,
    budget: { maxTurns: 10, maxTokens: 0 },
    parentDepth: 0,
    description: id,
  });
  return manager.publishSubagent({
    id,
    conversationId,
    description: id,
    launchedFrom: { parentSessionId, conversationId: parentConversationId, toolUseId: `${id}-tool` },
    initialRoles: {},
    runBinding: prepareSessionFactAppend(id, run),
    assignment: "inspect",
    promptFact: prepareSessionFactAppend(id, buildSubagentPrompted({
      childRunId: `${id}-run`,
      prompt: id,
      task: id,
      toolNames: ["read"],
    })),
  });
}

interface RacingPublicationWriter {
  readonly writer: AsyncGuardedEventWriter
  readonly attempts: () => number
}

/** A writer over `store` that runs `beforePublication` ahead of each guarded
 *  batch that links a child, so a test can land a concurrent commit between
 *  the publication's guard read and its append. */
export function racingPublicationWriter(
  store: EventStore,
  beforePublication: (attempt: number) => void | Promise<void>,
): RacingPublicationWriter {
  let attempts = 0;
  const writer: AsyncGuardedEventWriter = {
    append: async (event) => store.append(event),
    appendBatch: async (events) => store.appendBatch(events),
    appendGuarded: async (event) => store.appendGuarded(event),
    appendBatchGuarded: async (events) => {
      if (events.some(({ type }) => type === "session.child.linked" || type === "workflow.run.registered")) {
        attempts += 1;
        await beforePublication(attempts);
      }
      return store.appendBatchGuarded(events);
    },
    pruneSupersededEvents: async (...args) => store.pruneSupersededEvents(...args),
  };
  return {
    writer,
    attempts: () => attempts,
  };
}

/** Moves a workflow's live owner from `previousParentId` to `parentSessionId`
 *  with the facts the workflow children migration writes. That migration is
 *  the one writer that adopts a workflow. */
export function adoptTestWorkflow(store: Pick<EventStore, "appendBatch">, adoption: {
  readonly workflowSessionId: string;
  readonly previousParentId: string;
  readonly parentSessionId: string;
  readonly parentConversationId: string;
  readonly toolUseId: string;
}): void {
  const now = new Date().toISOString();
  store.appendBatch([{
    aggregateId: `workflow:${adoption.workflowSessionId}`, sessionId: adoption.workflowSessionId,
    timestamp: Date.parse(now), type: "workflow.run.adopted", version: 1, actor: "flywheel",
    payload: { launchedFrom: { parentSessionId: adoption.parentSessionId, conversationId: adoption.parentConversationId, toolUseId: adoption.toolUseId }, lastUpdated: now },
  }]);
}

export async function finalizeTestSessionDeletion(manager: SessionManager, sessionId: string): Promise<void> {
  const plan = await manager.admitDeletion(sessionId);
  for (const target of plan.targets) await manager.finalizeDeletionTarget(target);
}

export function cleanupTmpRoot(): void {
  for (const store of ownedStores) store.close();
  for (const dir of createdTmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
}
