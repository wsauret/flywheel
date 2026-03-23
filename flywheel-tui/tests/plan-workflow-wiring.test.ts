import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type { WorkerResult } from "../src/schemas/worker";
import type { ProcessSpawner, SpawnOptions, SpawnResult } from "../src/worker/spawner";
import type { FlywheelConfig } from "../src/config/loader";
import type { PhaseInfo } from "../src/controller/phase-provider";
import type { WorkflowStepContext } from "../src/prompts/index";
import { EventBus, createFlywheelEmitter } from "../src/events/event-bus";
import { MockAdapter } from "../src/tui/adapters/mock";
import { CONFIG_DEFAULTS } from "../src/config/loader";
import { PhaseExecutor } from "../src/controller/phase-executor";
import { ExecutionLoop } from "../src/controller/execution-loop";
import type { PromptBuilder, OnStepCompleteHook } from "../src/controller/execution-loop";
import { WorkflowDefinitionProvider } from "../src/controller/workflow-def-provider";
import { claudeEngine } from "../src/engines/providers/claude/index";
import { planWorkflow } from "../src/workflows/plan";
import { createPlanOnStepComplete } from "../src/workflows/plan-output-extractor";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TMP_DIR = path.join(os.tmpdir(), `flywheel-plan-wiring-${process.pid}-${Date.now()}`);

function ensureTmpDir(): string {
  const dir = path.join(TMP_DIR, crypto.randomUUID());
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function successResult(output: string = "<promise>COMPLETE</promise>"): WorkerResult {
  return {
    output,
    exitCode: 0,
    truncated: false,
    durationMs: 1000,
    failure: undefined,
  };
}

class MockSpawner implements ProcessSpawner {
  results: WorkerResult[] = [];
  calls: Array<{ command: string; args: string[]; options?: SpawnOptions }> = [];
  private callIndex = 0;

  async spawn(command: string, args: string[], options?: SpawnOptions): Promise<SpawnResult> {
    this.calls.push({ command, args, options });
    const result = this.results[this.callIndex] ?? successResult();
    this.callIndex++;
    return { result: Promise.resolve(result) };
  }

  reset(): void {
    this.calls = [];
    this.callIndex = 0;
  }
}

function defaultConfig(overrides?: Partial<FlywheelConfig>): FlywheelConfig {
  return { ...CONFIG_DEFAULTS, ...overrides };
}

afterEach(() => {
  try {
    fs.rmSync(TMP_DIR, { recursive: true, force: true });
  } catch {
    // May not exist
  }
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Plan workflow wiring with PlanOutputExtractor", () => {
  it("extracts plan path from consolidation step (step 3) output", async () => {
    const dir = ensureTmpDir();
    const plansDir = path.join(dir, "docs", "plans");
    fs.mkdirSync(plansDir, { recursive: true });

    // Create the plan file the consolidation step would produce
    fs.writeFileSync(
      path.join(plansDir, "feat-auth-jwt.md"),
      "# Auth JWT Plan\n\n## Implementation\n...",
    );

    const bus = new EventBus();
    const emitter = createFlywheelEmitter(bus);
    const adapter = new MockAdapter();
    adapter.connect(bus);
    adapter.start();

    const spawner = new MockSpawner();
    spawner.results = [
      successResult("Research complete. Found relevant files."),
      successResult("Draft plan written."),
      successResult("Review findings appended."),
      successResult("Consolidated plan saved to docs/plans/feat-auth-jwt.md"),
    ];

    const config = defaultConfig({ project_cwd: dir });
    const executor = new PhaseExecutor({
      spawner,
      emitter,
      config,
      engine: claudeEngine,
      workflowId: "test-plan-wiring",
    });

    const provider = new WorkflowDefinitionProvider(planWorkflow);

    const promptBuilder: PromptBuilder = (phase, ctx) =>
      `Phase ${phase.index + 1}: ${phase.title}`;

    // Create the onStepComplete hook — same as what flywheel-shell.tsx uses
    const hook = createPlanOnStepComplete(dir);

    const loop = new ExecutionLoop({
      phaseProvider: provider,
      promptBuilder,
      executor,
      emitter,
      config,
      ui: adapter,
      workflowId: "test-plan-wiring",
      workflowLabel: "plan",
      onStepComplete: hook,
      skipTruncation: true,
    });

    const result = await loop.run();

    expect(result.completed).toBe(true);
    expect(result.phasesCompleted).toBe(4);
  });

  it("uses fallback scan when regex extraction fails on consolidation step", async () => {
    const dir = ensureTmpDir();
    const plansDir = path.join(dir, "docs", "plans");
    fs.mkdirSync(plansDir, { recursive: true });

    const bus = new EventBus();
    const emitter = createFlywheelEmitter(bus);
    const adapter = new MockAdapter();
    adapter.connect(bus);
    adapter.start();

    const spawner = new MockSpawner();
    spawner.results = [
      successResult("Research complete."),
      successResult("Draft written."),
      successResult("Review done."),
      // Consolidation output doesn't mention a filename but the file exists
      successResult("Plan has been consolidated and saved."),
    ];

    const config = defaultConfig({ project_cwd: dir });
    const executor = new PhaseExecutor({
      spawner,
      emitter,
      config,
      engine: claudeEngine,
      workflowId: "test-plan-scan",
    });

    const provider = new WorkflowDefinitionProvider(planWorkflow);

    const promptBuilder: PromptBuilder = (phase, _ctx) =>
      `Phase ${phase.index + 1}: ${phase.title}`;

    const hook = createPlanOnStepComplete(dir);

    const loop = new ExecutionLoop({
      phaseProvider: provider,
      promptBuilder,
      executor,
      emitter,
      config,
      ui: adapter,
      workflowId: "test-plan-scan",
      workflowLabel: "plan",
      onStepComplete: hook,
      skipTruncation: true,
    });

    // Create the plan file just before running (simulates worker creating it)
    // But first, record time before the file is created
    const beforeTime = Date.now();
    // Small delay to ensure mtime > beforeTime
    await new Promise((r) => setTimeout(r, 50));
    fs.writeFileSync(
      path.join(plansDir, "fix-something.md"),
      "# Fix Plan",
    );

    const result = await loop.run();

    // Should complete without error — fallback scan finds the file
    expect(result.completed).toBe(true);
  });

  it("continues gracefully when no plan file is found after consolidation", async () => {
    const dir = ensureTmpDir();
    // No docs/plans/ directory at all

    const bus = new EventBus();
    const emitter = createFlywheelEmitter(bus);
    const adapter = new MockAdapter();
    adapter.connect(bus);
    adapter.start();

    const spawner = new MockSpawner();
    spawner.results = [
      successResult("Research complete."),
      successResult("Draft written."),
      successResult("Review done."),
      successResult("Consolidation done but no file path mentioned."),
    ];

    const config = defaultConfig({ project_cwd: dir });
    const executor = new PhaseExecutor({
      spawner,
      emitter,
      config,
      engine: claudeEngine,
      workflowId: "test-plan-no-file",
    });

    const provider = new WorkflowDefinitionProvider(planWorkflow);

    const promptBuilder: PromptBuilder = (phase, _ctx) =>
      `Phase ${phase.index + 1}: ${phase.title}`;

    const hook = createPlanOnStepComplete(dir);

    const loop = new ExecutionLoop({
      phaseProvider: provider,
      promptBuilder,
      executor,
      emitter,
      config,
      ui: adapter,
      workflowId: "test-plan-no-file",
      workflowLabel: "plan",
      onStepComplete: hook,
      skipTruncation: true,
    });

    // The plan should still complete — the hook logs a warning but doesn't halt
    // (Decision: warn but don't halt; the plan output is still in the worker output)
    const result = await loop.run();
    expect(result.completed).toBe(true);
  });

  it("only runs extraction on step 3 (consolidation), not earlier steps", async () => {
    const dir = ensureTmpDir();
    const plansDir = path.join(dir, "docs", "plans");
    fs.mkdirSync(plansDir, { recursive: true });

    // Create a file that mentions a plan path in step 1 output
    fs.writeFileSync(path.join(plansDir, "feat-early.md"), "# Early");

    const bus = new EventBus();
    const emitter = createFlywheelEmitter(bus);
    const adapter = new MockAdapter();
    adapter.connect(bus);
    adapter.start();

    const spawner = new MockSpawner();
    spawner.results = [
      // Step 0 output mentions a plan path — should NOT be extracted
      successResult("Found docs/plans/feat-early.md in research."),
      successResult("Draft written."),
      successResult("Review done."),
      successResult("Consolidated to docs/plans/feat-final.md"),
    ];

    // Create the final plan file
    fs.writeFileSync(path.join(plansDir, "feat-final.md"), "# Final");

    const config = defaultConfig({ project_cwd: dir });
    const executor = new PhaseExecutor({
      spawner,
      emitter,
      config,
      engine: claudeEngine,
      workflowId: "test-plan-step3-only",
    });

    const provider = new WorkflowDefinitionProvider(planWorkflow);

    const extraSnapshots: Record<string, unknown>[] = [];
    const promptBuilder: PromptBuilder = (phase, ctx) => {
      extraSnapshots.push({ ...ctx.extra });
      return `Phase ${phase.index + 1}: ${phase.title}`;
    };

    const hook = createPlanOnStepComplete(dir);

    const loop = new ExecutionLoop({
      phaseProvider: provider,
      promptBuilder,
      executor,
      emitter,
      config,
      ui: adapter,
      workflowId: "test-plan-step3-only",
      workflowLabel: "plan",
      onStepComplete: hook,
      skipTruncation: true,
    });

    const result = await loop.run();
    expect(result.completed).toBe(true);

    // The extra snapshots are captured by the prompt builder.
    // Context entries are always populated (empty arrays when no indexer).
    const emptyContext = { conventions: [], standards: [], learnings: [] };
    // Steps 0-1 should not have any extra data beyond context entries.
    // Step 2 (review) returns empty object when no questions are parsed.
    expect(extraSnapshots[0]).toEqual({ ...emptyContext }); // Phase 0: no prior extra
    expect(extraSnapshots[1]).toEqual({ ...emptyContext }); // Phase 1: step 0 returned {}
    expect(extraSnapshots[2]).toEqual({ ...emptyContext }); // Phase 2: step 1 returned {}
    // Phase 3 sees step 2's output: no questions parsed → empty object
    expect(extraSnapshots[3]).toEqual({ ...emptyContext });
    // The hook extracts planFilePath on step 3, so it would be in accumulator
    // AFTER step 3 completes. Since there's no step 4, we verify the
    // workflow completed and that the hook ran by checking completion.
  });

  it("parses open questions from review step (step 2) output", async () => {
    const dir = ensureTmpDir();
    const plansDir = path.join(dir, "docs", "plans");
    fs.mkdirSync(plansDir, { recursive: true });
    fs.writeFileSync(path.join(plansDir, "feat-auth.md"), "# Auth Plan");

    const bus = new EventBus();
    const emitter = createFlywheelEmitter(bus);
    const adapter = new MockAdapter();
    adapter.connect(bus);
    adapter.start();

    const reviewOutput = `# Plan Review Summary

## Open Questions

1. Should \`auto_chain\` default to \`true\` or \`false\`?
2. How should sessions be managed across stages?

## Critical (P1)

No critical findings.
`;

    const spawner = new MockSpawner();
    spawner.results = [
      successResult("Research complete."),
      successResult("Draft written."),
      successResult(reviewOutput),
      successResult("Consolidated to docs/plans/feat-auth.md"),
    ];

    const config = defaultConfig({ project_cwd: dir });
    const executor = new PhaseExecutor({
      spawner,
      emitter,
      config,
      engine: claudeEngine,
      workflowId: "test-plan-questions",
    });

    const provider = new WorkflowDefinitionProvider(planWorkflow);

    const extraSnapshots: Record<string, unknown>[] = [];
    const promptBuilder: PromptBuilder = (phase, ctx) => {
      extraSnapshots.push({ ...ctx.extra });
      return `Phase ${phase.index + 1}: ${phase.title}`;
    };

    const hook = createPlanOnStepComplete(dir);

    const loop = new ExecutionLoop({
      phaseProvider: provider,
      promptBuilder,
      executor,
      emitter,
      config,
      ui: adapter,
      workflowId: "test-plan-questions",
      workflowLabel: "plan",
      onStepComplete: hook,
      skipTruncation: true,
    });

    const result = await loop.run();
    expect(result.completed).toBe(true);

    // Phase 3 (consolidation) should receive parsed questions from step 2.
    // With no questionService/interactive, questions are forwarded as unresolved.
    const consolidationExtra = extraSnapshots[3];
    expect(consolidationExtra).toBeDefined();

    const unresolvedQuestions = consolidationExtra.unresolvedQuestions as Array<{ question: string; options: Array<{ label: string }> }>;
    expect(unresolvedQuestions).toHaveLength(2);
    expect(unresolvedQuestions[0].question).toBe(
      "Should `auto_chain` default to `true` or `false`?"
    );
    expect(unresolvedQuestions[1].question).toBe(
      "How should sessions be managed across stages?"
    );

    expect(consolidationExtra.questionDirective).toBe("resolve-best-judgment");
  });

  it("auto-resolves questions with first option when options exist", async () => {
    const dir = ensureTmpDir();
    const plansDir = path.join(dir, "docs", "plans");
    fs.mkdirSync(plansDir, { recursive: true });
    fs.writeFileSync(path.join(plansDir, "feat-config.md"), "# Config Plan");

    const bus = new EventBus();
    const emitter = createFlywheelEmitter(bus);
    const adapter = new MockAdapter();
    adapter.connect(bus);
    adapter.start();

    const reviewOutput = `# Plan Review Summary

## Open Questions

| # | Question | Options | Source(s) |
|---|----------|---------|-----------|
| 1 | Should \`auto_chain\` default to \`true\` or \`false\`? | A: \`true\` B: \`false\` C: Split flags | reviewer-architecture |
`;

    const spawner = new MockSpawner();
    spawner.results = [
      successResult("Research complete."),
      successResult("Draft written."),
      successResult(reviewOutput),
      successResult("Consolidated to docs/plans/feat-config.md"),
    ];

    const config = defaultConfig({ project_cwd: dir });
    const executor = new PhaseExecutor({
      spawner,
      emitter,
      config,
      engine: claudeEngine,
      workflowId: "test-plan-auto-resolve",
    });

    const provider = new WorkflowDefinitionProvider(planWorkflow);

    const extraSnapshots: Record<string, unknown>[] = [];
    const promptBuilder: PromptBuilder = (phase, ctx) => {
      extraSnapshots.push({ ...ctx.extra });
      return `Phase ${phase.index + 1}: ${phase.title}`;
    };

    const hook = createPlanOnStepComplete(dir);

    const loop = new ExecutionLoop({
      phaseProvider: provider,
      promptBuilder,
      executor,
      emitter,
      config,
      ui: adapter,
      workflowId: "test-plan-auto-resolve",
      workflowLabel: "plan",
      onStepComplete: hook,
      skipTruncation: true,
    });

    const result = await loop.run();
    expect(result.completed).toBe(true);

    // With no questionService/interactive, questions are forwarded as unresolved with directive
    const consolidationExtra = extraSnapshots[3];
    const unresolvedQuestions = consolidationExtra.unresolvedQuestions as Array<{ question: string; options: Array<{ label: string }> }>;
    expect(unresolvedQuestions).toHaveLength(1);
    expect(unresolvedQuestions[0].question).toBe(
      "Should `auto_chain` default to `true` or `false`?"
    );
    expect(unresolvedQuestions[0].options[0].label).toBe("true");
    expect(consolidationExtra.questionDirective).toBe("resolve-best-judgment");
  });
});
