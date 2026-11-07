import type { CapabilityCheck } from "../../src/infra/capability-text.js"
import type { ComposeAttemptBrief } from "../../src/workflows/vm/attempt-runner.js"

/** A brief that composes the same user prompt and task for every check of the agent's run. */
export function attemptBrief(userPrompt: string, task = ""): ComposeAttemptBrief {
  return async () => ({ userPrompt, task })
}

/** The check of an agent that can call every tool and load every definition. */
export const EVERY_CAPABILITY: CapabilityCheck = () => true

/** A capability planner for a worker under test: every agent can call every tool. */
export const planEveryCapability = async (): Promise<CapabilityCheck> => EVERY_CAPABILITY
