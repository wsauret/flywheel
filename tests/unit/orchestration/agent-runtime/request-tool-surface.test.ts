import { describe, expect, spyOn, test } from "bun:test";
import { createRequestToolSurface, type PlannedRequest } from "../../../../src/orchestration/agent-runtime/request-tool-surface.js";
import { planToolExposure } from "../../../../src/orchestration/agent-runtime/tools/tool-exposure-planner.js";
import type { RuntimeTool } from "../../../../src/orchestration/agent-runtime/tools/types.js";
import { DEFAULT_MODEL_INTERACTION_PROFILE } from "../../../../src/orchestration/agent-runtime/model-interaction-profile.js";
import { NO_CAPABILITY_ACCESS } from "../../../../src/orchestration/agent-runtime/tools/types.js";
import { executePreparedTool, prepareToolCall } from "../../../../src/orchestration/agent-runtime/tools/tool-dispatch.js";
import { fixedRequestToolSurface, testDefinitionAvailability, testKernelToolDeps, testRuntimeConfigCapture, plannedRequest } from "../../../helpers/request-tool-surface.js";
import { NO_MODULE_RUNTIMES } from "../../../../src/infra/module-runtime.js";
import { composeFirstPartyModules, composeRealmModuleSnapshot, SHIPPED_MODULES, type FirstPartyModule } from "../../../../src/orchestration/modules.js";
import { hashToolInputFormat } from "../../../../src/orchestration/session/provider-request-audit-hash.js";
import { FUNCTION_TOOL_PRESENTATION } from "../../../../src/orchestration/agent-runtime/llm/types.js";
import { OPENAI_RESPONSES_TOOL_PRESENTATION } from "../../../../src/orchestration/agent-runtime/llm/provider-description.js";
import { prepareLocalTokenizer } from "../../../../src/infra/local-tokenizer.js";
import * as localTokenizer from "../../../../src/infra/local-tokenizer.js";
import { tokenCountingPolicy } from "../../../../src/orchestration/agent-runtime/compaction/token-counter.js";
import { renderSystemPrompt, stableSystemPrompt, SYSTEM_PROMPT_SEPARATOR } from "../../../../src/orchestration/agent-runtime/llm/system-prompt-tiers.js";

const fullModules = () => composeRealmModuleSnapshot({ moduleIds: SHIPPED_MODULES.map((module) => module.id) });
interface UnknownRecord { [key: string]: unknown }

function fakeTool(name: string, schema: UnknownRecord = {}): RuntimeTool {
  return {
    name,
    action: "file_read",
    description: `${name} description`,
    inputSchema: { type: "object", properties: schema },
    isConcurrencySafe: true,
    execute: async () => ({ content: "", outcome: "ok" }),
  };
}

function plan(
  tools: readonly RuntimeTool[],
  omitted: ReadonlyArray<{ name: string; reason: string }> = [],
  registrationIdentities = new Map(tools.map((tool) => [tool.name, tool.name])),
): PlannedRequest {
  const eligibleTools = new Map(tools.map((tool) => [tool.name, tool]));
  return { eligibleTools, tools: eligibleTools, omitted, usable: new Set(eligibleTools.keys()), turnedOff: [], registrationIds: new Map(tools.map((tool) => [tool.name, tool.name])), registrationIdentities, definitionAvailability: testDefinitionAvailability() };
}

describe("request tool surface", () => {
  test("projects admitted registrations behind a provider alias and refuses every tool of a none profile", async () => {
    const shell = fakeTool("transport-shell")
    const reader = fakeTool("bash")
    const policy = {
      category: "core", action: "shell_exec", cloneInheritance: "inherit", learningReviewExecutable: false,
      semanticBundle: null, personaBaseline: false, registryOrder: 80,
    } as const
    const module: FirstPartyModule = {
      id: "development", dependencies: [], availability: { kind: "available" }, observers: [], transformers: [], gates: [],
      contributions: [
        { domain: "tools", id: "diagnostic-shell", value: { kind: "tool", name: "diagnostic-shell", declaration: { ...policy, registrations: {
          "diagnostic-shell": { capabilities: [], exposedName: shell.name, create: () => ({ tool: shell }) },
        } } } },
        { domain: "tools", id: "diagnostic-reader", value: { kind: "tool", name: "diagnostic-reader", declaration: { ...policy, action: "file_read", registrations: {
          "diagnostic-reader": { capabilities: [], create: () => ({ tool: reader }) },
        } } } },
      ],
    }
    const owner = await createRequestToolSurface(
      () => ({ ...plan([shell, reader]), registrationIds: new Map([[shell.name, "diagnostic-shell"], [reader.name, "diagnostic-reader"]]) }),
      () => composeFirstPartyModules([...SHIPPED_MODULES, module]),
      testRuntimeConfigCapture,
    )
    const surface = await owner.resolve()
    const prompt = await surface.prepareStablePrompt(() => stableSystemPrompt("system"), DEFAULT_MODEL_INTERACTION_PROFILE)
    expect(prompt.definitions.map(({ name, description }) => ({ name, description }))).toEqual([
      { name: shell.name, description: shell.description },
      { name: reader.name, description: reader.description },
    ])

    const moduleSnapshot = composeFirstPartyModules([...SHIPPED_MODULES, module]);
    const restrictedOwner = await createRequestToolSurface(
      () => plannedRequest(planToolExposure({
        kernel: testKernelToolDeps({ moduleSnapshot }), modules: NO_MODULE_RUNTIMES, profile: "none",
      })), () => moduleSnapshot, testRuntimeConfigCapture,
    );
    const restricted = await restrictedOwner.resolve();
    const restrictedPrompt = await restricted.prepareStablePrompt(() => stableSystemPrompt("system"), DEFAULT_MODEL_INTERACTION_PROFILE);
    expect(restrictedPrompt.definitions).toEqual([]);
    expect([...restricted.usableToolNames]).toEqual([]);
    const execute = spyOn(shell, "execute");
    try {
      for (const name of ["diagnostic-shell", shell.name, "process", "skill"]) {
        const prepared = prepareToolCall(
          { id: `denied-${name}`, name, input: {} }, restricted.tools, restricted.executionAdmission(name),
        );
        const result = await executePreparedTool(prepared, {
          executionCwd: process.cwd(), userDataRoot: "/scratch/test-account", projectRoot: process.cwd(), capabilityAccess: NO_CAPABILITY_ACCESS,
          artifactScopeId: "strict-profile", retrievalSessionId: "strict-profile",
        });
        expect(result.outcome).toBe("error");
      }
      expect(execute).not.toHaveBeenCalled();
    } finally {
      execute.mockRestore();
    }
  })

  test("counts the static prompt and tools with the serving model policy", async () => {
    await prepareLocalTokenizer();
    const search = fakeTool("search", {
      "ｋｅｙ": { type: "string", enum: ["ﬃ"], default: "＂＼", examples: [["ａ"], { "ｂ": "ｃ" }] },
    });
    search.description = "Ｓｅａｒｃｈ";
    const tools = [search, fakeTool("bash", { command: { type: "string" } })];
    const original = structuredClone({ description: search.description, inputSchema: search.inputSchema });
    const owner = await createRequestToolSurface(
      () => plan(tools),
      fullModules,
      testRuntimeConfigCapture,
    );
    const surface = await owner.resolve();
    await surface.prepareStablePrompt(() => stableSystemPrompt("Static prompt with tokenizer-sensitive prose."), DEFAULT_MODEL_INTERACTION_PROFILE);
    const attempt = {
      model: "gpt-5.4",
      modelFamily: "openai" as const,
      promptNotes: { progress: "", modelNotes: "" },
      toolPresentation: FUNCTION_TOOL_PRESENTATION,
    };
    const prepared = surface.prepareAttempt(attempt);
    const policy = tokenCountingPolicy("gpt-5.4", "openai");

    expect(prepared.attemptStaticTokens).toBe(policy.countText(renderSystemPrompt(prepared.systemPrompt)) + policy.countText(JSON.stringify(prepared.tools)));
    const namespaced = surface.prepareAttempt({
      ...attempt,
      toolPresentation: { ...FUNCTION_TOOL_PRESENTATION, format: "mcp-function-schema", wireName: (name: string) => `mcp__runtime__${name}` },
    });
    expect(namespaced.tools).toEqual(prepared.tools);
    expect(prepared.tools[0]).toEqual({ name: search.name, description: original.description, input_schema: original.inputSchema });
    expect({ description: search.description, inputSchema: search.inputSchema }).toEqual(original);
    expect(namespaced.auditTools.map(({ name, executableId, registrationId }) => ({ name, executableId, registrationId }))).toEqual([
      { name: "mcp__runtime__search", executableId: "search", registrationId: "search" },
      { name: "mcp__runtime__bash", executableId: "bash", registrationId: "bash" },
    ]);
    expect([...surface.tools.keys()]).toEqual(["search", "bash"]);
    expect(namespaced.attemptStaticTokens).toBe(
      policy.countText(renderSystemPrompt(namespaced.systemPrompt))
      + policy.countText(JSON.stringify(prepared.tools.map((tool) => ({ ...tool, name: `mcp__runtime__${tool.name}` })))),
    );
  });

  test("preserves combined static-context rounding for an unmapped model", async () => {
    const owner = await createRequestToolSurface(
      () => plan([]),
      fullModules,
      testRuntimeConfigCapture,
    );
    const surface = await owner.resolve();
    await surface.prepareStablePrompt(() => stableSystemPrompt("a"), DEFAULT_MODEL_INTERACTION_PROFILE);

    const prepared = surface.prepareAttempt({
      model: "unmapped-model",
      modelFamily: "openai",
      promptNotes: { progress: "", modelNotes: "" },
      toolPresentation: FUNCTION_TOOL_PRESENTATION,
    });

    expect(prepared.attemptStaticTokens).toBe(1);
  });

  test("reuses static token counts across request surfaces and invalidates every cache key input", async () => {
    let countCalls = 0;
    const tokenizerSpy = spyOn(localTokenizer, "localTokenizerForModel").mockImplementation((model) => ({
      identity: model.startsWith("claude") ? "ClaudeV3" : "O200kBase",
      count(text) {
        countCalls += 1;
        return text.length;
      },
    }));
    let prompt = "stable prompt";
    const owner = await createRequestToolSurface(
      () => plan([fakeTool("read"), fakeTool("write")]),
      fullModules,
      testRuntimeConfigCapture,
    );
    const prepare = async (model = "gpt-5.4") => {
      const surface = await owner.resolve();
      await surface.prepareStablePrompt(() => stableSystemPrompt(prompt), DEFAULT_MODEL_INTERACTION_PROFILE);
      return surface.prepareAttempt({
        model,
        modelFamily: model.startsWith("claude") ? "anthropic" : "openai",
        promptNotes: { progress: "", modelNotes: "" },
        toolPresentation: FUNCTION_TOOL_PRESENTATION,
      });
    };

    try {
      await prepare();
      expect(countCalls).toBe(2);
      await prepare();
      expect(countCalls).toBe(2);

      prompt = "changed prompt";
      await prepare();
      expect(countCalls).toBe(4);
      await prepare("claude-sonnet-4.5");
      expect(countCalls).toBe(6);
    } finally {
      tokenizerSpy.mockRestore();
    }
  });

  test("derives provider tool definitions from a fixed tool map", async () => {
    const owner = await fixedRequestToolSurface(new Map([["read", fakeTool("read")]]));
    const surface = await owner.resolve();
    await surface.prepareStablePrompt(() => stableSystemPrompt("prompt"), DEFAULT_MODEL_INTERACTION_PROFILE);
    expect(surface.prepareAttempt({ model: "model", promptNotes: { progress: "", modelNotes: "" }, toolPresentation: FUNCTION_TOOL_PRESENTATION }).tools).toEqual([
      { name: "read", description: "read description", input_schema: { type: "object", properties: {} } },
    ]);
    expect(surface.prepareAttempt({ model: "model", promptNotes: { progress: "", modelNotes: "" }, toolPresentation: FUNCTION_TOOL_PRESENTATION }).omittedTools).toEqual([]);
  });

  test("keeps logical edit authority behind the physical provider adapter", async () => {
    const tool = fakeTool("apply_patch", { patch: { type: "string" } });
    const owner = await createRequestToolSurface(
      () => plan([tool], [], new Map([["apply_patch", "edit"]])),
      fullModules,
      testRuntimeConfigCapture,
    );
    const surface = await owner.resolve();
    await surface.prepareStablePrompt(() => stableSystemPrompt("prompt"), { ...DEFAULT_MODEL_INTERACTION_PROFILE, fileEditContract: "apply_patch" });
    const attempt = surface.prepareAttempt({ model: "gpt-5", promptNotes: { progress: "", modelNotes: "" }, toolPresentation: FUNCTION_TOOL_PRESENTATION });
    expect(attempt.tools.map(definition => definition.name)).toEqual(["apply_patch"]);
    expect(attempt.auditTools).toEqual([expect.objectContaining({ executableId: "apply_patch", registrationId: "apply_patch" })]);
    expect(surface.usableToolNames).toEqual(new Set(["edit"]));
    expect(surface.tools.has("edit")).toBe(false);
    expect(surface.executionAdmission("apply_patch")).toEqual({ ok: true });
  });

  test("resolves legacy registrations from the recorded model contract", async () => {
    const owner = await fixedRequestToolSurface(new Map([["edit", fakeTool("edit")], ["process", fakeTool("process")]]));
    const surface = await owner.resolve();

    expect(surface.historicalRegistrationId("apply_patch", "gpt-5", "openai")).toBe("apply_patch");
    expect(surface.historicalRegistrationId("edit", "claude-sonnet-4", "anthropic")).toBe("edit");
    // No registration serves the retired `exec` shell, so its recorded calls lower to context.
    expect(surface.historicalRegistrationId("exec", "gpt-6-luna", "openai")).toBeUndefined();
    expect(surface.historicalRegistrationId("process", "gpt-6-luna", "openai")).toBe("process.native");
    expect(surface.historicalRegistrationId("process", "claude-sonnet-4", "anthropic")).toBe("process.native");
    expect(surface.historicalRegistrationId("process", undefined, undefined)).toBeUndefined();
  });

  test("projects apply_patch audit evidence from the serving adapter presentation", async () => {
    const tool = { ...fakeTool("apply_patch", { patch: { type: "string" } }), wire: { kind: "custom" as const, grammar: { syntax: "lark" as const, definition: "start: \"*** Begin Patch\"" }, functionDescription: "Put the patch in the patch string" } };
    const owner = await createRequestToolSurface(() => plan([tool]), fullModules, testRuntimeConfigCapture);
    const surface = await owner.resolve();
    await surface.prepareStablePrompt(() => stableSystemPrompt("prompt"), DEFAULT_MODEL_INTERACTION_PROFILE);

    const responses = surface.prepareAttempt({ model: "gpt-5", promptNotes: { progress: "", modelNotes: "" }, toolPresentation: OPENAI_RESPONSES_TOOL_PRESENTATION });
    const completions = surface.prepareAttempt({ model: "openai/gpt-4o", promptNotes: { progress: "", modelNotes: "" }, toolPresentation: FUNCTION_TOOL_PRESENTATION });

    expect(responses.auditTools).toEqual([expect.objectContaining({ kind: "custom", description: tool.description })]);
    expect(completions.auditTools).toEqual([expect.objectContaining({
      kind: "function",
      description: "Put the patch in the patch string",
      inputFormatSha256: hashToolInputFormat(tool.inputSchema),
    })]);
  });

  test("hashes the exact descriptor projected by the serving adapter", async () => {
    const tool = fakeTool("apply_patch", { patch: { type: "string" } });
    const owner = await createRequestToolSurface(() => plan([tool]), fullModules, testRuntimeConfigCapture);
    const surface = await owner.resolve();
    await surface.prepareStablePrompt(() => stableSystemPrompt("prompt"), DEFAULT_MODEL_INTERACTION_PROFILE);
    const inputFormat = Object.freeze({ type: "grammar", syntax: "lark", definition: "adapter-owned" });
    const toolPresentation = Object.freeze({
      format: "test-custom",
      present: () => Object.freeze({ kind: "custom" as const, description: "adapter-owned", inputFormat }),
    });

    expect(surface.prepareAttempt({ model: "model", promptNotes: { progress: "", modelNotes: "" }, toolPresentation }).auditTools).toEqual([
      expect.objectContaining({ kind: "custom", description: "adapter-owned", inputFormatSha256: hashToolInputFormat(inputFormat) }),
    ]);
  });

  test("requires an explicit request capture before exposing a current surface", async () => {
    let calls = 0;
    const owner = await createRequestToolSurface(() => {
      calls += 1;
      return plan([fakeTool("read")]);
    }, fullModules, testRuntimeConfigCapture);
    expect(() => owner.current()).toThrow("Resolve the request capability composition")
    await owner.resolve()
    expect(owner.current().tools.has("read")).toBe(true);
    expect(owner.current().tools.has("read")).toBe(true);
    expect(calls).toBe(1);
  });

  test("re-plans on the next request so a parked runner sees the new schema", async () => {
    let confirmationRequired = false;
    const owner = await createRequestToolSurface(() => plan([
      fakeTool("workflow", confirmationRequired ? { confirmation_id: { type: "string" } } : {}),
    ]), fullModules, testRuntimeConfigCapture);

    expect((await owner.resolve()).tools.get("workflow")?.inputSchema).toEqual({ type: "object", properties: {} });
    confirmationRequired = true;
    const next = await owner.resolve();
    expect(next.tools.get("workflow")?.inputSchema).toEqual({
      type: "object",
      properties: { confirmation_id: { type: "string" } },
    });
    await next.prepareStablePrompt(() => stableSystemPrompt("prompt"), DEFAULT_MODEL_INTERACTION_PROFILE);
    expect(next.prepareAttempt({ model: "model", promptNotes: { progress: "", modelNotes: "" }, toolPresentation: FUNCTION_TOOL_PRESENTATION }).tools[0]?.input_schema).toEqual(next.tools.get("workflow")?.inputSchema);
  });

  test("pins runtime config through attempts and refreshes it only on the next admitted request", async () => {
    let revision = 1;
    const owner = await createRequestToolSurface(
      () => plan([fakeTool("read")]),
      fullModules,
      () => ({ ...testRuntimeConfigCapture(), revision }),
    );

    const admitted = await owner.resolve();
    await admitted.prepareStablePrompt(() => stableSystemPrompt("prompt"), DEFAULT_MODEL_INTERACTION_PROFILE);
    revision = 2;

    expect(owner.current().runtimeConfig).toBe(admitted.runtimeConfig);
    expect(admitted.prepareAttempt({ model: "primary", promptNotes: { progress: "", modelNotes: "" }, toolPresentation: FUNCTION_TOOL_PRESENTATION })).toBeDefined();
    expect(admitted.prepareAttempt({ model: "fallback", promptNotes: { progress: "", modelNotes: "" }, toolPresentation: FUNCTION_TOOL_PRESENTATION })).toBeDefined();
    expect(admitted.runtimeConfig.revision).toBe(1);
    expect((await owner.resolve()).runtimeConfig.revision).toBe(2);
  });

  test("settles an advertised tool under its pinned composition after a live disable", async () => {
    let learning = true;
    let executions = 0;
    const memory = { ...fakeTool("memory"), execute: async () => {
      executions += 1;
      return { content: "executed", outcome: "ok" as const };
    } };
    const owner = await createRequestToolSurface(
      (snapshot) => plan(snapshot.enabledModuleIds.includes("learning") ? [memory] : []),
      () => composeRealmModuleSnapshot({ moduleIds: learning ? ["learning"] : [] }),
      testRuntimeConfigCapture,
    );

    const admitted = await owner.resolve();
    learning = false;
    const prepared = prepareToolCall(
      { id: "memory-call", name: "memory", input: {} },
      admitted.tools,
      admitted.executionAdmission("memory"),
    );
    const result = await executePreparedTool(prepared, {
      executionCwd: process.cwd(),
      projectRoot: process.cwd(),
      userDataRoot: `${process.cwd()}/.test-account`,
      artifactScopeId: "memory-call",
      retrievalSessionId: "memory-call",
      capabilityAccess: NO_CAPABILITY_ACCESS,
    });

    expect(result).toEqual({ content: "executed", outcome: "ok" });
    expect(executions).toBe(1);
    const next = await owner.resolve();
    expect(next.tools.has("memory")).toBe(false);
    await next.prepareStablePrompt(() => stableSystemPrompt("prompt"), DEFAULT_MODEL_INTERACTION_PROFILE);
    expect(next.prepareAttempt({ model: "model", promptNotes: { progress: "", modelNotes: "" }, toolPresentation: FUNCTION_TOOL_PRESENTATION }).tools.some((tool) => tool.name === "memory")).toBe(false);
    expect(next.moduleSnapshot.enabledModuleIds).not.toContain("learning");
  });

  test("pins module, skill, and omission state through failover, then refreshes the next request", async () => {
    let learning = true;
    const modules = () => composeRealmModuleSnapshot({ moduleIds: learning ? SHIPPED_MODULES.map((module) => module.id) : [] });
    const owner = await createRequestToolSurface(
      (snapshot) => plan(snapshot.enabledModuleIds.includes("learning") ? [fakeTool("memory")] : [], snapshot.enabledModuleIds.includes("learning") ? [] : [{ name: "memory", reason: "Learning is disabled" }]),
      modules,
      testRuntimeConfigCapture,
    );

    const admitted = await owner.resolve();
    learning = false;
    expect(admitted.moduleSnapshot.enabledModuleIds).toContain("learning");
    expect(admitted.tools.has("memory")).toBe(true);
    await admitted.prepareStablePrompt(() => stableSystemPrompt("prompt"), DEFAULT_MODEL_INTERACTION_PROFILE);
    expect(admitted.prepareAttempt({ model: "model", promptNotes: { progress: "", modelNotes: "" }, toolPresentation: FUNCTION_TOOL_PRESENTATION }).omittedTools).toEqual([]);
    expect(admitted.providerRegistry).toBe(admitted.providerRegistry);
    expect(admitted.providerRegistry.selection.definitions.map((definition) => definition.id)).toEqual(
      admitted.moduleSnapshot.contributions.filter((contribution) => contribution.domain === "providers").map((contribution) => contribution.value.definition.id),
    );

    const disabled = await owner.resolve();
    expect(disabled.moduleSnapshot.enabledModuleIds).not.toContain("learning");
    expect(disabled.tools.has("memory")).toBe(false);
    await disabled.prepareStablePrompt(() => stableSystemPrompt("prompt"), DEFAULT_MODEL_INTERACTION_PROFILE);
    expect(disabled.prepareAttempt({ model: "model", promptNotes: { progress: "", modelNotes: "" }, toolPresentation: FUNCTION_TOOL_PRESENTATION }).omittedTools).toEqual([{ name: "memory", reason: "Learning is disabled" }]);
  });

  test("caches each presentation's definitions and keeps the plan's omission evidence", async () => {
    let schemaSerializations = 0;
    const owner = await createRequestToolSurface(() => plan([
      fakeTool("bash", { toJSON: () => { schemaSerializations += 1; return { type: "object" }; } }),
      fakeTool("handoff", { toJSON: () => { schemaSerializations += 1; return { type: "object" }; } }),
    ], [{ name: "workflow", reason: "Workflows is disabled" }]), fullModules, testRuntimeConfigCapture);
    const surface = await owner.resolve();
    await surface.prepareStablePrompt(() => stableSystemPrompt("literal bytes"), DEFAULT_MODEL_INTERACTION_PROFILE, true);

    const first = surface.prepareAttempt({ model: "model", promptNotes: { progress: "ignored", modelNotes: "ignored" }, toolPresentation: FUNCTION_TOOL_PRESENTATION });
    const repeated = surface.prepareAttempt({ model: "model", promptNotes: { progress: "ignored", modelNotes: "ignored" }, toolPresentation: FUNCTION_TOOL_PRESENTATION });

    expect(first.systemPrompt).toEqual(stableSystemPrompt("literal bytes"));
    expect(first.tools.map(({ name }) => name)).toEqual(["bash", "handoff"]);
    expect(first.omittedTools).toEqual([{ name: "workflow", reason: "Workflows is disabled" }]);
    expect(repeated.tools).toBe(first.tools);
    expect(schemaSerializations).toBe(2);
  });

  test("pins native Bash persistence with every request-surface projection", async () => {
    let persistenceEnabled = false;
    const owner = await createRequestToolSurface(() => {
      const bash = fakeTool("bash", persistenceEnabled ? { persist_after_exit: { type: "boolean" } } : {});
      return plan([bash], persistenceEnabled ? [] : [{ name: "bash.persist_after_exit", reason: "persistent processes are disabled" }]);
    }, fullModules, testRuntimeConfigCapture);

    const disabled = await owner.resolve();
    persistenceEnabled = true;
    expect(JSON.stringify(disabled.tools.get("bash")?.inputSchema)).not.toContain("persist_after_exit");
    await disabled.prepareStablePrompt(() => stableSystemPrompt("prompt"), DEFAULT_MODEL_INTERACTION_PROFILE);
    expect(JSON.stringify(disabled.prepareAttempt({ model: "model", promptNotes: { progress: "", modelNotes: "" }, toolPresentation: FUNCTION_TOOL_PRESENTATION }).tools)).not.toContain("persist_after_exit");
    expect(disabled.prepareAttempt({ model: "model", promptNotes: { progress: "", modelNotes: "" }, toolPresentation: FUNCTION_TOOL_PRESENTATION }).omittedTools).toContainEqual({ name: "bash.persist_after_exit", reason: "persistent processes are disabled" });
    expect(owner.current()).toBe(disabled);

    const enabled = await owner.resolve();
    await enabled.prepareStablePrompt(() => stableSystemPrompt("prompt"), DEFAULT_MODEL_INTERACTION_PROFILE);
    expect(JSON.stringify(enabled.tools.get("bash")?.inputSchema)).toContain("persist_after_exit");
    expect(JSON.stringify(enabled.prepareAttempt({ model: "model", promptNotes: { progress: "", modelNotes: "" }, toolPresentation: FUNCTION_TOOL_PRESENTATION }).tools)).toContain("persist_after_exit");
    expect(enabled.prepareAttempt({ model: "model", promptNotes: { progress: "", modelNotes: "" }, toolPresentation: FUNCTION_TOOL_PRESENTATION }).omittedTools).toEqual([]);
  });

  test("pins one transformed stable prompt and projects each serving attempt from admitted tools", async () => {
    let builds = 0;
    let schemaSerializations = 0;
    const owner = await createRequestToolSurface(() => plan([fakeTool("read", {
      toJSON: () => {
        schemaSerializations += 1;
        return { path: { type: "string" } };
      },
    })]), fullModules, testRuntimeConfigCapture);
    const first = await owner.resolve();
    const stable = await first.prepareStablePrompt(() => {
      builds += 1;
      return stableSystemPrompt("system prompt");
    }, DEFAULT_MODEL_INTERACTION_PROFILE);

    expect(await first.prepareStablePrompt(() => stableSystemPrompt("unused"), DEFAULT_MODEL_INTERACTION_PROFILE)).toBe(stable);
    expect(builds).toBe(1);
    const prepared = first.prepareAttempt({ model: "model-a", promptNotes: { progress: "progress", modelNotes: "notes" }, toolPresentation: FUNCTION_TOOL_PRESENTATION });
    expect(schemaSerializations).toBe(1);
    expect(stable.staticContextTokens).toBe(Math.ceil(("system prompt".length + JSON.stringify(prepared.tools).length) / 4));
    expect(renderSystemPrompt(prepared.systemPrompt)).toContain("system prompt");
    expect(renderSystemPrompt(prepared.systemPrompt)).toContain("# Provider Interaction Notes\n\nprogress\n\nnotes");
    expect(prepared.tools[0]?.name).toBe("read");
    expect(prepared.attemptStaticTokens).toBe(Math.ceil((renderSystemPrompt(prepared.systemPrompt).length + JSON.stringify(prepared.tools).length) / 4));
    expect((await (await owner.resolve()).prepareStablePrompt(() => stableSystemPrompt("next"), DEFAULT_MODEL_INTERACTION_PROFILE)).systemPrompt).toEqual(stableSystemPrompt("next"));
    expect(builds).toBe(1);
  });

  test("materializes one method-bearing nested schema for stable provider and audit definitions", async () => {
    let materializations = 0;
    const nestedSchema = {
      toJSON() {
        materializations += 1;
        return {
          type: "object",
          properties: {
            query: { type: "string" },
          },
        };
      },
    };
    const owner = await createRequestToolSurface(
      () => plan([fakeTool("search", { options: nestedSchema })]),
      fullModules,
      testRuntimeConfigCapture,
    );
    const surface = await owner.resolve();
    const stable = await surface.prepareStablePrompt(() => stableSystemPrompt("prompt"), DEFAULT_MODEL_INTERACTION_PROFILE);
    const attempt = surface.prepareAttempt({
      model: "model",
      promptNotes: { progress: "", modelNotes: "" },
      toolPresentation: FUNCTION_TOOL_PRESENTATION,
    });

    expect(materializations).toBe(1);
    expect(stable.definitions).toBe(attempt.tools);
    expect(attempt.auditTools[0]?.input_schema).toBe(stable.definitions[0]?.input_schema);
    expect(stable.definitions[0]?.input_schema).toEqual({
      type: "object",
      properties: {
        options: {
          type: "object",
          properties: {
            query: { type: "string" },
          },
        },
      },
    });
    expect(() => structuredClone({ nestedSchema })).toThrow();
  });

  test("orders the schema root as an MCP tool schema, so a route that serves the tools over MCP sends the same bytes", async () => {
    const tool = fakeTool("ordered");
    tool.inputSchema = { type: "object", additionalProperties: false, required: ["a"], description: "d", properties: { a: { type: "string" } } };
    const owner = await createRequestToolSurface(() => plan([tool]), fullModules, testRuntimeConfigCapture);
    const surface = await owner.resolve();
    const stable = await surface.prepareStablePrompt(() => stableSystemPrompt("prompt"), DEFAULT_MODEL_INTERACTION_PROFILE);

    expect(JSON.stringify(stable.definitions[0]?.input_schema)).toBe('{"type":"object","properties":{"a":{"type":"string"}},"required":["a"],"additionalProperties":false,"description":"d"}');
  });

  test("rejects a cyclic tool schema with tool-scoped evidence", async () => {
    const cyclic: UnknownRecord = {};
    cyclic.self = cyclic;
    const owner = await createRequestToolSurface(() => plan([fakeTool("broken", cyclic)]), fullModules, testRuntimeConfigCapture);
    const surface = await owner.resolve();

    await expect(surface.prepareStablePrompt(() => stableSystemPrompt("prompt"), DEFAULT_MODEL_INTERACTION_PROFILE)).rejects.toThrow("Tool 'broken' input schema is not JSON-serializable");
  });

  test("rejects a tool schema that materializes to a non-object root", async () => {
    const tool = fakeTool("broken");
    tool.inputSchema = { toJSON: () => ["not", "an", "object"] };
    const owner = await createRequestToolSurface(() => plan([tool]), fullModules, testRuntimeConfigCapture);
    const surface = await owner.resolve();

    await expect(surface.prepareStablePrompt(() => stableSystemPrompt("prompt"), DEFAULT_MODEL_INTERACTION_PROFILE)).rejects.toThrow("Tool 'broken' input schema must materialize to a JSON object");
  });

  test("rejects a tool schema root without an object type, such as a bare union", async () => {
    const tool = fakeTool("broken");
    tool.inputSchema = { oneOf: [{ type: "object", properties: {} }, { type: "object", properties: {} }] };
    const owner = await createRequestToolSurface(() => plan([tool]), fullModules, testRuntimeConfigCapture);
    const surface = await owner.resolve();

    await expect(surface.prepareStablePrompt(() => stableSystemPrompt("prompt"), DEFAULT_MODEL_INTERACTION_PROFILE)).rejects.toThrow(`Tool 'broken' input schema root must declare type "object"`);
  });

  test("rejects nested values that JSON serialization would silently change", async () => {
    const unsupported: readonly [string, unknown][] = [
      ["undefined", undefined],
      ["function", () => "hidden"],
      ["symbol", Symbol("hidden")],
      ["bigint", 1n],
      ["non-finite number", Number.NaN],
      ["non-finite number", Number.POSITIVE_INFINITY],
      ["undefined", ["kept", undefined]],
    ];

    for (const [kind, value] of unsupported) {
      const owner = await createRequestToolSurface(() => plan([fakeTool("broken", { value })]), fullModules, testRuntimeConfigCapture);
      const surface = await owner.resolve();
      await expect(surface.prepareStablePrompt(() => stableSystemPrompt("prompt"), DEFAULT_MODEL_INTERACTION_PROFILE)).rejects.toThrow(`Tool 'broken' input schema contains unsupported ${kind}`);
    }
  });

  test("applies the pinned model-context transformer sequence once per request surface", async () => {
    const calls: string[] = [];
    const transformerModule = {
      id: "test-transformers",
      dependencies: [],
      availability: { kind: "available" },
      contributions: [],
      observers: [],
      transformers: [
        { seam: "modelContext", id: "second", order: 20, transformer: (value: string) => { calls.push("second"); return `${value}:second`; } },
        { seam: "modelContext", id: "first", order: 10, transformer: (value: string) => { calls.push("first"); return `${value}:first`; } },
      ],
      gates: [],
    } as const satisfies FirstPartyModule;
    const modules = () => composeFirstPartyModules([...SHIPPED_MODULES, transformerModule]);
    const owner = await createRequestToolSurface(() => plan([]), modules, testRuntimeConfigCapture);
    const pinned = await owner.resolve();
    const first = await pinned.prepareStablePrompt(() => stableSystemPrompt("prompt"), DEFAULT_MODEL_INTERACTION_PROFILE);
    const repeated = await pinned.prepareStablePrompt(() => stableSystemPrompt("unused"), DEFAULT_MODEL_INTERACTION_PROFILE);

    expect(first.systemPrompt).toEqual(stableSystemPrompt("prompt:first:second"));
    expect(repeated).toBe(first);
    expect(calls).toEqual(["first", "second"]);
    expect(first.contextApplication.applications.map(({ transformerId, seam, order, outcome }) => ({ transformerId, seam, order, outcome }))).toEqual([
      { transformerId: "first", seam: "modelContext", order: 10, outcome: "applied" },
      { transformerId: "second", seam: "modelContext", order: 20, outcome: "applied" },
    ]);
    expect(JSON.stringify(first.contextApplication.applications)).not.toContain("prompt");

    pinned.prepareAttempt({ model: "model-b", promptNotes: { progress: "", modelNotes: "" }, toolPresentation: FUNCTION_TOOL_PRESENTATION });
    expect(calls).toEqual(["first", "second"]);
  });

  test("transforms each cache tier on its own, keeps provider notes in the session tier, and accounts for the joined prompt", async () => {
    const transformerModule = {
      id: "tier-transformer",
      dependencies: [], availability: { kind: "available" }, contributions: [], observers: [], gates: [],
      transformers: [{ seam: "modelContext", id: "tag", order: 1, transformer: (value: string) => `${value}:tagged` }],
    } as const satisfies FirstPartyModule;
    const modules = () => composeFirstPartyModules([...SHIPPED_MODULES, transformerModule]);
    const owner = await createRequestToolSurface(() => plan([]), modules, testRuntimeConfigCapture);
    const pinned = await owner.resolve();
    const prepared = await pinned.prepareStablePrompt(() => ({ stable: "STABLE", session: "SESSION", conversation: "CONVERSATION" }), DEFAULT_MODEL_INTERACTION_PROFILE);

    expect(prepared.systemPrompt).toEqual({ stable: "STABLE:tagged", session: "SESSION:tagged", conversation: "CONVERSATION:tagged" });
    const applicationIds = prepared.contextApplication.applications.map(({ applicationId }) => applicationId);
    expect(applicationIds).toHaveLength(3);
    expect(new Set(applicationIds).size).toBe(3);
    expect(prepared.staticContextTokens).toBe(Math.ceil((renderSystemPrompt(prepared.systemPrompt).length + JSON.stringify(prepared.definitions).length) / 4));

    const attempt = pinned.prepareAttempt({ model: "model-b", promptNotes: { progress: "Report progress.", modelNotes: "" }, toolPresentation: FUNCTION_TOOL_PRESENTATION });
    expect(attempt.systemPrompt.stable).toBe("STABLE:tagged");
    expect(attempt.systemPrompt.session).toBe(`SESSION:tagged${SYSTEM_PROMPT_SEPARATOR}# Provider Interaction Notes\n\nReport progress.`);
    expect(attempt.systemPrompt.conversation).toBe("CONVERSATION:tagged");
  });

  test("literal prompts bypass mutating model-context transformers and retain empty application evidence", async () => {
    let calls = 0;
    const transformerModule = {
      id: "literal-transformer",
      dependencies: [], availability: { kind: "available" }, contributions: [], observers: [], gates: [],
      transformers: [{ seam: "modelContext", id: "mutator", order: 1, transformer: (value: string) => { calls += 1; return `${value}:mutated`; } }],
    } as const satisfies FirstPartyModule;
    const owner = await createRequestToolSurface(() => plan([fakeTool("bash")]), () => composeFirstPartyModules([...SHIPPED_MODULES, transformerModule]), testRuntimeConfigCapture);
    const surface = await owner.resolve();
    const literal = "literal\nbytes";
    const stable = await surface.prepareStablePrompt(() => stableSystemPrompt(literal), DEFAULT_MODEL_INTERACTION_PROFILE, true);
    const prepared = surface.prepareAttempt({ model: "model", promptNotes: { progress: "ignored", modelNotes: "ignored" }, toolPresentation: FUNCTION_TOOL_PRESENTATION });

    expect(calls).toBe(0);
    expect(stable.systemPrompt).toEqual(stableSystemPrompt(literal));
    expect(stable.contextApplication.applications).toEqual([]);
    expect(prepared.systemPrompt).toEqual(stableSystemPrompt(literal));
    expect(prepared.tools.map(({ name }) => name)).toEqual(["bash"]);
  });
});

describe("realm capability transition", () => {
  test("composes Full and Minimal as complete catalog selections", () => {
    const full = composeRealmModuleSnapshot({ moduleIds: SHIPPED_MODULES.map((module) => module.id) });
    const minimal = composeRealmModuleSnapshot({ moduleIds: [] });

    expect(full.enabledModuleIds).toEqual(["ask-user", "background-commands", "bash", "bug-reports", "code-mode", "definition-overrides", "discovery", "experiments", "file-tools", "learning", "mcp", "papercuts", "project-notifications", "provider-anthropic-api", "provider-chatgpt", "provider-claude-agent-sdk", "provider-deepseek", "provider-github-copilot", "provider-google-api", "provider-google-vertex", "provider-openai-api", "provider-opencode-go", "provider-openrouter", "provider-supergrok", "recall", "remote", "side-question", "skills", "subagents", "subscription-usage", "web", "web-chatgpt", "web-exa", "workflows"]);
    expect(minimal.enabledModuleIds).toEqual([]);
    expect(Object.isFrozen(full.enabledModuleIds)).toBe(true);
  });
});
