import { describe, expect, it } from "bun:test";
import { composeModuleRuntimes, NO_MODULE_RUNTIMES } from "../../../../../src/infra/module-runtime.js";
import { createRequestToolSurface } from "../../../../../src/orchestration/agent-runtime/request-tool-surface.js";
import { createNestedToolDispatchBatch } from "../../../../../src/orchestration/agent-runtime/tools/nested-tool-dispatch.js";
import { createToolConcurrencyGate } from "../../../../../src/orchestration/agent-runtime/tools/tool-concurrency-gate.js";
import { planToolExposure } from "../../../../../src/orchestration/agent-runtime/tools/tool-exposure-planner.js";
import type { ToolContext } from "../../../../../src/orchestration/agent-runtime/tools/types.js";
import type { McpToolHit } from "../../../../../src/orchestration/modules/mcp/connection.js";
import type { McpPorts } from "../../../../../src/orchestration/modules/mcp/manager.js";
import { codeModeRuntimeOver, codeModeServices } from "../../../../helpers/code-mode-worker.js";
import { mcpRuntimeOver } from "../../../../helpers/mcp.js";
import { testCapabilityModules, testKernelToolDeps, testRuntimeConfigCapture } from "../../../../helpers/request-tool-surface.js";

const codeModeService = codeModeServices();
const hit: McpToolHit = { server: "work", name: "lookup", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } };

/** Ports whose server is in one state: ready answers the call, the others refuse the way the manager does. */
function ports(state: "ready" | "needs_auth" | "failed" = "ready"): McpPorts {
  return {
    servers: () => [hit.server],
    tools: () => [hit],
    call: async ({ signal, onProgress }) => {
      if (state === "needs_auth") throw new Error("MCP server 'work' needs authentication; ask the user to run /mcp and reauthenticate it");
      if (state === "failed") throw new Error("MCP server 'work' failed; ask the user to run /mcp and inspect it");
      expect(signal).toBeDefined();
      onProgress?.({ progress: 1, total: 2, message: "working" });
      return { content: [{ type: "text", text: "mcp-result" }], isError: false };
    },
  };
}

function plan(mcp: McpPorts | undefined) {
  return planToolExposure({
    kernel: testKernelToolDeps({ userDataRoot: process.cwd() }),
    modules: mcp ? composeModuleRuntimes([["mcp", mcpRuntimeOver(mcp)], ["code-mode", codeModeRuntimeOver(codeModeService())]]) : NO_MODULE_RUNTIMES,
  });
}

async function execute(mcp: McpPorts) {
  const planned = await plan(mcp);
  const code = planned.tools.get("code");
  if (code === undefined) throw new Error("missing code tool");
  // The real per-request admission path: MCP tools must be admitted through
  // their registration identity, not an injected stub.
  const owner = await createRequestToolSurface(() => planned, testCapabilityModules, testRuntimeConfigCapture);
  const surface = await owner.resolve();
  const output: string[] = [];
  const context: ToolContext = {
    executionCwd: process.cwd(), userDataRoot: "/scratch/test-account", projectRoot: process.cwd(), artifactScopeId: "session", sessionId: "session", toolUseId: "outer",
    retrievalSessionId: "session",
    onExecutionOutput: (value) => output.push(value),
  };
  context.createNestedToolDispatchBatch = (options) => createNestedToolDispatchBatch({
    ...options, context, gate: createToolConcurrencyGate(10),
    executionAdmission: surface.executionAdmission,
    publisher: { input: () => {}, validation: () => {}, output: (_call, value) => output.push(value), result: () => {} },
  });
  const discovery = await code.execute({ source: 'return searchCatalog({ namespace: "work", query: "lookup" })' }, context);
  const discovered: { items: { path: string; signature: string }[] } = JSON.parse(String(discovery.content));
  expect(discovered.items).toHaveLength(1);
  expect(discovered.items[0]?.signature).toContain("tools.work.lookup");
  const result = await code.execute({ source: `return await ${discovered.items[0]?.path}({})` }, context);
  return { plan: planned, result, output };
}

describe("code namespaced MCP", () => {
  it("discovers an unadvertised MCP tool before executing it in a separate Code Mode call", async () => {
    const { plan: planned, result, output } = await execute(ports());
    expect(planned.tools.has("work.lookup")).toBe(false);
    expect(planned.tools.has("code")).toBe(true);
    expect(planned.registrationIdentities.get("work.lookup")).toBe("code");
    expect(planned.eligibleTools.get("work.lookup")?.isConcurrencySafe).toBe(true);
    expect(planned.tools.get("code")?.promptGuidelines?.join("\n")).toContain("## Namespaces\n\n- work");
    expect(planned.tools.get("code")?.promptGuidelines?.join("\n")).not.toContain("tools.work.lookup");
    expect(JSON.parse(String(result.content))).toEqual({ outcome: "ok", content: "mcp-result" });
    expect(output).toContain("1/2 working");
  });

  it("exposes server tools only while the MCP runtime is present", async () => {
    expect((await plan(undefined)).eligibleTools.has("work.lookup")).toBe(false);
    expect((await plan(ports())).eligibleTools.has("work.lookup")).toBe(true);
  });

  it("treats MCP tools as concurrency-safe regardless of read-only annotations", async () => {
    const readOnlyFalse = mcpRuntimeOver({ ...ports(), tools: () => [{ ...hit, annotations: { readOnlyHint: false } }] });
    const planned = await planToolExposure({ kernel: testKernelToolDeps({ userDataRoot: process.cwd() }), modules: composeModuleRuntimes([["mcp", readOnlyFalse], ["code-mode", codeModeRuntimeOver(codeModeService())]]) });
    expect(planned.eligibleTools.get("work.lookup")?.isConcurrencySafe).toBe(true);
  });

  it("returns stable authentication and failed-server values without credentials", async () => {
    const auth = await execute(ports("needs_auth"));
    expect(String(auth.result.content)).toContain("needs authentication");
    const failed = await execute(ports("failed"));
    expect(String(failed.result.content)).toContain("failed");
    expect(String(failed.result.content)).not.toContain("secret credential");
  });
});
