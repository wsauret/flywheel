// Fixtures copied from the base revision's tests/helpers/request-tool-surface.ts
// and tests/unit/orchestration/agent-runtime/_model-client.ts, so that the
// acceptance tests do not depend on test files a solver may edit.
import { createRequestToolSurface, type RequestToolSurfaceOwner } from "../src/orchestration/agent-runtime/request-tool-surface.js";
import type { RuntimeTool } from "../src/orchestration/agent-runtime/tools/types.js";
import { composeFirstPartyModules } from "../src/orchestration/modules.js";
import { CONFIG_DEFAULTS } from "../src/orchestration/config/schema.js";
import { captureRuntimeConfigRequest, type CaptureRuntimeConfig } from "../src/orchestration/agent-runtime/request-config.js";
import {
  FUNCTION_TOOL_PRESENTATION,
  type LLMClient,
  type ModelClient,
  type StreamOptions,
} from "../src/orchestration/agent-runtime/llm/types.js";

const testCapabilityModules = () => composeFirstPartyModules();
const testRuntimeConfigCapture: CaptureRuntimeConfig = () => captureRuntimeConfigRequest({
  revision: 0,
  config: CONFIG_DEFAULTS,
  warnings: [],
  diagnostics: [],
  sourceIdentity: "test",
  status: { kind: "valid" },
}, "default");

async function fixedRequestToolSurface(tools: ReadonlyMap<string, RuntimeTool>): Promise<RequestToolSurfaceOwner> {
  const surface = await createRequestToolSurface(() => ({
    eligibleTools: tools,
    tools,
    omitted: [],
    registrationIds: new Map([...tools].map(([name, tool]) => [tool.name, name])),
    registrationIdentities: new Map([...tools].map(([name, tool]) => [tool.name, name])),
  }), () => null, testCapabilityModules, testRuntimeConfigCapture);
  return {
    async resolve() {
      const resolved = await surface.resolve();
      return { ...resolved, executionAdmission: (toolName) => tools.has(toolName) ? { ok: true } : resolved.executionAdmission(toolName) };
    },
    current() {
      const current = surface.current();
      return { ...current, executionAdmission: (toolName) => tools.has(toolName) ? { ok: true } : current.executionAdmission(toolName) };
    },
  };
}

export class RequestToolMap extends Map<string, RuntimeTool> {
  private readonly surface = fixedRequestToolSurface(this);
  private currentSurface: RequestToolSurfaceOwner | undefined;

  async resolve(): ReturnType<RequestToolSurfaceOwner["resolve"]> {
    const owner = await this.surface;
    this.currentSurface = owner;
    const surface = await owner.resolve();
    return { ...surface, executionAdmission: (toolName) => this.has(toolName)
      ? { ok: true }
      : surface.executionAdmission(toolName) };
  }

  current(): ReturnType<RequestToolSurfaceOwner["current"]> {
    if (this.currentSurface === undefined) throw new Error("RequestToolMap must resolve before reading its current surface");
    const surface = this.currentSurface.current();
    return { ...surface, executionAdmission: (toolName) => this.has(toolName)
      ? { ok: true }
      : surface.executionAdmission(toolName) };
  }
}

function withRequestAdmission(client: Omit<ModelClient, "admitRequest"> & Pick<LLMClient, "streamWithTools">): ModelClient {
  const modelClient: ModelClient = {
    model: client.model,
    modelFamily: client.modelFamily,
    plannedAttempt: client.plannedAttempt,
    async admitRequest() {
      return {
        candidateAttributions: [],
        run: async ({ execute, prepare, providerOptions }) => {
          const attempt = await modelClient.plannedAttempt(providerOptions);
          const prepared = await prepare(attempt);
          const result = await execute({
            attempt: prepared.attempt,
            client: { ...prepared.attempt, streamWithTools: client.streamWithTools },
            prepared,
          });
          if (result.kind === "provider_failure") {
            throw result.failure;
          }
          return result.value;
        },
        plannedAttempt: (providerOptions) => modelClient.plannedAttempt(providerOptions),
      };
    },
  };
  return modelClient;
}

export function asModelClient(
  client: Omit<LLMClient, "toolPresentation"> & { readonly toolPresentation?: LLMClient["toolPresentation"] },
): ModelClient {
  const attempt: LLMClient = { ...client, toolPresentation: client.toolPresentation ?? FUNCTION_TOOL_PRESENTATION };
  return withRequestAdmission({
    model: client.model,
    modelFamily: client.modelFamily,
    plannedAttempt: async () => attempt,
    streamWithTools: (options: StreamOptions) => client.streamWithTools(options),
  });
}
