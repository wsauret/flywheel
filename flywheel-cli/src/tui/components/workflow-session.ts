/**
 * Workflow Session
 *
 * Manages the lifecycle of a single workflow run: store, adapter, event bus.
 * FlywheelShell calls createWorkflowSession() to start and destroyWorkflowSession() to stop.
 *
 * Init order (strict):
 *   1. resetWorkStore() — clear lingering singleton
 *   2. timerService.reset() — clear timer state
 *   3. createTestStore(planPath) — fresh store
 *   4. new OpenTUIAdapter({ actions: store }) — adapter with store
 *   5. new EventBus() — fresh event bus (for testing; in production, WorkController
 *      creates its own eventBus and reconnects the adapter via ui.connect())
 *   6. adapter.connect(bus) + adapter.start()
 *
 * Note: When FlywheelShell creates a WorkController, the controller's constructor
 * calls adapter.connect(controller.eventBus), which disconnects from the session's
 * eventBus and reconnects to the controller's. This is correct — the controller
 * owns the eventBus in production. The session's eventBus is primarily useful
 * for testing without a real controller.
 */

import { EventBus } from "../../events/event-bus";
import { OpenTUIAdapter } from "../adapters/opentui";
import { createTestStore, resetWorkStore } from "../routes/work/context/ui-state/store";
import { timerService } from "../shared/services/timer";
import type { UIActions } from "../routes/work/context/ui-state/types";

export interface WorkflowSession {
  store: UIActions;
  adapter: OpenTUIAdapter;
  eventBus: EventBus;
  planPath: string;
}

/**
 * Create a fresh workflow session.
 *
 * Clears singleton store and timer, then creates store → adapter → event bus
 * in strict init order.
 */
export function createWorkflowSession(planPath: string): WorkflowSession {
  // 1. Clear lingering singleton state
  resetWorkStore();

  // 2. Clear timer state
  timerService.reset();

  // 3. Fresh store (always use createTestStore, never singleton)
  const store = createTestStore(planPath);

  // 4. Adapter wired to store
  const adapter = new OpenTUIAdapter({ actions: store });

  // 5. Fresh event bus
  const eventBus = new EventBus();

  // 6. Connect and start
  adapter.connect(eventBus);
  adapter.start();

  return { store, adapter, eventBus, planPath };
}

/**
 * Destroy a workflow session.
 *
 * Stops and disconnects adapter, resets timer.
 */
export function destroyWorkflowSession(session: WorkflowSession): void {
  session.adapter.stop();
  session.adapter.disconnect();
  timerService.reset();
}
