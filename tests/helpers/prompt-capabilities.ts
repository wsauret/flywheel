import type { CapabilityCheck } from "../../src/infra/capability-text.js";
import { toolIdentity } from "../../src/orchestration/tool-catalog.js";
import type { BuildSystemPromptOptions } from "../../src/orchestration/agent-runtime/system-prompt.js";

/** The tree check of a prompt test that names its tools directly: each tool's logical identity holds, each of
 *  `skills` holds while the skill tool is among the tools, as a request's tree check states it, and every agent type
 *  holds, as it does while no type is turned off. */
export function promptCapabilities(tools: ReadonlyArray<{ readonly name: string }>, skills: readonly string[] = []): CapabilityCheck {
  const identities = new Set(tools.map((tool) => toolIdentity(tool.name)));
  return (term) => {
    if (term.startsWith("type:")) return true;
    return term.startsWith("skill:") ? identities.has("skill") && skills.includes(term.slice("skill:".length)) : identities.has(term);
  };
}

/** System prompt options for a test that names its tools directly: `capabilities` is the tree check of those tools
 *  (`promptCapabilities`), with `skills` as the model-invocable skills, unless the options state their own. */
export function promptOptions(options: Omit<BuildSystemPromptOptions, "capabilities"> & { readonly capabilities?: CapabilityCheck; readonly skills?: readonly string[] }): BuildSystemPromptOptions {
  const { skills, ...rest } = options;
  return { ...rest, capabilities: options.capabilities ?? promptCapabilities(options.tools, skills) };
}

/** The agent check of an agent that can call the shell and nothing else. */
export const SHELL_CAPABILITIES: CapabilityCheck = promptCapabilities([{ name: "bash" }]);
