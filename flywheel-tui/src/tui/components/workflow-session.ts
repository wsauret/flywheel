/**
 * Workflow Session
 *
 * Manages the lifecycle of a single workflow run: store, adapter, timer, event bus.
 * FlywheelShell calls createWorkflowSession() to start and destroyWorkflowSession() to stop.
 *
 * Init order (strict):
 *   1. new TimerService() — fresh per-session timer
 *   2. createStore(planPath) — fresh store
 *   3. new OpenTUIAdapter({ actions: store, timer }) — adapter with store and timer
 *   4. new EventBus() — fresh event bus (for testing; in production, WorkController
 *      creates its own eventBus and reconnects the adapter via ui.connect())
 *   5. adapter.connect(bus) + adapter.start()
 *
 * Note: When FlywheelShell creates a WorkController, the controller's constructor
 * calls adapter.connect(controller.eventBus), which disconnects from the session's
 * eventBus and reconnects to the controller's. This is correct — the controller
 * owns the eventBus in production. The session's eventBus is primarily useful
 * for testing without a real controller.
 */

import { EventBus } from "../../events/event-bus";
import { OpenTUIAdapter } from "../adapters/opentui";
import { createStore } from "../routes/work/context/ui-state/store";
import { TimerService } from "../shared/services/timer";
import type { UIActions } from "../routes/work/context/ui-state/types";

export interface WorkflowSession {
  store: UIActions;
  adapter: OpenTUIAdapter;
  eventBus: EventBus;
  planPath: string;
  /** Per-session timer instance. Adapter reads from this; components subscribe via useTimer(). */
  timer: TimerService;
}

/**
 * Create a fresh workflow session.
 *
 * Creates per-session timer → store → adapter → event bus in strict init order.
 */
export function createWorkflowSession(planPath: string): WorkflowSession {
  // 1. Per-session timer (replaces the old global singleton reset)
  const timer = new TimerService();

  // 2. Fresh store (always returns a new isolated instance)
  const store = createStore(planPath);

  // 3. Adapter wired to store and timer
  const adapter = new OpenTUIAdapter({ actions: store, timer });

  // 4. Fresh event bus
  const eventBus = new EventBus();

  // 5. Connect and start
  adapter.connect(eventBus);
  adapter.start();

  return { store, adapter, eventBus, planPath, timer };
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
