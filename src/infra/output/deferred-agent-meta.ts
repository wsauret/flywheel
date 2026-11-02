import { subagentDisplayLabel } from "../tools/detail-helpers.js";
import { workflowCallSource, workflowSourceLabel } from "../tools/workflow-call-source.js";
import { textField, type JsonFields } from "./json-field.js";
import { resolveToolRowPresentation } from "../tools/tool-display-registry.js";
import type { AgentGroupBlock } from "../output-blocks.js";

export const INITIALIZING_DESCRIPTION = "Initializing…";

/** A workflow card's one title: the run's own summary, which each launch
 *  writes fresh, so a reused workflow file never lends the run its old
 *  name. A launch without a summary falls back to the workflow's name. */
function workflowLabel(input: JsonFields, fallback: string): string {
  const summary = workflowLaunchTitle(input);
  if (summary) return summary;
  const displayName = textField(input, "workflow_display_name");
  if (displayName) return displayName;
  const source = workflowCallSource(input);
  return source ? workflowSourceLabel(source) : fallback;
}

/** The title that a workflow call gives its run, which names the run on
 *  every surface in place of its workflow's name, or null when the call
 *  gives none. */
export function workflowLaunchTitle(input: JsonFields): string | null {
  return textField(input, "summary") ?? textField(input, "task_summary");
}

export function deferredAgentMeta(
  toolName: string,
  input: JsonFields,
  fallbackLabel: string,
) {
  if (toolName === "workflow") {
    const label = workflowLabel(input, fallbackLabel);
    return { containerKind: "workflow" as const, label, description: "", sentence: resolveToolRowPresentation(toolName, input, "").sentence };
  }

  const label = subagentDisplayLabel(input);
  const agentType = textField(input, "persona");
  return {
    containerKind: "subagent" as const,
    label: label ?? fallbackLabel,
    description: textField(input, "description") ?? INITIALIZING_DESCRIPTION,
    sentence: resolveToolRowPresentation(toolName, input, "").sentence,
    ...(agentType ? { agentType } : {}),
  };
}

/** The card fields that a call's input refines. While input streams, a
 *  workflow card takes only its summary: the source streams first, and a
 *  name read from it would title the run with a reused file's old name until
 *  the summary arrives. */
export function deferredAgentMetaPatch(
  toolName: string,
  input: JsonFields,
  { streaming }: { readonly streaming: boolean },
): Partial<Pick<AgentGroupBlock, "label" | "description" | "agentType" | "sentence">> {
  if (toolName === "workflow") {
    const label = streaming ? workflowLaunchTitle(input) : workflowLabel(input, "");
    return label ? { label, sentence: resolveToolRowPresentation(toolName, input, "").sentence } : {};
  }

  const label = subagentDisplayLabel(input);
  const description = textField(input, "description");
  const agentType = textField(input, "persona");
  return {
    ...(label ? { label } : {}),
    ...(description ? { description } : {}),
    ...(agentType ? { agentType } : {}),
    sentence: resolveToolRowPresentation(toolName, input, "").sentence,
  };
}
