import * as path from "node:path";
import { bypassesLazyTuiViewRegistry, isLazyTuiViewRegistryTarget } from "./lazy-tui-view-boundary.js";
import { scanSourceImports, type SourceImport } from "./source-imports.js";

type ModuleName = "cli" | "protocol" | "workflows" | "orchestration" | "tui" | "infra";
type ImportRef = SourceImport;

interface BoundaryRule {
  id: string;
  description: string;
  matches(importRef: ImportRef): boolean;
}

const repoRoot = path.resolve(import.meta.dir, "..");
const temporaryAllowlist = new Set<string>();
const registeredLazyTuiViewTargets = new Set<string>();

const rules: BoundaryRule[] = [
  {
    id: "cli-is-top",
    description: "No module may import from cli/ — it is the composition root.",
    matches(importRef): boolean {
      if (isUnder(importRef.sourcePath, "src/cli/")) return false;
      return isModulePath(importRef.targetPath, "cli");
    },
  },
  {
    id: "infra-purity",
    description: "infra/ imports nothing from other modules (type-only imports are allowed).",
    matches(importRef): boolean {
      if (!isUnder(importRef.sourcePath, "src/infra/")) return false;
      if (importRef.isTypeOnly) return false;
      return ["protocol", "workflows", "orchestration", "tui"].some(isForbiddenInfraImport.bind(undefined, importRef.targetPath));
    },
  },
  {
    id: "protocol-imports-infra-only",
    description: "protocol/ is the published client contract: it may only import from infra/ (never workflows/, orchestration/, or tui/).",
    matches(importRef): boolean {
      if (!isUnder(importRef.sourcePath, "src/protocol/")) return false;
      return isModulePath(importRef.targetPath, "workflows") ||
        isModulePath(importRef.targetPath, "orchestration") ||
        isModulePath(importRef.targetPath, "tui");
    },
  },
  {
    id: "workflows-imports-infra-only",
    description: "workflows/ may only import from infra/ and protocol/ (never orchestration/ or tui/).",
    matches(importRef): boolean {
      if (!isUnder(importRef.sourcePath, "src/workflows/")) return false;
      if (!isModulePath(importRef.targetPath, "orchestration") &&
          !isModulePath(importRef.targetPath, "tui")) return false;
      return !isTemporarilyAllowed(importRef);
    },
  },
  {
    id: "orchestration-imports-workflows-infra",
    description: "orchestration/ may import from workflows/, protocol/, and infra/, never tui/.",
    matches(importRef): boolean {
      if (!isUnder(importRef.sourcePath, "src/orchestration/")) return false;
      if (!isModulePath(importRef.targetPath, "tui")) return false;
      return !isTemporarilyAllowed(importRef);
    },
  },
  {
    id: "solid-is-tui-only",
    description: "Inside src/, solid-js imports belong only in tui/. The VS Code webview renders with Solid and is outside this rule.",
    matches(importRef): boolean {
      if (!isUnder(importRef.sourcePath, "src/")) return false;
      if (isUnder(importRef.sourcePath, "src/tui/")) return false;
      return importRef.specifier === "solid-js" || importRef.specifier.startsWith("solid-js/");
    },
  },
  {
    id: "vscode-consumes-protocol-only",
    description: "vscode/ compiles against the published client contract: an import that reaches into src/ must target src/protocol/.",
    matches(importRef): boolean {
      if (!isUnder(importRef.sourcePath, "vscode/")) return false;
      if (!isUnder(importRef.targetPath, "src/")) return false;
      return !isModulePath(importRef.targetPath, "protocol");
    },
  },
  {
    id: "webview-consumes-protocol-only",
    description: "webview/ is the web client every host mounts: an import that reaches into src/ must target src/protocol/.",
    matches(importRef): boolean {
      if (!isUnder(importRef.sourcePath, "webview/")) return false;
      if (!isUnder(importRef.targetPath, "src/")) return false;
      return !isModulePath(importRef.targetPath, "protocol");
    },
  },
  {
    id: "webview-is-host-agnostic",
    description: "webview/ never imports a host: no vscode module and nothing under vscode/ or relay/.",
    matches(importRef): boolean {
      if (!isUnder(importRef.sourcePath, "webview/")) return false;
      return importRef.specifier === "vscode" || isUnder(importRef.targetPath, "vscode/") || isUnder(importRef.targetPath, "relay/");
    },
  },
  {
    id: "relay-consumes-protocol-only",
    description: "relay/ is a Bun-free consumer of the published client contract: an import that reaches into src/ must target src/protocol/.",
    matches(importRef): boolean {
      if (!isUnder(importRef.sourcePath, "relay/")) return false;
      if (!isUnder(importRef.targetPath, "src/")) return false;
      return !isModulePath(importRef.targetPath, "protocol");
    },
  },
  {
    id: "mcp-sdk-is-quarantined",
    description: "@modelcontextprotocol/sdk imports belong only in the MCP module home, its shared owned transport, the source-only iOS simulator owner, and the Agent SDK bridge's tool gate.",
    matches(importRef): boolean {
      if (isUnder(importRef.sourcePath, "src/orchestration/modules/mcp/")) return false;
      if (importRef.sourcePath === "src/orchestration/agent-runtime/mcp-stdio-client-transport.ts") return false;
      if (importRef.sourcePath === "src/orchestration/modules/development/ios-simulator-backend.ts") return false;
      if (importRef.sourcePath === "src/orchestration/modules/provider-claude-agent-sdk/tool-gate.ts") return false;
      return importRef.specifier === "@modelcontextprotocol/sdk" || importRef.specifier.startsWith("@modelcontextprotocol/sdk/");
    },
  },
  {
    id: "agent-sdk-values-are-quarantined",
    description: "Only the Agent SDK bridge's query launcher imports a value from @anthropic-ai/claude-agent-sdk (bridge rule 10). lint:owned-processes cannot see a launch inside the SDK package, and the launcher always passes the owned spawn seam; other files import its types only.",
    matches(importRef): boolean {
      if (importRef.isTypeOnly) return false;
      if (importRef.sourcePath === "src/orchestration/modules/provider-claude-agent-sdk/query-launcher.ts") return false;
      return importRef.specifier === "@anthropic-ai/claude-agent-sdk" || importRef.specifier.startsWith("@anthropic-ai/claude-agent-sdk/");
    },
  },
  {
    id: "orchestration-no-jsx",
    description: "orchestration/ contains no .tsx files.",
    matches(importRef): boolean {
      return isUnder(importRef.sourcePath, "src/orchestration/") && importRef.sourcePath.endsWith(".tsx");
    },
  },
  {
    id: "tui-imports-orchestration-or-infra",
    description: "tui/ may import from orchestration/, protocol/, and infra/, never workflows/ directly.",
    matches(importRef): boolean {
      if (!isUnder(importRef.sourcePath, "src/tui/")) return false;
      return isModulePath(importRef.targetPath, "workflows");
    },
  },
  {
    id: "lazy-tui-views-use-registry",
    description: "Deferred TUI modal and component imports must use the canonical lazy-view registry.",
    matches(importRef): boolean {
      return bypassesLazyTuiViewRegistry(importRef, registeredLazyTuiViewTargets);
    },
  },
];

function isModulePath(relPath: string, moduleName: ModuleName): boolean {
  switch (moduleName) {
    case "cli":
      return isUnder(relPath, "src/cli/");
    case "protocol":
      return isUnder(relPath, "src/protocol/");
    case "workflows":
      return isUnder(relPath, "src/workflows/");
    case "orchestration":
      return isUnder(relPath, "src/orchestration/");
    case "tui":
      return isUnder(relPath, "src/tui/");
    case "infra":
      return isUnder(relPath, "src/infra/");
  }
}

function isForbiddenInfraImport(targetPath: string, moduleName: string): boolean {
  return moduleName === "protocol" || moduleName === "workflows" || moduleName === "orchestration" || moduleName === "tui"
    ? isModulePath(targetPath, moduleName)
    : false;
}

function isUnder(relPath: string, prefix: string): boolean {
  return relPath === prefix.slice(0, -1) || relPath.startsWith(prefix);
}

function makeImportKey(importRef: ImportRef): string {
  return `${importRef.sourcePath} -> ${importRef.targetPath}`;
}

function isTemporarilyAllowed(importRef: ImportRef): boolean {
  return temporaryAllowlist.has(makeImportKey(importRef));
}

function main(): void {
  const { files, imports } = scanSourceImports(repoRoot, ["src", "vscode", "webview", "relay"]);

  for (const importRef of imports) {
    if (isLazyTuiViewRegistryTarget(importRef)) registeredLazyTuiViewTargets.add(importRef.targetPath);
  }

  const violations: string[] = [];
  const seenTemporaryAllowances = new Set<string>();

  for (const importRef of imports) {
    if (isTemporarilyAllowed(importRef)) {
      seenTemporaryAllowances.add(makeImportKey(importRef));
    }

    for (const rule of rules) {
      if (!rule.matches(importRef)) continue;
      violations.push(
        [
          `${importRef.sourcePath}:${importRef.line}`,
          `  rule: ${rule.id}`,
          `  why: ${rule.description}`,
          `  import: ${importRef.specifier}`,
          `  resolved: ${importRef.targetPath}`,
        ].join("\n"),
      );
    }
  }

  const unusedAllowances = [...temporaryAllowlist].filter((key) => !seenTemporaryAllowances.has(key));

  if (violations.length > 0) {
    console.error("Boundary check failed.\n");
    for (const violation of violations) {
      console.error(violation);
      console.error("");
    }
    process.exit(1);
  }

  console.log(`Boundary check passed. Scanned ${files.length} files.`);

  if (seenTemporaryAllowances.size > 0) {
    console.log("\nTemporary exceptions still in use:");
    for (const key of [...seenTemporaryAllowances].sort()) {
      console.log(`- ${key}`);
    }
  }

  if (unusedAllowances.length > 0) {
    console.log("\nTemporary exceptions no longer in use:");
    for (const key of unusedAllowances.sort()) {
      console.log(`- ${key}`);
    }
  }
}

main();
