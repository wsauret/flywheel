import type { ToolDescription } from "../../../infra/code-mode/tool-runtime.js";
import { ToolRuntime } from "../../../infra/code-mode/tool-runtime.js";
import { catalogOnlyCall, toolTrie, type CodeModeToolSet } from "./descriptors.js";

const DESCRIPTION_LIMIT = 120;

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

function renderCatalog({ descriptors }: CodeModeToolSet, declared: Iterable<string>): string {
  const { catalog } = ToolRuntime.prepare(toolTrie(descriptors, catalogOnlyCall));
  const namespaces = [...new Set([
    ...declared,
    ...catalog.flatMap((item) => item.path.includes(".") ? [item.path.slice(0, item.path.indexOf("."))] : []),
  ])].toSorted((left, right) => left.localeCompare(right));
  const topLevel = catalog.filter((item) => !item.path.includes(".")).map(fullCatalogLine);
  const namespaceLines = namespaces.map((name) => `- ${name}`);
  return `${CATALOG_PROMPT}

## Top-level tools

${topLevel.length === 0 ? "(none)" : topLevel.join("\n")}

## Namespaces

${namespaceLines.length === 0 ? "(none)" : namespaceLines.join("\n")}`;
}

/** The catalog text of one runner's script surfaces. It holds the text of the
 *  last revision it rendered, so every request at that revision reuses it and
 *  prepares no signature again; a surface with no revision is rendered on each
 *  request. The index names each namespace with no tool count: a declared
 *  namespace whose tools have not arrived yet reads the same as after they
 *  arrive, so a server that connects after the first request leaves the
 *  system prompt unchanged. */
export function createCatalogRenderer(): (tools: CodeModeToolSet, declared: Iterable<string>) => string {
  let held: { readonly revision: string; readonly text: string } | undefined;
  return (tools, declared) => {
    if (tools.revision !== undefined && held?.revision === tools.revision) return held.text;
    const text = renderCatalog(tools, declared);
    if (tools.revision !== undefined) held = { revision: tools.revision, text };
    return text;
  };
}
