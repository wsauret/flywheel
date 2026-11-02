import { afterEach, describe, expect, it } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Schema } from "effect";
import { asAsyncEventReadSurface, asAsyncEventWriter } from "../../../../src/infra/event-store-types.js";
import type { AccumulatedContext } from "../../../../src/workflows/context-bundle/context.js";
import type { AttemptRow } from "../../../../src/workflows/view/types.js";
import { resolveWorkflowAgents, type ResolvedAgent } from "../../../../src/workflows/agent-resolution.js";
import { agentRecords } from "../../../../src/workflows/workflow-schema.js";
import { fixtureDefinitions, FIXTURE_WORKFLOW_ID, workflowIn } from "../../../helpers/project-definitions.js";
import { createAttemptExecutor } from "../../../../src/workflows/vm/attempt-runner.js";
import { createWorkflowVmHost } from "../../../../src/workflows/vm/host.js";
import { SqliteVmDriver } from "../vm/_sqlite-vm-driver.js";

interface HandoffData {
  [key: string]: unknown;
}

interface ExpectedAttempts {
  [workflowId: string]: readonly ExpectedAttempt[];
}
const REQUEST = "SQLite VM acceptance";
const WORKFLOW_SCRATCH = join(tmpdir(), "flywheel-pipeline-audit", "scratch");
const COMMAND_RUN = { toolUseId: "tool-1", command: "bun run test", exitCode: 0, observation: "check passed" };
const EVIDENCE = ["The traced boundary lacks the value."];

/** The output each fixture agent returns, keyed by `<workflow>:<record>`. */
function rawOutput(workflowId: string, definitionId: string, invocation: number): HandoffData {
  switch (`${workflowId}:${definitionId}`) {
    case `${FIXTURE_WORKFLOW_ID}:investigate`: return { summary: "Investigation evidence.", hypothesis: "The boundary omitted the value.", evidence: EVIDENCE };
    case `${FIXTURE_WORKFLOW_ID}:fix`:
    case `${FIXTURE_WORKFLOW_ID}:refix`: return { summary: "Repair complete.", hypothesis: "The boundary omitted the value.", fix_description: "Preserved the value.", evidence: EVIDENCE, commands_run: [COMMAND_RUN] };
    case `${FIXTURE_WORKFLOW_ID}:verify`: return {
      summary: "Verified.",
      evidence: EVIDENCE,
      commands_run: [COMMAND_RUN],
      defects: invocation === 1 ? [{ check: "Original symptom", observation: "The value is still missing." }] : [],
    };
    default: throw new Error(`No audit output fixture for ${workflowId}:${definitionId}`);
  }
}

/** The fixture output, decoded by the agent's own contract so a fixture
 *  that drifts from its contract fails here rather than in the run. */
function output(workflowId: string, agent: ResolvedAgent, invocation: number): HandoffData {
  const raw = rawOutput(workflowId, agent.definitionId, invocation);
  Schema.decodeUnknownSync(agent.output.schema)(raw);
  return raw;
}

interface ExpectedAttempt {
  bindingId: string;
  artifacts: readonly string[];
  prior: string | null;
  rationale: string;
  forItem?: string;
}

const E = (
  bindingId: string,
  artifacts: readonly string[],
  prior: string | null,
  rationale: string,
  forItem?: string,
): ExpectedAttempt => ({ bindingId, artifacts, prior, rationale, ...(forItem === undefined ? {} : { forItem }) });

const EXPECTED: ExpectedAttempts = {
  [FIXTURE_WORKFLOW_ID]: [
    E("investigate", [], null, "investigate the user report"),
    E("fix", ["repair-investigation"], null, "fix the confirmed investigation"),
    E("verify", ["repair-investigation", "repair-fix"], null, "verify the claimed fix"),
    E("refix", ["repair-investigation", "repair-fix", "repair-verification"], null, "repair the listed verification defects"),
    E("verify", ["repair-investigation", "repair-fix", "repair-verification"], null, "verify the repair and recheck prior defects"),
  ],
};

const drivers: SqliteVmDriver[] = [];

afterEach(() => {
  for (const driver of drivers.splice(0)) driver.close();
  rmSync(WORKFLOW_SCRATCH, { recursive: true, force: true });
});

function count(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

function itemId(value: unknown): string | undefined {
  return typeof value === "object" && value !== null && "id" in value && typeof value.id === "string" ? value.id : undefined;
}

function assertAttempt(
  workflowId: string,
  expected: ExpectedAttempt,
  step: AttemptRow,
  binding: ResolvedAgent,
  context: AccumulatedContext,
  userPrompt: string,
  task: string,
): void {
  expect(expected.rationale.length, `missing rationale for ${workflowId}:${step.definitionId}`).toBeGreaterThan(0);
  expect(step.definitionId).toBe(expected.bindingId);
  expect(context.request?.original).toBe(REQUEST);
  expect(context.artifacts.map(({ id }) => id)).toEqual([...expected.artifacts]);
  expect(context.priorHandoff?.definitionId ?? null).toBe(expected.prior);

  expect(step.workflowDefinitionId).toBe(workflowId);
  expect(step.briefId).toBe(binding.briefId);
  expect(step.name).toBe(binding.name);
  expect(step.description).toBe(binding.description);
  expect(step.writes).toEqual(binding.writes.map(({ id }) => id));
  expect(step).not.toHaveProperty("toolScoping");
  expect(step.status).toBe("running");
  expect(step.resumeRevertCount).toBe(0);
  expect(step.lastConversationId).toStartWith("conversation-");
  if (expected.forItem === undefined) {
    expect(step.item).toBeUndefined();
  } else {
    expect(itemId(step.item)).toBe(expected.forItem);
  }

  const bodyLines = binding.body.split("\n");
  const bodyHeading = bodyLines.find((line) => line.trim().length > 0);
  const bundledPromptContent = bodyLines.find((line) => line.trim().length >= 20) ?? bodyHeading;
  if (!bodyHeading || !bundledPromptContent) throw new Error(`Brief ${binding.briefId} has no prompt content`);
  expect(task).toContain(bodyHeading);
  expect(task).toContain(bundledPromptContent);
  expect(userPrompt).not.toContain("## Brief");
  if (expected.forItem) {
    expect(userPrompt).toContain("## For Item Context");
    expect(userPrompt).toContain(`"id": "${expected.forItem}"`);
  }
  expect(count(userPrompt, "## User Request")).toBe(1);
  expect(count(userPrompt, "## Output of the Phase Before")).toBe(expected.prior === null ? 0 : 1);
  expect(count(userPrompt, "## Inherited Artifacts")).toBe(expected.artifacts.length === 0 ? 0 : 1);
}

describe("named workflow context bundles", () => {
  for (const [workflowId, expected] of Object.entries(EXPECTED)) {
    it(`${workflowId} executes every defined position with the exact live bundle`, async () => {
      for (const position of expected) expect(position.rationale.length).toBeGreaterThan(0);
      const workflow = workflowIn(fixtureDefinitions().captureRevision(), workflowId);
      const repoSkills = fixtureDefinitions().skills();
      const skills = repoSkills;
      const resolved = resolveWorkflowAgents(workflow);
      const bindings = new Map([...agentRecords(workflow).keys()].map((bindingId) => {
        const binding = resolved.get(bindingId);
        if (!binding) throw new Error(`Missing production binding ${bindingId}`);
        return [bindingId, binding] as const;
      }));
      const vm = new SqliteVmDriver({ workflow, skills });
      drivers.push(vm);
      await vm.initialize();
      const { queueStore, contextStore } = vm.workflowStores();
      const contexts: AccumulatedContext[] = [];
      const actual: string[] = [];
      const workerFailures: unknown[] = [];
      const invocations = new Map<string, number>();
      const runner = createAttemptExecutor({
        earlierCheckpoint: async () => null,
        resolvedAgents: vm.bindings,
        skills: vm.skills,
        context: {
          getContext: async () => {
            const context = await contextStore.getContext();
            contexts.push(context);
            return context;
          },
        },
        worker: async (step, userPrompt, task) => {
          const position = expected[actual.length];
          const context = contexts.at(-1);
          const binding = bindings.get(step.definitionId);
          if (!position || !context || !binding) throw new Error(`Unexpected attempt ${step.definitionId} at position ${actual.length + 1}`);
          try {
            assertAttempt(workflowId, position, step, binding, context, userPrompt, task);
          } catch (error) {
            workerFailures.push(error);
            throw error;
          }
          actual.push(step.definitionId);
          const invocation = (invocations.get(step.definitionId) ?? 0) + 1;
          invocations.set(step.definitionId, invocation);
          return { output: "completed", handoffContent: output(workflowId, binding, invocation), durationMs: 1 };
        },
        recordInvocation: async () => {},
      });
      const host = createWorkflowVmHost({
        servedConversations: async () => new Set(),
        requestAddenda: async () => [],
        startMode: "launch",
        sessionId: vm.sessionId,
        reader: asAsyncEventReadSurface(vm.store),
        writer: asAsyncEventWriter(vm.store),
        definitionRevision: vm.definitionRevision,
        workflow,
        queueStore,
        contextStore,
        conversationId: (input) => `conversation-${input?.attemptId ?? "follow-up"}`,
        attemptRunner: runner,
        emit: () => {},
      });

      const result = await host.run();
      if (workerFailures.length > 0) throw workerFailures[0];

      expect(result.kind, result.kind === "completed" ? "" : result.kind === "paused" ? result.reason : result.failure.message).toBe("completed");
      expect(actual).toEqual(expected.map(({ bindingId }) => bindingId));
      expect(contexts).toHaveLength(expected.length);
    });
  }
});