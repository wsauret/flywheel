#!/usr/bin/env bun
/**
 * CLI Test Driver — exercises the full queue pipeline without TUI involvement.
 *
 * Usage:
 *   bun run src/cli/test-driver.ts --steps '<JSON step array>'
 *   bun run src/cli/test-driver.ts --steps-file steps.json
 *
 * Options:
 *   --steps       JSON array of step definitions (inline)
 *   --steps-file  Path to a JSON file containing step definitions
 *   --engine      Engine ID: "claude" | "opencode" (default: from config)
 *   --model       Worker model override
 *   --skip-eval   Skip evaluator (default: false)
 *   --max-revisions  Max revision attempts per step (default: from config)
 *   --objective   Session objective description
 *   --base-dir    Project base directory (default: cwd)
 *   --verbose     Print dispatcher/worker/evaluator output to stderr
 *
 * Exit codes:
 *   0 = all steps completed
 *   1 = one or more steps failed
 *   2 = invalid arguments
 */

import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, resolveModels } from "../config/loader";
import {
  ensureSessionDir,
  buildWorkerHandoffPath,
  sessionDir,
} from "../config/paths";
import { getEngine } from "../engines/core/registry";
import { BunProcessSpawner } from "../worker/bun-spawner";
import { autoDetectTransport } from "../dispatcher/auto-detect";
import { createEvaluatorTransport } from "../evaluator/create-transport";
import { createStepDispatcher, type StepDispatchContext } from "../queue/step-dispatcher";
import { createAgentEvaluatorFn } from "../evaluator/create-agent-evaluator";
import { createQueue } from "../queue/queue";
import { createQueuePersistence } from "../queue/persistence";
import { createContextAccumulator } from "../queue/context-accumulator";
import { createGuardrails } from "../queue/guardrails";
import {
  createStepExecutor,
  type DispatcherFn,
  type WorkerFn,
  type EvaluatorFn,
  type HandoffReaderFn,
} from "../queue/executor";
import { EventBus, createFlywheelEmitter } from "../events/event-bus";
import { readHandoff } from "../queue/shared/handoff-reader";
import { WorkerHandoffSchema } from "../protocol/handoff-schemas";
import { buildScaffolding, type ScaffoldingPaths } from "../queue/shared/scaffolding";
import { ContextIndexer } from "../memory/indexer";
import { createBudgetTracker } from "../session/budget-tracker";
import { formatStdinMessage } from "../worker/stdin-format";
import { Log } from "../utils/log";
import type { Step, StepType } from "../queue/types";

// Import engine provider registrations (side effects)
import "../engines/providers/claude";
import "../engines/providers/opencode";
// Scaffolding registration (handoff instructions for each step type)
import "../queue/steps/register-all";

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

interface DriverArgs {
  steps?: string;
  stepsFile?: string;
  engine?: string;
  model?: string;
  skipEval: boolean;
  maxRevisions?: number;
  objective?: string;
  baseDir: string;
  verbose: boolean;
}

function parseArgs(): DriverArgs {
  const args = process.argv.slice(2);
  const result: DriverArgs = {
    skipEval: false,
    baseDir: process.cwd(),
    verbose: false,
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--steps":
        result.steps = args[++i];
        break;
      case "--steps-file":
        result.stepsFile = args[++i];
        break;
      case "--engine":
        result.engine = args[++i];
        break;
      case "--model":
        result.model = args[++i];
        break;
      case "--skip-eval":
        result.skipEval = true;
        break;
      case "--max-revisions":
        result.maxRevisions = parseInt(args[++i], 10);
        break;
      case "--objective":
        result.objective = args[++i];
        break;
      case "--base-dir":
        result.baseDir = args[++i];
        break;
      case "--verbose":
        result.verbose = true;
        break;
      default:
        console.error(`Unknown argument: ${args[i]}`);
        process.exit(2);
    }
  }

  if (!result.steps && !result.stepsFile) {
    console.error("Error: --steps or --steps-file is required");
    process.exit(2);
  }

  return result;
}

// ---------------------------------------------------------------------------
// Step parsing
// ---------------------------------------------------------------------------

interface StepInput {
  type?: StepType;
  title: string;
  description?: string;
  acceptanceCriteria?: string[];
  fileReferences?: string[];
}

function parseSteps(args: DriverArgs): Step[] {
  let raw: StepInput[];

  if (args.stepsFile) {
    const text = require("node:fs").readFileSync(args.stepsFile, "utf-8");
    raw = JSON.parse(text);
  } else {
    raw = JSON.parse(args.steps!);
  }

  if (!Array.isArray(raw) || raw.length === 0) {
    console.error("Error: steps must be a non-empty JSON array");
    process.exit(2);
  }

  return raw.map((s, i) => ({
    id: randomUUID(),
    type: s.type ?? "work",
    title: s.title ?? `Step ${i + 1}`,
    status: "pending" as const,
    description: s.description,
    acceptanceCriteria: s.acceptanceCriteria,
    fileReferences: s.fileReferences,
  }));
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = parseArgs();
  const startTime = Date.now();

  // Initialize logger
  await Log.init({
    dir: args.baseDir,
    print: args.verbose,
    level: args.verbose ? "DEBUG" : "INFO",
  });
  const log = Log.create({ service: "test-driver" });

  // Load config
  const { config } = loadConfig();
  const engineName = args.engine ?? config.engine;
  const engine = getEngine(engineName);
  const { dispatcherModel, workerModel } = resolveModels(config);
  const finalWorkerModel = args.model ?? workerModel ?? engine.metadata.defaultModel;
  const maxRevisions = args.maxRevisions ?? config.max_revisions ?? 1;
  const skipEval = args.skipEval || config.skip_evaluation;

  // Parse steps and create queue
  const steps = parseSteps(args);
  const queue = createQueue(steps, { maxSteps: config.queue.max_steps });

  // Session setup
  const sessionId = randomUUID();
  const projectCwd = args.baseDir;
  ensureSessionDir(sessionId, projectCwd);

  // Create spawner
  const spawner = new BunProcessSpawner();

  // Create event bus
  const eventBus = new EventBus();
  const emitter = createFlywheelEmitter(eventBus);
  const workflowId = randomUUID();

  // Wire event logging
  if (args.verbose) {
    eventBus.subscribe((event) => {
      if (event.type.startsWith("queue:step")) {
        console.error(`[event] ${event.type}`, JSON.stringify(event, null, 0).slice(0, 200));
      }
    });
  }

  // Create transports
  log.info("resolving dispatcher transport", { engine: engineName });
  const verbose = args.verbose;
  const dispatcherResolved = await autoDetectTransport({
    spawner,
    engineName,
    dispatcherModel,
    onStdout: verbose ? (chunk) => process.stderr.write(chunk) : undefined,
    onStderr: verbose ? (chunk) => process.stderr.write(chunk) : undefined,
    sessionId,
    baseDir: projectCwd,
  });

  let evaluatorTransport: Awaited<ReturnType<typeof createEvaluatorTransport>> | null = null;
  if (!skipEval) {
    log.info("creating evaluator transport", { engine: engineName });
    evaluatorTransport = await createEvaluatorTransport({
      spawner,
      engineName,
      evaluatorModel: dispatcherModel,
      onStdout: verbose ? (chunk) => process.stderr.write(chunk) : undefined,
      onStderr: verbose ? (chunk) => process.stderr.write(chunk) : undefined,
      sessionId,
      baseDir: projectCwd,
    });
  }

  // Create context indexer (lightweight, just for dispatcher context)
  const contextIndexer = new ContextIndexer(projectCwd);

  // Create step dispatcher
  const realDispatcher = createStepDispatcher({
    transport: dispatcherResolved.transport,
    emitter,
    workflowId,
    configContext: {
      maxEvalCycles: config.max_eval_cycles,
      worktreePath: projectCwd,
      projectCwd,
      workerModel: finalWorkerModel,
      dispatcherModel: dispatcherModel ?? "sonnet",
    },
    sessionBudget: {
      wall_clock_deadline: null,
      invocations_remaining: null,
      token_budget_remaining: null,
    },
    availableContext: contextIndexer.getRelevantContext({
      stepType: "plan",
      stepDescription: args.objective ?? "",
    }),
    sessionObjective: args.objective,
  });

  // Context accumulator
  const contextAccumulator = createContextAccumulator({
    windowSize: config.dispatcher_intelligence?.handoff_detail_window ?? 3,
  });

  // Persistence
  const persistence = createQueuePersistence({
    sessionId,
    baseDir: projectCwd,
  });

  // Guardrails
  const guardrails = createGuardrails({
    maxQueueLength: config.queue.max_steps,
    maxMutationsPerStepCompletion: config.dispatcher_intelligence.max_mutations_per_step,
    maxInsertedStepsPerSession: config.dispatcher_intelligence.max_inserted_steps,
  });

  // Budget tracker
  const budgetTracker = createBudgetTracker({
    sessionId,
    baseDir: projectCwd,
  });

  // Dispatcher function
  const dispatcherFn: DispatcherFn = async (step, context) => {
    const dispatchContext: StepDispatchContext = {
      accumulatedContext: contextAccumulator.getContext() as any,
      previousHandoff: (context.previousHandoff as Record<string, unknown>) ?? null,
      previousAssessment: (context.previousAssessment as any) ?? null,
      hitlResponse: (context.hitlResponse as string) ?? null,
    };
    const decision = await realDispatcher.dispatch(step, queue, dispatchContext);
    return {
      prompt: decision.taskContent,
      evaluationCriteria: decision.evaluationCriteria,
      mutationRequests: decision.mutationRequests,
      sessionName: decision.sessionName,
    };
  };

  // Worker function
  const workerFn: WorkerFn = async (step, prompt) => {
    const handoffPath = buildWorkerHandoffPath(sessionId, step.type, step.id, projectCwd);
    ensureSessionDir(sessionId, projectCwd);

    const scaffoldingPaths: ScaffoldingPaths = {
      handoffPath,
      planPath: `${sessionDir(sessionId)}/plan.json`,
      researchPath: `${sessionDir(sessionId)}/research.md`,
      reviewPath: `${sessionDir(sessionId)}/review.md`,
      contextPath: `${sessionDir(sessionId)}/context.md`,
    };

    const scaffolding = buildScaffolding(step, scaffoldingPaths);
    const parts: string[] = [];
    if (scaffolding.preamble) parts.push(scaffolding.preamble);
    parts.push(prompt);
    if (scaffolding.postamble) parts.push(scaffolding.postamble);
    const fullPrompt = parts.join("\n\n");

    const engineCmd = engine.buildCommand({
      prompt: fullPrompt,
      model: finalWorkerModel,
      toolScoping: step.toolScoping ?? undefined,
    });

    const startMs = Date.now();
    // Claude uses --input-format stream-json: stdin must be NDJSON-formatted
    const useStdinPipe = engine.metadata.supportsStreamingInput;
    const rawStdinContent = engineCmd.stdinPrompt
      ? (engineCmd.promptPrefix ? engineCmd.promptPrefix + fullPrompt : fullPrompt)
      : undefined;

    let stdinContent: string | undefined;
    if (useStdinPipe && rawStdinContent) {
      stdinContent = formatStdinMessage(engine.metadata.id, rawStdinContent);
    } else {
      stdinContent = rawStdinContent;
    }

    const spawnResult = await spawner.spawn(engineCmd.command, engineCmd.args, {
      cwd: projectCwd,
      invocationId: randomUUID(),
      sessionId,
      handoffFileName: `${step.type}_${step.id}.json`,
      stdin: stdinContent,
      stdinPipe: useStdinPipe && stdinContent !== undefined,
      onStdout: verbose
        ? (chunk) => process.stderr.write(chunk)
        : undefined,
      onStderr: verbose
        ? (chunk) => process.stderr.write(chunk)
        : undefined,
      onNDJSONEvent: (event) => budgetTracker.handleEvent(event),
    });

    const workerResult = await spawnResult.result;
    return {
      output: workerResult.exitCode === 0
        ? "completed"
        : (workerResult.failure?.message ?? "failed"),
      handoffPath: workerResult.handoffPath ?? "",
      durationMs: Date.now() - startMs,
      sessionId: workerResult.sessionId,
    };
  };

  // Evaluator function
  const evaluatorFn: EvaluatorFn | null = evaluatorTransport
    ? createAgentEvaluatorFn({ transport: evaluatorTransport })
    : null;

  // Handoff reader
  const handoffReader: HandoffReaderFn = async (handoffPath) => {
    if (!handoffPath) return null;
    try {
      const handoff = await readHandoff(handoffPath, WorkerHandoffSchema);
      return handoff as unknown as Record<string, unknown>;
    } catch {
      return null;
    }
  };

  // Budget checker (no budget limits in test driver)
  const budgetChecker = { isExhausted: () => false };

  // Persist function
  const persistFn = async (q: typeof queue) => {
    await persistence.save(q);
  };

  // Create executor
  console.error(`\n=== Test Driver: ${steps.length} step(s), engine=${engineName}, model=${finalWorkerModel} ===\n`);

  const executor = createStepExecutor({
    queue,
    workflowId,
    sessionId,
    emitter,
    dispatcher: dispatcherFn,
    worker: workerFn,
    evaluator: evaluatorFn,
    handoffReader,
    budgetChecker,
    persist: persistFn,
    accumulator: contextAccumulator,
    maxRevisions,
    guardrails,
    sessionObjective: args.objective,
    onWorkerDispatched: () => budgetTracker.incrementInvocations(),
  });

  // Run
  const result = await executor.run();
  const durationMs = Date.now() - startTime;

  // Flush budget tracker to capture final state
  budgetTracker.flush();

  // Print results
  console.log(JSON.stringify({
    completed: result.completed,
    stepsCompleted: result.stepsCompleted,
    stepsTotal: result.stepsTotal,
    reason: result.reason,
    durationMs,
    sessionId,
    budget: {
      invocations_used: budgetTracker.getInvocationsUsed(),
      tokens_used: budgetTracker.getTokensUsed(),
      cost_usd: budgetTracker.getTotalCost(),
    },
    steps: queue.steps.map((s) => ({
      id: s.id,
      type: s.type,
      title: s.title,
      status: s.status,
    })),
  }, null, 2));

  // Cleanup
  budgetTracker.dispose();
  dispatcherResolved.dispose();

  process.exit(result.completed ? 0 : 1);
}

// Auto-run
if (import.meta.main) {
  main().catch((err) => {
    console.error("Fatal error:", err);
    process.exit(1);
  });
}
