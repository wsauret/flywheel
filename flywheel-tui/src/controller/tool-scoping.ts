/**
 * Default tool scoping per workflow type.
 *
 * Controls which tool categories each workflow type can access by default.
 * Dispatcher decisions can override these defaults per-phase.
 */

import type { ToolScoping } from "../schemas/shared";
import type { WorkflowType } from "./workflow-pipeline";

/**
 * Default tool scoping for each workflow type.
 *
 * - work:     Full access (read, bash, write, edit)
 * - plan:     Read-only + bash (no write/edit — plans are generated, not applied)
 * - review:   Read-only + bash (reviews inspect code, don't modify it)
 * - research: Read-only + bash (research gathers information)
 * - ship:     Read + bash + write (git ops need write, but not fine-grained edit)
 * - debug:    Full access (debugging may require any tool)
 */
export const DEFAULT_TOOL_SCOPING: Record<WorkflowType, ToolScoping> = {
  work:     { read: true, bash: true, write: true, edit: true },
  plan:     { read: true, bash: true, write: false, edit: false },
  review:   { read: true, bash: true, write: false, edit: false },
  research: { read: true, bash: true, write: false, edit: false },
  ship:     { read: true, bash: true, write: true, edit: false },
  debug:    { read: true, bash: true, write: true, edit: true },
};

/**
 * Resolve tool scoping for a workflow phase.
 *
 * Dispatcher-provided overrides take precedence over defaults.
 * If no override is provided, returns the default for the workflow type.
 */
export function resolveToolScoping(
  workflowType: WorkflowType,
  dispatcherOverride?: ToolScoping,
): ToolScoping {
  return dispatcherOverride ?? DEFAULT_TOOL_SCOPING[workflowType];
}
