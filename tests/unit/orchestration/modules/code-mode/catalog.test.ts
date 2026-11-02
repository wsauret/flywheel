import { describe, expect, it } from "bun:test";
import { Effect, Schema } from "effect";
import * as Tool from "../../../../../src/infra/code-mode/tool.js";
import { ToolRuntime } from "../../../../../src/infra/code-mode/tool-runtime.js";
import { createCatalogRenderer } from "../../../../../src/orchestration/modules/code-mode/catalog.js";

const makeTool = (description: string, properties: { [name: string]: object } = {}) => Tool.make({
  description,
  input: { type: "object", properties, additionalProperties: false },
  output: Schema.String,
  execute: () => Effect.succeed("ok"),
});

describe("createCatalogRenderer", () => {
  it("renders top-level signatures and a namespace index with discovery instructions", () => {
    const catalog = createCatalogRenderer()({
      zeta: { issue: makeTool("Get issue\nwith details") },
      read: makeTool("Read a file", { path: { type: "string" } }),
      alpha: { "create-issue": makeTool("Create issue") },
    });
    expect(catalog.text).toBe(`The Code Mode index below lists available namespaces, not their individual tools.

Use \`searchCatalog({ namespace: "...", query: "..." })\` inside a Code Mode discovery call to return exact tool paths and signatures. Then use a separate Code Mode call to execute them. Tools presented elsewhere are not available in this runtime.

Search with specific keywords. To browse a namespace, omit \`query\`; use \`next.offset\` for additional pages. An exact tool path can also be used as the query.

\`searchCatalog\` is a global function. Never call it through \`tools\`.

- ${ToolRuntime.searchSignature}

## Top-level tools

tools.read(input: {
  path?: string,
}): Promise<string> // Read a file

## Namespaces

- alpha
- zeta`);
    expect(catalog.discovery.catalog.map(({ path }) => path)).toEqual(["alpha.create-issue", "read", "zeta.issue"]);
  });

  it("keeps every tool discoverable without advertising individual names or descriptions", () => {
    const render = createCatalogRenderer();
    const catalog = render({
      alpha: { nested: { expensive: makeTool("x".repeat(200)) }, cheap: makeTool("c") },
      beta: { cheap: makeTool("b") },
    });
    expect(catalog.text).toContain("## Namespaces\n\n- alpha\n- beta");
    expect(catalog.text).not.toContain("expensive");
    expect(catalog.text).not.toContain("cheap");
    expect(catalog.text).not.toContain("x".repeat(120));
    expect(catalog.discovery.catalog.map(({ path }) => path)).toEqual(["alpha.cheap", "alpha.nested.expensive", "beta.cheap"]);
    expect(catalog.discovery.searchIndex).toHaveLength(3);
  });

  it("names a declared namespace before its tools arrive, with the same text after", () => {
    const render = createCatalogRenderer();
    const connecting = render({}, ["linear"]);
    expect(connecting.text).toContain("## Namespaces\n\n- linear");
    expect(connecting.discovery.catalog).toEqual([]);
    const connected = render({ linear: { issue: makeTool("Get issue") } }, ["linear"]);
    expect(connected.text).toBe(connecting.text);
    expect(connected.discovery.catalog.map(({ path }) => path)).toEqual(["linear.issue"]);
  });

  it("renders empty namespaces without inventing tool availability", () => {
    const catalog = createCatalogRenderer()({});
    expect(catalog.text).toContain("## Namespaces\n\n(none)");
    expect(catalog.discovery.catalog).toEqual([]);
  });

  it("memoizes the complete prepared discovery including output signatures", () => {
    const render = createCatalogRenderer();
    const tools = { read: makeTool("read") };
    const first = render(tools);
    expect(render(tools)).toBe(first);

    const changedOutput = render({ read: Tool.make({
      description: "read",
      input: { type: "object", properties: {}, additionalProperties: false },
      output: Schema.Number,
      execute: () => Effect.succeed(1),
    }) });
    expect(changedOutput.fingerprint).not.toBe(first.fingerprint);
    expect(changedOutput.text).toContain("Promise<number>");

    const cycled = render(tools);
    expect(cycled).not.toBe(first);
    expect(render(tools)).toBe(cycled);
  });
});
