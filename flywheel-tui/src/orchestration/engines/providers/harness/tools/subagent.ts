// Subagents intentionally bypass createRunnerContext. The shape of a subagent
// invocation — inline `await runner.done` plus cost extraction from the emitted
// `result` NDJSON event — doesn't fit RunnerContext's callback-based onDone
// contract. Forcing it through RunnerContext would require either exposing the
// underlying runner (breaking encapsulation) or routing cost through a new
// callback field (adding ceremony for a single consumer). Keeping subagent as
// a direct HarnessRunner consumer is more elegant.

import type { AgentDefinition } from "../agent-loader.js";
import type { LLMClient } from "../llm/types.js";
import type { ModelFamily } from "../llm/model-family.js";
import type { NDJSONEvent } from "../../../../../infra/ndjson-event-types.js";
import type { EngineRunner, RunnerOptions } from "../../../core/types.js";
import type { ToolDefinition, ToolResult, ToolContext } from "./types.js";
import { resolveModelForTier, isModelTier } from "../../../../config/model-tiers.js";
import { HarnessRunner } from "../runner.js";
import { errorMessage } from "../../../../../infra/error-message.js";
import { Log } from "../../../../../infra/log.js";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const log = Log.create({ service: "harness-subagent" });

export interface SubagentToolDeps {
  agentRegistry: Map<string, AgentDefinition>;
  createLLMClient: (model: string) => LLMClient;
  modelFamily: ModelFamily;
  availableModels?: ReadonlySet<string>;
  // Model the parent harness loop is running on. Used when an agent's tier is
  // "inherit" so the subagent runs at the same capability level as its caller.
  parentModel: string;
  onRenderEvent: (event: NDJSONEvent) => void;
  addCost: (cost: number, inputTokens: number, outputTokens: number) => void;
  projectInstructions: string;
  sessionDir: string;
  /**
   * Test injectable: construct the nested runner. Defaults to `HarnessRunner`.
   * Replacing this lets unit tests capture the `RunnerOptions` passed in and
   * simulate runner behavior without hitting a real LLM.
   */
  _createRunner?: (opts: RunnerOptions, clientFactory: (model: string) => LLMClient) => EngineRunner;
}

function buildDescription(agents: Map<string, AgentDefinition>): string {
  const agentList = Array.from(agents.values())
    .map(a => `- ${a.name} (default: ${a.defaultTier}): ${a.description}\n  Tools: ${a.tools.join(", ")}`)
    .join("\n");

  return `Launch a specialized subagent to handle a focused subtask autonomously in an isolated context. Each agent type has its own tools and system prompt.

Available agent types:

${agentList}

When to use:
- Read-only investigation: use a locator-/analyzer-/explorer-tier agent to search code, trace dependencies, or answer structural questions.
- Implementation tasks: use a worker-tier agent for focused file changes, test fixes, or code generation.
- Review/analysis: use a reviewer-tier agent for code review or plan evaluation.

Launch multiple subagents concurrently whenever the work splits into independent topics — put multiple \`subagent\` calls in a single response. Parallel fan-out is the right way to cover breadth; one subagent plus your own parallel searches on the same topic is not.

Writing the prompt:
Brief the subagent like a smart colleague who just walked into the room — it has not seen your conversation, does not know what you have tried, and does not understand why the task matters. Explain what you are trying to accomplish and why, what you have already ruled out, and enough surrounding context that the subagent can make judgment calls rather than just follow a narrow instruction. Include file paths, constraints, and the format you want the answer in ("report in under 200 words"). Terse command-style prompts produce shallow, generic work.

Never delegate understanding. Do not write "based on your findings, fix the bug" or "based on the research, implement it." Prompts that prove you understood — specific file paths, line numbers, what to change — produce better work.

Examples:

<example>
user: "What's left on this branch before we can ship?"
assistant (internal): Survey question spanning git state, tests, and config — delegate so the raw command output stays out of my context.
Call: subagent({ subagent_type: "explorer", description: "Ship-readiness audit", prompt: "Audit what's left before this branch can ship. Check: uncommitted changes, commits ahead of main, whether tests exist, whether CI-relevant files changed. Report a punch list — done vs. missing. Under 200 words." })
</example>

<example>
user: "Research how auth, sessions, and permissions interact in this codebase."
assistant (internal): Three independent subsystems — parallel fan-out, one subagent per topic, all in a single response.
Call: three parallel subagent calls in the same response, one per subsystem, each with a self-contained prompt.
</example>

The subagent's streaming output (text, tool calls) is visible to the user in real time. When it finishes, its final text response is returned to you as the tool result — summarize key findings for the user.`;
}

export function createSubagentTool(deps: SubagentToolDeps): ToolDefinition {
  const description = buildDescription(deps.agentRegistry);
  const subagentsDir = join(deps.sessionDir, "subagents");
  mkdirSync(subagentsDir, { recursive: true });

  return {
    name: "subagent",
    description,
    input_schema: {
      type: "object",
      properties: {
        subagent_type: {
          type: "string",
          description: "Agent type to invoke. See available types in the tool description.",
        },
        description: {
          type: "string",
          description: "A short (3-5 word) description of the task, shown in the UI as the subagent's goal.",
        },
        prompt: {
          type: "string",
          description: "The COMPLETE task instruction for the subagent. Must be self-contained — the subagent has no access to your conversation history. Include: what to do, what specific information you need, and what format the answer should take.",
        },
        tier: {
          type: "string",
          enum: ["cheap", "mid", "powerful"],
          description: "Override the agent's default model tier. Omit to use the agent's default.",
        },
      },
      required: ["subagent_type", "description", "prompt"],
    },

    async execute(input: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
      const agentType = input.subagent_type;
      const prompt = input.prompt;
      const tierOverride = input.tier;
      const toolCallId = context.toolCallId;

      if (typeof agentType !== "string" || !agentType) {
        return { content: "subagent requires a string 'subagent_type' parameter.", isError: true };
      }
      if (typeof prompt !== "string" || !prompt) {
        return { content: "subagent requires a string 'prompt' parameter.", isError: true };
      }
      if (tierOverride != null && typeof tierOverride !== "string") {
        return { content: "subagent 'tier' parameter must be a string when provided.", isError: true };
      }

      const agent = deps.agentRegistry.get(agentType);
      if (!agent) {
        const available = Array.from(deps.agentRegistry.keys()).join(", ");
        return { content: `Unknown subagent_type '${agentType}'. Available: ${available}`, isError: true };
      }

      if (tierOverride != null && !isModelTier(tierOverride)) {
        return { content: `Invalid tier '${tierOverride}'. Must be one of: cheap, mid, powerful`, isError: true };
      }

      const effectiveTier = tierOverride ?? agent.defaultTier;
      const modelString = effectiveTier === "inherit"
        ? deps.parentModel
        : resolveModelForTier(effectiveTier, deps.modelFamily, deps.availableModels);

      let totalCostUsd = 0;
      let totalInputTokens = 0;
      let totalOutputTokens = 0;
      let lastAssistantText = "";

      // Mirror Claude's wire shape: nested agents emit only completed assistant
      // messages and tool results to the parent render stream — never per-token
      // deltas, never nested result/usage envelopes. The parser already routes
      // parent-scoped events into the subagent's tool group; deltas have no
      // parent-scoped destination and would leak to the top-level output.
      const filteredOnEvent = (event: NDJSONEvent): void => {
        if (event.type === "result") {
          const data = event.data as {
            total_cost_usd?: number;
            usage?: { input_tokens?: number; output_tokens?: number };
          };
          if (data.total_cost_usd == null) {
            log.warn("subagent result event missing total_cost_usd", { agentType });
          }
          totalCostUsd = data.total_cost_usd ?? 0;
          totalInputTokens = data.usage?.input_tokens ?? 0;
          totalOutputTokens = data.usage?.output_tokens ?? 0;
          return;
        }
        try {
          if (event.type === "content_block_delta") {
            return;
          }
          if (event.type === "assistant") {
            const content = event.data.message?.content ?? [];
            for (const b of content) {
              if (b.type === "text") lastAssistantText = b.text;
            }
          }
          deps.onRenderEvent(event);
        } catch (err) {
          log.warn("filteredOnEvent error", { error: errorMessage(err), agentType });
        }
      };

      const conversationPathResolver = (_sessionId: string): string =>
        join(subagentsDir, `${toolCallId ?? "unknown"}.jsonl`);

      const runnerOptions: RunnerOptions = {
        model: modelString,
        systemPrompt: agent.systemPrompt,
        cwd: context.cwd,
        onEvent: filteredOnEvent,
        signal: context.signal,
        engineToolNames: agent.tools,
        parentToolUseId: toolCallId,
        maxLLMCalls: agent.maxTurns,
        conversationPath: conversationPathResolver,
        // Empty registry prevents the runner from exposing the `subagent` tool
        // to the nested run (recursion guard). The parent's registry would
        // inject it via extraTools.
        agentRegistry: new Map(),
        projectInstructions: deps.projectInstructions,
      };

      const factory = deps._createRunner
        ?? ((opts, clientFactory) => new HarnessRunner(opts, clientFactory));
      const runner = factory(runnerOptions, deps.createLLMClient);

      try {
        runner.send(prompt);
        await runner.done;
      } catch (err) {
        const errMsg = `Subagent '${agentType}' failed: ${errorMessage(err)}`;
        deps.addCost(totalCostUsd, totalInputTokens, totalOutputTokens);
        return { content: errMsg, isError: true };
      }

      deps.addCost(totalCostUsd, totalInputTokens, totalOutputTokens);

      const resultText = lastAssistantText || `Subagent '${agentType}' completed without producing text output.`;

      return { content: resultText, isError: false };
    },
  };
}
