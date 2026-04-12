/**
 * Workflow Session
 *
 * Manages the lifecycle of a single workflow run: adapter and event bus.
 * WorkflowRunner calls createWorkflowSession() to start and destroyWorkflowSession() to stop.
 *
 * Dependencies are injected via WorkflowSessionFactories — callers pass factories
 * explicitly. No global singleton.
 */

import { EventBus } from "../infra/event-bus";
import type { EngineMetadata } from "./engines/core/types";
import type { WorkflowSessionEntry } from "./session-store-types";

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

// ---------------------------------------------------------------------------
// Session type
// ---------------------------------------------------------------------------

export interface WorkflowSession {
  adapter: WorkflowAdapter;
  eventBus: EventBus;
}

// ---------------------------------------------------------------------------
// Factory type
// ---------------------------------------------------------------------------

export interface WorkflowSessionFactories {
  createAdapter: (opts: { updateEntry: (patch: Partial<WorkflowSessionEntry>) => void; engineMetadata?: EngineMetadata }) => WorkflowAdapter;
}

// ---------------------------------------------------------------------------
// Create / Destroy
// ---------------------------------------------------------------------------

export interface CreateWorkflowSessionOpts {
  description: string;
  engineMetadata?: EngineMetadata;
  /** Provide an existing EventBus (e.g. for test DI). Defaults to a fresh instance. */
  eventBus?: EventBus;
  /** Required — concrete factories for adapter. */
  factories: WorkflowSessionFactories;
  /** Write data directly to the session entry in the reactive store. */
  updateEntry: (patch: Partial<WorkflowSessionEntry>) => void;
}

/**
 * Create a fresh workflow session.
 *
 * Creates adapter → event bus in strict init order.
 */
export function createWorkflowSession(opts: CreateWorkflowSessionOpts): WorkflowSession {
  const adapter = opts.factories.createAdapter({ updateEntry: opts.updateEntry, engineMetadata: opts.engineMetadata });
  const eventBus = opts.eventBus ?? new EventBus();

  adapter.connect(eventBus);
  adapter.start();

  return { adapter, eventBus };
}

/**
 * Destroy a workflow session — stops and disconnects adapter.
 */
export function destroyWorkflowSession(session: WorkflowSession): void {
  session.adapter.stop();
  session.adapter.disconnect();
}
