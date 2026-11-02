import { describe, expect, test } from "bun:test";
import { MODULE_IDS } from "../../../../src/protocol/module-ids.js";
import * as registration from "../../../../src/orchestration/headless/host-registration.js";
import type { ModulePolicy } from "../../../../src/orchestration/config/module-policy.js";
import { capabilityAccessFor } from "../../../../src/orchestration/agent-runtime/tools/types.js";

function policy(): Pick<ModulePolicy, "admit" | "state"> {
  const state = {
    capabilities: MODULE_IDS,
    moduleIds: MODULE_IDS,
    requireWorkflowConfirmation: false,
    workflowsMode: "on" as const,
    identity: "test",
  };
  return {
    state: () => state,
    admit: async (request) => ({ ok: true, grant: { ...state, ...request } }),
  };
}

describe("headless host registration", () => {
  test("the canonical list bounds live policy access", async () => {
    const access = capabilityAccessFor(policy(), undefined, registration.HEADLESS_MODULE_CEILING);
    expect(access.available("background-commands")).toBe(true);
    expect(access.available("bash")).toBe(true);
    expect(access.available("subagents")).toBe(false);
    expect(access.available("workflows")).toBe(false);
    expect(await access.admit({ operation: "a subagent launch", required: ["subagents"] })).toMatchObject({ ok: false, missing: ["subagents"] });
    expect(await access.admit({ operation: "a workflow launch", required: ["workflows"] })).toMatchObject({ ok: false, missing: ["workflows"] });
  });
});
