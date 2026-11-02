import { createHash } from "node:crypto";
import type { ToolDescription, DiscoveryPlan } from "../../../infra/code-mode/tool-runtime.js";
import { ToolRuntime } from "../../../infra/code-mode/tool-runtime.js";
import type { Tools } from "../../../infra/code-mode/tools.js";

const DESCRIPTION_LIMIT = 120;

export interface CatalogRender {
  readonly fingerprint: string;
  readonly text: string;
  readonly discovery: DiscoveryPlan;
}

function fingerprint(discovery: DiscoveryPlan, namespaces: readonly string[]): string {
  return createHash("sha256").update(JSON.stringify([discovery, namespaces])).digest("hex");
}

function firstLine(description: string): string {
  const line = description.split("\n", 1)[0]?.trim() ?? "";
  return line.length > DESCRIPTION_LIMIT ? `${line.slice(0, DESCRIPTION_LIMIT - 3)}...` : line;
}

function fullCatalogLine(item: ToolDescription): string {
  const description = firstLine(item.description);
  return `${item.signature}${description.length === 0 ? "" : ` // ${description}`}`;
}

const CATALOG_PROMPT = `The Code Mode index below lists available namespaces, not their individual tools.

Use \`searchCatalog({ namespace: "...", query: "..." })\` inside a Code Mode discovery call to return exact tool paths and signatures. Then use a separate Code Mode call to execute them. Tools presented elsewhere are not available in this runtime.

Search with specific keywords. To browse a namespace, omit \`query\`; use \`next.offset\` for additional pages. An exact tool path can also be used as the query.

\`searchCatalog\` is a global function. Never call it through \`tools\`.

- ${ToolRuntime.searchSignature}`;

/** A one-entry catalog memo. Each runner's module runtime owns one, so a new
 *  fingerprint replaces only that runner's entry. The index names each
 *  namespace with no tool count: a declared namespace whose tools have not
 *  arrived yet reads the same as after they arrive, so a server that
 *  connects after the first request leaves the system prompt unchanged. */
export function createCatalogRenderer(): (tools: Tools, declared?: Iterable<string>) => CatalogRender {
  let memo: CatalogRender | undefined;
  return (tools, declared = []) => {
    const discovery = ToolRuntime.prepare(tools);
    const namespaces = [...new Set([
      ...declared,
      ...discovery.catalog.flatMap((item) => item.path.includes(".") ? [item.path.slice(0, item.path.indexOf("."))] : []),
    ])].toSorted((left, right) => left.localeCompare(right));
    const key = fingerprint(discovery, namespaces);
    if (memo?.fingerprint === key) return memo;
    const topLevel = discovery.catalog.filter((item) => !item.path.includes(".")).map(fullCatalogLine);
    const namespaceLines = namespaces.map((name) => `- ${name}`);
    const text = `${CATALOG_PROMPT}

## Top-level tools

${topLevel.length === 0 ? "(none)" : topLevel.join("\n")}

## Namespaces

${namespaceLines.length === 0 ? "(none)" : namespaceLines.join("\n")}`;
    memo = { fingerprint: key, text, discovery };
    return memo;
  };
}
