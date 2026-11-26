import { describe, expect, it } from "bun:test";
import { Effect } from "effect";
import { boundedStringCodeModeOutput, type RuntimeTool, type RuntimeToolInput } from "../../../../../src/orchestration/agent-runtime/tools/types.js";
import { createCatalogRenderer } from "../../../../../src/orchestration/modules/code-mode/catalog.js";
import { describeCodeModeTools } from "../../../../../src/orchestration/modules/code-mode/descriptors.js";
import { makeScriptRuntime } from "../../../../../src/orchestration/modules/code-mode/script/runtime.js";

const tool = (name: string, schema: RuntimeToolInput = { type: "object" }): RuntimeTool => ({
  name,
  action: "file_read",
  description: `${name} description`,
  inputSchema: schema,
  codeMode: "exclusive",
  codeModeOutput: boundedStringCodeModeOutput,
  isConcurrencySafe: true,
  execute: async () => ({ outcome: "ok", content: "unused" }),
});

const describeTools = (...tools: RuntimeTool[]) => describeCodeModeTools(new Map(tools.map((entry) => [entry.name, entry])), undefined);

describe("describeCodeModeTools", () => {
  it("nests canonical MCP paths and keeps the exact callable tool", () => {
    const issue = tool("github.issue_get");
    const described = describeTools(issue);
    expect(described.descriptors).toEqual([{ name: "github.issue_get", path: ["github", "issue_get"], description: "github.issue_get description", inputSchema: { type: "object" } }]);
    expect(described.callable.get("github.issue_get") === issue).toBe(true);
    expect(described.omissions).toEqual([]);
  });

  it("omits the tool under a colliding root tool whichever order the eligible map holds them in", () => {
    const expected = {
      names: ["github"],
      omissions: [{ path: "tools.github.issue_get", reason: "namespace 'github' collides with a root tool" }],
    };
    for (const order of [[tool("github"), tool("github.issue_get")], [tool("github.issue_get"), tool("github")]]) {
      const described = describeTools(...order);
      expect({ names: [...described.callable.keys()], omissions: described.omissions }).toEqual(expected);
    }
  });

  it("omits unsupported paths, schemas, and transports with stable reasons", () => {
    const { codeModeOutput: _, ...withoutTransport } = tool("bare");
    const described = describeTools(tool("bad.__proto__"), tool("unsupported", { type: 7 }), withoutTransport, { ...tool("provider"), codeMode: undefined });
    expect(described.omissions).toEqual([
      { path: "tools.bad.__proto__", reason: "unsupported executable path" },
      { path: "tools.unsupported", reason: "unsupported input schema" },
      { path: "tools.bare", reason: "incomplete code-mode transport contract" },
    ]);
    expect(described.callable.size).toBe(0);
  });

  it("allows an MCP namespace named searchCatalog because the discovery global is a separate binding", async () => {
    const described = describeTools(tool("searchCatalog.remote"));
    expect(described.omissions).toEqual([]);
    const runtime = makeScriptRuntime({ descriptors: described.descriptors, call: (name) => Effect.succeed(name), maxToolCalls: 5, maxLogBytes: 1024 });
    const result = await Effect.runPromise(runtime.execute("return [Object.keys(tools), await tools.searchCatalog.remote({}), searchCatalog({}).items.map((item) => item.path)]"));
    expect(result).toEqual({ ok: true, value: [["searchCatalog"], "searchCatalog.remote", ["tools.searchCatalog.remote"]] });
  });

  it("renders the documented content signature for described tools", () => {
    const rendered = createCatalogRenderer()(describeTools(tool("read")), []);
    expect(rendered).toContain("/** Parsed data when the tool's text output is a JSON object or array; otherwise the raw string. */");
    expect(rendered).toContain("content: unknown,");
  });
});
