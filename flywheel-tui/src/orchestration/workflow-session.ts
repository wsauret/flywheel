import { EventBus } from "../infra/event-bus.js";
import type { EngineMetadata } from "./engines/core/types.js";
import type { WorkflowSessionEntry } from "./session-store-types.js";

interface WorkflowAdapter {
  connect(bus: EventBus): void;
  disconnect(): void;
}

interface WorkflowSession {
  adapter: WorkflowAdapter;
  eventBus: EventBus;
}

export interface WorkflowSessionFactories {
  createAdapter: (opts: { updateEntry: (patch: Partial<WorkflowSessionEntry>) => void; engineMetadata?: EngineMetadata }) => WorkflowAdapter;
}

interface CreateWorkflowSessionOpts {
  description: string;
  engineMetadata?: EngineMetadata;
  /** Provide an existing EventBus (e.g. for test DI). Defaults to a fresh instance. */
  eventBus?: EventBus;
  /** Required — concrete factories for adapter. */
  factories: WorkflowSessionFactories;
  /** Write data directly to the session entry in the reactive store. */
  updateEntry: (patch: Partial<WorkflowSessionEntry>) => void;
}

export function createWorkflowSession(opts: CreateWorkflowSessionOpts): WorkflowSession {
  const adapter = opts.factories.createAdapter({ updateEntry: opts.updateEntry, engineMetadata: opts.engineMetadata });
  const eventBus = opts.eventBus ?? new EventBus();

  adapter.connect(eventBus);

  return { adapter, eventBus };
}

export function destroyWorkflowSession(session: WorkflowSession): void {
  session.adapter.disconnect();
}
