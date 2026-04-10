/**
 * mapHandoffToDecision — convert DispatcherDecisionHandoff to DispatcherDecision.
 *
 * Shared by SubprocessTransport and SdkTransport so both produce
 * identical DispatcherDecision shapes from the handoff file.
 */

import type { DispatcherDecision } from "./schemas";
import type { DispatcherDecisionHandoff } from "./schemas";

export function mapHandoffToDecision(handoff: DispatcherDecisionHandoff): DispatcherDecision {
  return {
    schema_version: handoff.schema_version,
    step_index: handoff.step_index,
    task_content: handoff.task_content,
    context_files: handoff.context_files,
    context_to_inline: handoff.context_to_inline,
    evaluation_criteria: handoff.evaluation_criteria
      ?? { acceptance_criteria: [], required_tests: false, custom_checks: [], required_outputs: [] },
    reasoning: handoff.reasoning,
    worker_config: handoff.worker_config,
    mutation_requests: handoff.mutation_requests,
  };
}
