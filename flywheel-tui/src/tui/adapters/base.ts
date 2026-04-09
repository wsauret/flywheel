import { BaseEventConsumer } from "../../infra/base-event-consumer.js";
import type { AdapterType, IWorkflowUI } from "./types";

/**
 * BaseUIAdapter — thin TUI shell extending BaseEventConsumer.
 *
 * All event-bus lifecycle logic lives in BaseEventConsumer.
 * This class adds TUI-specific concerns: adapterType and onApprovalDecision.
 */
export abstract class BaseUIAdapter extends BaseEventConsumer implements IWorkflowUI {
  abstract readonly adapterType: AdapterType;

  onApprovalDecision?: (approved: boolean, skip?: boolean) => void;
}
