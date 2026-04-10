/**
 * Workflow Session
 *
 * Manages the lifecycle of a single workflow run: adapter, timer, event bus.
 * WorkflowRunner calls createWorkflowSession() to start and destroyWorkflowSession() to stop.
 *
 * Dependencies are injected via WorkflowSessionFactories — callers pass factories
 * explicitly. No global singleton.
 */

import { EventBus } from "../infra/event-bus";
import type { EngineMetadata } from "./engines/core/types";
import type { WorkflowSessionEntry } from "./session-store";

// ---------------------------------------------------------------------------
// Narrow interfaces — what orchestration needs from TUI primitives
// ---------------------------------------------------------------------------

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
  adapter: WorkflowAdapter;
  eventBus: EventBus;
  timer: WorkflowTimer;
}

// ---------------------------------------------------------------------------
// Factory type
// ---------------------------------------------------------------------------

export interface WorkflowSessionFactories {
  createAdapter: (opts: { updateEntry: (patch: Partial<WorkflowSessionEntry>) => void; engineMetadata?: EngineMetadata }) => WorkflowAdapter;
  createTimer: () => WorkflowTimer;
}

// ---------------------------------------------------------------------------
// Create / Destroy
// ---------------------------------------------------------------------------

export interface CreateWorkflowSessionOpts {
  description: string;
  engineMetadata?: EngineMetadata;
  /** Provide an existing EventBus (e.g. for test DI). Defaults to a fresh instance. */
  eventBus?: EventBus;
  /** Required — concrete factories for adapter, timer. */
  factories: WorkflowSessionFactories;
  /** Write data directly to the session entry in the reactive store. */
  updateEntry: (patch: Partial<WorkflowSessionEntry>) => void;
}

/**
 * Create a fresh workflow session.
 *
 * Creates per-session timer → adapter → event bus in strict init order.
 */
export function createWorkflowSession(opts: CreateWorkflowSessionOpts): WorkflowSession {
  const factories = opts.factories;

  // 1. Per-session timer
  const timer = factories.createTimer();

  // 2. Adapter wired to updateEntry
  const adapter = factories.createAdapter({ updateEntry: opts.updateEntry, engineMetadata: opts.engineMetadata });

  // 3. Event bus (injected or fresh)
  const eventBus = opts.eventBus ?? new EventBus();

  // 4. Connect and start
  adapter.connect(eventBus);
  adapter.start();

  return { adapter, eventBus, timer };
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
