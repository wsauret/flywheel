import { describe, expect, test } from "bun:test";
import { Effect, Exit, Scope } from "effect";
import { DEFAULT_MODEL_INTERACTION_PROFILE } from "../../../../src/orchestration/agent-runtime/model-interaction-profile.js";
import { FUNCTION_TOOL_PRESENTATION } from "../../../../src/orchestration/agent-runtime/llm/types.js";
import { composeFirstPartyModules, type FirstPartyModuleComposition } from "../../../../src/orchestration/modules.js";
import { openRequestInputs } from "../../../../src/orchestration/agent-runtime/request-inputs.js";
import { resolveRuntimeConversation } from "../../../../src/orchestration/agent-runtime/runtime-conversation.js";
import type { LLMClientFactory } from "../../../../src/orchestration/agent-runtime/factory.js";
import type { RunnableAgentOptions } from "../../../../src/orchestration/agent-runtime/types.js";
import { testRuntimeConfigCapture } from "../../../helpers/request-tool-surface.js";
import { repoDefinitions } from "../../../helpers/project-definitions.js";
import { unusedSessionMessaging } from "../../../helpers/child-session-control.js";
import { asModelClient } from "./_model-client.js";
import { makeOptions } from "./_runner-options.js";
import { askUserController } from "./tools/_planner-fixtures.js";

describe("chat profile", () => {
  const client: LLMClientFactory = async () => asModelClient({
    accessProvider: "anthropic_api", modelFamily: "anthropic", model: "test", toolPresentation: FUNCTION_TOOL_PRESENTATION,
    contextLimit: 100_000, outputLimit: 8_000, supportsReasoning: false,
    priceFor: () => ({ status: "unavailable", reason: "missing-rate-card" }),
    async *streamWithTools() { yield { kind: "done", stopReason: "end_turn" } },
  });

  test("asks the resolver once for each request with its module snapshot, and a profile ends when the resolver stops answering one", async () => {
    // Two distinct selections, as when the person turns a module off between two requests.
    const snapshots = [composeFirstPartyModules(), composeFirstPartyModules(undefined, ["papercuts"])];
    let request = 0;
    const asked: FirstPartyModuleComposition[] = [];
    const options: RunnableAgentOptions = {
      ...makeOptions({ agentRegistry: new Map(), agentsMd: "" }),
      captureRuntimeConfig: testRuntimeConfigCapture, awaitModelAccessSettled: async () => {},
      runtimeSurfaces: { askUser: askUserController(), sessions: unusedSessionMessaging() },
      moduleSelection: () => snapshots[Math.min(request, 1)]!,
      chatProfile: (modules) => {
        asked.push(modules);
        return asked.length === 1 ? { prompt: "Profile body.", tools: ["read", "ask_user"] } : undefined;
      },
    };
    const scope = Scope.makeUnsafe("sequential");
    try {
      const opened = await openRequestInputs({
        options, definitions: repoDefinitions(), personas: new Map(),
        conversation: resolveRuntimeConversation(options.conversation, { providerSessionKey: "agent", artifactScopeId: "artifact", retrievalSessionId: "retrieval" }),
        captureModelRuntime: async () => ({ generation: client, createLLMClient: client }),
        createRunner: () => { throw new Error("no run is built") },
        providerSessionLifetime: { providerSessionKey: "agent", scope },
      }, { kind: "prestart", signal: new AbortController().signal });
      const { request: inputs, planned } = await opened.build();
      const buildPrompt = inputs.systemPrompt;
      if (typeof buildPrompt !== "function") throw new Error("a chat builds its system prompt for each request");
      const offered = async () => {
        const surface = await inputs.tools.resolve();
        const prompt = await surface.prepareStablePrompt(() => buildPrompt(planned, DEFAULT_MODEL_INTERACTION_PROFILE), DEFAULT_MODEL_INTERACTION_PROFILE);
        return {
          identities: new Set(prompt.definitions.map(({ name }) => surface.registrationIdentities.get(name) ?? name)),
          planned: new Set(surface.registrationIdentities.values()),
          chatPrompt: surface.chatPrompt,
          stable: prompt.systemPrompt.stable,
        };
      };

      const first = await offered();
      expect(asked.length).toBe(1);
      expect(asked[0]).toBe(snapshots[0]!);
      expect(first.identities).toEqual(new Set(["read", "ask_user", "message_session", "list_sessions"]));
      expect(first.identities).toEqual(first.planned);
      expect(first.chatPrompt).toBe("Profile body.");
      expect(first.stable.startsWith("Profile body.")).toBe(true);

      request = 1;
      const second = await offered();
      expect(asked.length).toBe(2);
      expect(asked[1]).toBe(snapshots[1]!);
      expect(second.identities.has("search")).toBe(true);
      expect(second.identities).toEqual(second.planned);
      expect(second.chatPrompt).toBeUndefined();
      expect(second.stable).not.toContain("Profile body.");
    } finally {
      Effect.runSync(Scope.close(scope, Exit.void));
    }
  });
});
