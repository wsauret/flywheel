import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { importChain } from "../../helpers/import-graph.js";

const REPO_ROOT = resolve(import.meta.dir, "../../..");

/** The entries whose static imports load before chat input is ready: the account service and the project
 *  executor. Each process parses and runs every module its entry reaches through static imports. */
const READINESS_ENTRIES = ["src/cli/serve.ts", "src/orchestration/app-service/project-executor-main.ts"] as const;

/** Modules that serve no part of readiness. A provider's SDK and its adapter load when the provider opens its
 *  first connection, the Agent SDK bridge loads when the Claude engine is first built, and the MCP SDK loads when
 *  the first MCP server connects. */
const DEFERRED_PACKAGES: ReadonlySet<string> = new Set([
  "@anthropic-ai/claude-agent-sdk", "@anthropic-ai/sdk", "openai", "@google/genai", "@modelcontextprotocol/sdk",
]);
const DEFERRED_FILES: ReadonlySet<string> = new Set([
  resolve(REPO_ROOT, "src/orchestration/modules/provider-claude-agent-sdk/bridge.ts"),
  resolve(REPO_ROOT, "src/orchestration/modules/provider-claude-agent-sdk/client.ts"),
]);

describe("the readiness entries", () => {
  for (const entry of READINESS_ENTRIES) {
    test(`${entry} loads no model provider SDK, Agent SDK bridge, or MCP SDK before it first needs one`, () => {
      const chain = importChain(resolve(REPO_ROOT, entry), "evaluated", (module) => module.kind === "package"
        ? DEFERRED_PACKAGES.has(module.name)
        : DEFERRED_FILES.has(module.path));
      expect(chain?.map((step) => step.replace(`${REPO_ROOT}/`, ""))).toBeUndefined();
    });
  }
});

/** The auth actions a client loads on its first `/auth` action. A login needs the provider definitions only, so
 *  the actions read the credential provider registry and never the module registry, a file tool, or a tool of
 *  the agent runtime. */
const AUTH_ACTIONS = "src/orchestration/auth/auth-actions.ts";
const MODULE_REGISTRY = resolve(REPO_ROOT, "src/orchestration/modules.ts");
const TOOL_HOMES = [resolve(REPO_ROOT, "src/orchestration/agent-runtime/tools/"), resolve(REPO_ROOT, "src/orchestration/modules/file-tools.ts")];

describe("the auth actions", () => {
  test(`${AUTH_ACTIONS} loads no module registry, file tool, or agent runtime tool`, () => {
    const chain = importChain(resolve(REPO_ROOT, AUTH_ACTIONS), "evaluated", (module) => module.kind === "file"
      && (module.path === MODULE_REGISTRY || TOOL_HOMES.some((home) => module.path.startsWith(home))));
    expect(chain?.map((step) => step.replace(`${REPO_ROOT}/`, ""))).toBeUndefined();
  });
});
