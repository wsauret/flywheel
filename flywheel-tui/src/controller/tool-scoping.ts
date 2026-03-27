/**
 * Default tool scoping per step type.
 *
 * Controls which tool categories each step type can access by default.
 * Dispatcher decisions can override these defaults per-step.
 */

import type { ToolScoping } from "../schemas/shared";
import type { StepType } from "../queue/types";

/**
 * Default tool scoping for each step type.
 *
 * - work:     Full access (read, bash, write, edit)
 * - plan:     Read-only + bash (no write/edit — plans are generated, not applied)
 * - review:   Read-only + bash (reviews inspect code, don't modify it)
 * - research: Read-only + bash (research gathers information)
 * - ship:     Read + bash + write (git ops need write, but not fine-grained edit)
 * - debug:    Full access (debugging may require any tool)
 * - verify:   Read-only + bash (verification inspects, doesn't modify)
 * - gate:     No tools (gate steps are user-approval only)
 */
export const DEFAULT_TOOL_SCOPING: Record<StepType, ToolScoping> = {
  work:     { read: true, bash: true, write: true, edit: true },
  plan:     { read: true, bash: true, write: false, edit: false },
  review:   { read: true, bash: true, write: false, edit: false },
  research: { read: true, bash: true, write: false, edit: false },
  ship:     { read: true, bash: true, write: true, edit: false },
  debug:    { read: true, bash: true, write: true, edit: true },
  sprint:   { read: true, bash: true, write: true, edit: true },
  verify:   { read: true, bash: true, write: false, edit: false },
  gate:     { read: false, bash: false, write: false, edit: false },
};

/**
 * Resolve tool scoping for a step.
 *
 * Dispatcher-provided overrides take precedence over defaults.
 * If no override is provided, returns the default for the step type.
 */
export function resolveToolScoping(
  stepType: StepType,
  dispatcherOverride?: ToolScoping,
): ToolScoping {
  return dispatcherOverride ?? DEFAULT_TOOL_SCOPING[stepType];
}
