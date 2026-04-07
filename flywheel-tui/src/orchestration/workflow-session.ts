/**
 * Workflow Session
 *
 * Manages the lifecycle of a single workflow run: store, adapter, timer, event bus.
 * WorkflowRunner calls createWorkflowSession() to start and destroyWorkflowSession() to stop.
 *
 * Dependencies are injected via WorkflowSessionFactories — orchestration never
 * imports concrete TUI classes directly. The TUI layer provides the factories
 * via provideSessionFactories().
 */

import { EventBus } from "../infra/event-bus";
import type { AnyBlock } from "../infra/output-blocks";
import type { ModelActivity } from "../infra/events";
import type { EngineMetadata } from "./engines/core/types";

// ---------------------------------------------------------------------------
// Narrow interfaces — what orchestration needs from TUI primitives
// ---------------------------------------------------------------------------

/** Minimal store interface used by the orchestration layer. */
export interface WorkflowStore {
  startWorkflow(description: string): void;
  getState(): { modelActivity: ModelActivity; outputBlocks?: AnyBlock[] };
  subscribe(cb: () => void): () => void;
  subscribeExecution(cb: () => void): () => void;
}

/** Minimal adapter interface used by the orchestration layer. */
export interface WorkflowAdapter {
  connect(bus: EventBus): void;
  start(): void;
  stop(): void;
  disconnect(): void;
}

/** Minimal timer interface used by the orchestration layer. */
export interface WorkflowTimer {
  stop(): void;
}

// ---------------------------------------------------------------------------
// Session type
// ---------------------------------------------------------------------------

export interface WorkflowSession {
  store: WorkflowStore;
  adapter: WorkflowAdapter;
  eventBus: EventBus;
  timer: WorkflowTimer;
}

// ---------------------------------------------------------------------------
// Factory injection
// ---------------------------------------------------------------------------

export interface WorkflowSessionFactories {
  createStore: (key: string) => WorkflowStore;
  createAdapter: (opts: { actions: WorkflowStore; engineMetadata?: EngineMetadata }) => WorkflowAdapter;
  createTimer: () => WorkflowTimer;
}

let _factories: WorkflowSessionFactories | null = null;

/** Reset factories to null. Test-only — allows test isolation for factory injection. */
export function resetSessionFactories(): void {
  _factories = null;
}

/** Called once by the TUI layer to provide concrete factories. */
export function provideSessionFactories(factories: WorkflowSessionFactories): void {
  _factories = factories;
}

function getFactories(): WorkflowSessionFactories {
  if (!_factories) {
    throw new Error("WorkflowSession factories not provided — call provideSessionFactories() at startup");
  }
  return _factories;
}

// ---------------------------------------------------------------------------
// Create / Destroy
// ---------------------------------------------------------------------------

export interface CreateWorkflowSessionOpts {
  description: string;
  engineMetadata?: EngineMetadata;
  /** Provide an existing EventBus (e.g. for test DI). Defaults to a fresh instance. */
  eventBus?: EventBus;
}

/**
 * Create a fresh workflow session.
 *
 * Creates per-session timer → store → adapter → event bus in strict init order.
 */
export function createWorkflowSession(opts: CreateWorkflowSessionOpts): WorkflowSession {
  const factories = getFactories();

  // 1. Per-session timer
  const timer = factories.createTimer();

  // 2. Fresh store
  const store = factories.createStore("workflow");

  // 3. Initialize workflow metadata
  store.startWorkflow(opts.description);

  // 4. Adapter wired to store
  const adapter = factories.createAdapter({ actions: store, engineMetadata: opts.engineMetadata });

  // 5. Event bus (injected or fresh)
  const eventBus = opts.eventBus ?? new EventBus();

  // 6. Connect and start
  adapter.connect(eventBus);
  adapter.start();

  return { store, adapter, eventBus, timer };
}

/**
 * Destroy a workflow session.
 *
 * Stops timer, stops and disconnects adapter.
 */
export function destroyWorkflowSession(session: WorkflowSession): void {
  session.timer.stop();
  session.adapter.stop();
  session.adapter.disconnect();
}
