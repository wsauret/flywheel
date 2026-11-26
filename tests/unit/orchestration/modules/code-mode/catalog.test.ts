import { describe, expect, it } from "bun:test";
import { searchSignature } from "../../../../../src/orchestration/modules/code-mode/script/tool-catalog.js";
import { boundedStringCodeModeOutput, type RuntimeTool, type RuntimeToolInput } from "../../../../../src/orchestration/agent-runtime/tools/types.js";
import { createCatalogRenderer } from "../../../../../src/orchestration/modules/code-mode/catalog.js";
import { describeCodeModeTools } from "../../../../../src/orchestration/modules/code-mode/descriptors.js";
import { codeModeRuntimeOver } from "../../../../helpers/code-mode-worker.js";

const tool = (name: string, description: string, inputSchema: RuntimeToolInput = { type: "object", properties: {}, additionalProperties: false }): RuntimeTool => ({
  name,
  action: "shell_exec",
  description,
  inputSchema,
  codeMode: "exclusive",
  codeModeOutput: boundedStringCodeModeOutput,
  isConcurrencySafe: true,
  execute: async () => ({ content: "ok", outcome: "ok" }),
});

const eligible = (...tools: RuntimeTool[]) => new Map(tools.map((entry) => [entry.name, entry]));

/** Renders the catalog of one surface with no revision, so nothing is held. */
const render = (tools: ReadonlyMap<string, RuntimeTool>, declared: Iterable<string> = []) => createCatalogRenderer()(describeCodeModeTools(tools, undefined), declared);

/** The catalog text that the `code` tool of one request carries in its guidelines. */
function catalogOf(runtime: ReturnType<typeof codeModeRuntimeOver>, revision: string | undefined, tools: ReadonlyMap<string, RuntimeTool>, namespaces: Iterable<string> = []): string | undefined {
  return runtime.createTool({ nestedTools: true, bash: true, revision })(tools, new Set(namespaces)).tool.promptGuidelines?.[1];
}

const GOLDEN_TOOLS = eligible(
  tool("lookup", "Look things up\nsecond line", { type: "object", properties: { query: { type: "string", description: "Words" }, limit: { type: "number" } }, required: ["query"] }),
  tool("linear.issue_get", "x".repeat(200), { type: "object", properties: { id: { type: "string" } }, required: ["id"] }),
  tool("github.create-issue", "Create an issue", { type: "object", properties: { title: { type: "string" }, labels: { type: "array", items: { type: "string" } } } }),
);

/** Recorded from the build before the catalog was held per revision. */
const GOLDEN_CATALOG = `The Code Mode index below lists available namespaces, not their individual tools.

Use \`searchCatalog({ namespace: "...", query: "..." })\` inside a Code Mode discovery call to return exact tool paths and signatures. Then use a separate Code Mode call to execute them. Tools presented elsewhere are not available in this runtime.

Search with specific keywords. To browse a namespace, omit \`query\`; use \`next.offset\` for additional pages. An exact tool path can also be used as the query.

\`searchCatalog\` is a global function. Never call it through \`tools\`.

- searchCatalog(input: {
  query?: string,
  namespace?: string,
  limit?: number,
  offset?: number,
}): {
  items: Array<{
      path: string,
      description: string,
      signature: string,
    }>,
  remaining: number,
  next: {
      offset: number,
    } | null,
}

## Top-level tools

tools.lookup(input: {
  /** Words */
  query: string,
  limit?: number,
}): Promise<{
  outcome: "ok" | "error" | "interrupted",
  /** Parsed data when the tool's text output is a JSON object or array; otherwise the raw string. */
  content: unknown,
}> // Look things up

## Namespaces

- github
- linear
- slack`;

describe("createCatalogRenderer", () => {
  it("renders top-level signatures and a namespace index with discovery instructions", () => {
    const text = render(eligible(
      tool("zeta.issue", "Get issue\nwith details"),
      tool("read", "Read a file", { type: "object", properties: { path: { type: "string" } } }),
      tool("alpha.create-issue", "Create issue"),
    ));
    expect(text).toStartWith("The Code Mode index below lists available namespaces, not their individual tools.");
    expect(text).toContain(`- ${searchSignature}\n\n## Top-level tools\n\ntools.read(input: {\n  path?: string,\n}): Promise<{`);
    expect(text).toEndWith("}> // Read a file\n\n## Namespaces\n\n- alpha\n- zeta");
  });

  it("keeps every tool discoverable without advertising individual names or descriptions", () => {
    const text = render(eligible(tool("alpha.nested.expensive", "x".repeat(200)), tool("alpha.cheap", "c"), tool("beta.cheap", "b")));
    expect(text).toContain("## Namespaces\n\n- alpha\n- beta");
    expect(text).not.toContain("expensive");
    expect(text).not.toContain("cheap");
    expect(text).not.toContain("x".repeat(120));
  });

  it("names a declared namespace before its tools arrive, with the same text after", () => {
    const connecting = render(eligible(), ["linear"]);
    expect(connecting).toContain("## Namespaces\n\n- linear");
    expect(render(eligible(tool("linear.issue", "Get issue")), ["linear"])).toBe(connecting);
  });

  it("renders empty namespaces without inventing tool availability", () => {
    expect(render(eligible())).toContain("## Top-level tools\n\n(none)\n\n## Namespaces\n\n(none)");
  });

  it("The held catalog text is byte-equal to a cold preparation for the same tools, and to the golden catalog text", () => {
    const runtime = codeModeRuntimeOver();
    const cold = catalogOf(runtime, "mcp:1", GOLDEN_TOOLS, ["slack", "linear"]);
    const held = catalogOf(runtime, "mcp:1", GOLDEN_TOOLS, ["slack", "linear"]);
    expect(cold).toBe(GOLDEN_CATALOG);
    expect(held).toBe(GOLDEN_CATALOG);
    expect(catalogOf(codeModeRuntimeOver(), undefined, GOLDEN_TOOLS, ["slack", "linear"])).toBe(GOLDEN_CATALOG);
  });

  it("Ten hops at one MCP generation with 300 tools prepare the catalog once; a new generation prepares it once more", () => {
    // Preparation renders every tool's input properties into its signature and
    // search text, so the reads of one tool's properties count preparations.
    let preparedReads = 0;
    const counted = tool("server0.counted", "Counted", {
      type: "object",
      get properties() {
        preparedReads++;
        return { id: { type: "string" } };
      },
    });
    const tools = eligible(counted, ...Array.from({ length: 299 }, (_, index) => tool(`server${index % 5}.tool_${index}`, `Tool ${index}`, { type: "object", properties: { id: { type: "string" } } })));
    const runtime = codeModeRuntimeOver();
    const first = catalogOf(runtime, "mcp:1", tools);
    const perPreparation = preparedReads;
    expect(perPreparation).toBeGreaterThan(0);
    for (let hop = 2; hop <= 10; hop++) expect(catalogOf(runtime, "mcp:1", tools)).toBe(first);
    expect(preparedReads).toBe(perPreparation);
    catalogOf(runtime, "mcp:2", tools);
    expect(preparedReads).toBe(2 * perPreparation);
  });

  it("A surface without a revision renders each request's own tools", () => {
    const runtime = codeModeRuntimeOver();
    expect(catalogOf(runtime, undefined, eligible(tool("read", "Read a file")))).toContain("// Read a file");
    expect(catalogOf(runtime, undefined, eligible(tool("write", "Write a file")))).toContain("// Write a file");
  });
});
