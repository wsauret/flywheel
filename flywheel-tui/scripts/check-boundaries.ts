import * as fs from "node:fs";
import * as path from "node:path";

type ModuleName = "harness" | "workflows" | "orchestration" | "tui" | "protocol";

interface ImportRef {
  sourcePath: string;
  targetPath: string;
  specifier: string;
  line: number;
}

interface BoundaryRule {
  id: string;
  description: string;
  matches(importRef: ImportRef): boolean;
}

const repoRoot = path.resolve(import.meta.dir, "..");
const srcRoot = path.join(repoRoot, "src");
const temporaryAllowlist = new Set<string>([
  // orchestration-no-tui: legitimate coupling to be unwound later
  "src/orchestration/workflow-session.ts -> src/tui/adapters/opentui.ts",
  "src/orchestration/workflow-session.ts -> src/tui/routes/work/context/ui-state/store.ts",
  "src/orchestration/workflow-session.ts -> src/tui/shared/services/timer.ts",
  "src/orchestration/workflow-session.ts -> src/tui/routes/work/context/ui-state/types.ts",
  "src/orchestration/workflow-runner.ts -> src/tui/adapters/opentui.ts",
  "src/orchestration/workflow-runner.ts -> src/tui/routes/work/context/ui-state/store.ts",
  "src/orchestration/workflow-runner.ts -> src/tui/types.ts",
  "src/orchestration/session-actions.ts -> src/tui/types.ts",
  "src/orchestration/session-registry.ts -> src/tui/types.ts",

  // tui-no-direct-domain: legacy tui -> domain imports to be routed through orchestration
  // src/tui/app.tsx
  "src/tui/app.tsx -> src/session/manager.ts",
  // src/tui/components/
  "src/tui/components/flywheel-shell.tsx -> src/engines/workflow-deps.ts",
  "src/tui/components/flywheel-shell.tsx -> src/queue/executor.ts",
  "src/tui/components/flywheel-shell.tsx -> src/queue/persistence.ts",
  "src/tui/components/flywheel-shell.tsx -> src/queue/question-service.ts",
  "src/tui/components/flywheel-shell.tsx -> src/queue/shared/plan-import.ts",
  "src/tui/components/flywheel-shell.tsx -> src/queue/steps/plan-consolidate/hooks.ts",
  "src/tui/components/flywheel-shell.tsx -> src/queue/types.ts",
  "src/tui/components/flywheel-shell.tsx -> src/session/budget-tracker.ts",
  "src/tui/components/flywheel-shell.tsx -> src/session/output-persistence.ts",
  "src/tui/components/flywheel-shell.tsx -> src/session/output-schemas.ts",
  "src/tui/components/flywheel-shell.tsx -> src/session/persistence.ts",
  "src/tui/components/flywheel-shell.tsx -> src/session/state-machine.ts",
  "src/tui/components/flywheel-shell.tsx -> src/session/transcript.ts",
  "src/tui/components/plan-confirmation-logic.ts -> src/queue/shared/plan-import.ts",
  "src/tui/components/plan-confirmation-logic.ts -> src/queue/shared/plan-parser.ts",
  "src/tui/components/plan-confirmation.tsx -> src/queue/shared/plan-import.ts",
  "src/tui/components/prompt-placeholders.ts -> src/session/state-machine.ts",
  "src/tui/components/question-prompt-logic.ts -> src/queue/question-service.ts",
  "src/tui/components/question-prompt.tsx -> src/queue/question-service.ts",
  "src/tui/components/session-header-logic.ts -> src/session/manager.ts",
  "src/tui/components/session-header-logic.ts -> src/session/state-machine.ts",
  "src/tui/components/session-sidebar.tsx -> src/session/manager.ts",
  "src/tui/components/unified-prompt.tsx -> src/session/state-machine.ts",
  // src/tui/minimal/
  "src/tui/minimal/chat.ts -> src/engines/core/registry.ts",
  "src/tui/minimal/chat.ts -> src/engines/workflow-deps.ts",
  "src/tui/minimal/chat.ts -> src/session/budget-tracker.ts",
  "src/tui/minimal/session-modal.tsx -> src/session/manager.ts",
  "src/tui/minimal/session-modal.tsx -> src/session/state-machine.ts",
  "src/tui/minimal/shell.tsx -> src/engines/workflow-deps.ts",
  "src/tui/minimal/shell.tsx -> src/session/safe-transition.ts",
  // src/tui/session/
  "src/tui/session/queue-completion.ts -> src/queue/types.ts",
  "src/tui/session/queue-completion.ts -> src/session/safe-transition.ts",
  "src/tui/session/queue-completion.ts -> src/session/state-machine.ts",
  "src/tui/session/session-runtime.ts -> src/queue/executor.ts",
  "src/tui/session/session-runtime.ts -> src/queue/types.ts",
  "src/tui/session/session-runtime.ts -> src/session/budget-tracker.ts",
  "src/tui/session/session-runtime.ts -> src/session/output-persistence.ts",
  "src/tui/session/session-viewport.ts -> src/session/output-schemas.ts",
  "src/tui/session/sidebar-logic.ts -> src/session/manager.ts",
  "src/tui/session/sidebar-logic.ts -> src/session/state-machine.ts",
  "src/tui/session/test-step.ts -> src/queue/queue.ts",
  "src/tui/session/test-step.ts -> src/queue/types.ts",
  // src/tui/shared/
  "src/tui/shared/context/session.tsx -> src/session/manager.ts",
  "src/tui/shared/context/session.tsx -> src/session/worktree-manager.ts",
  // src/tui/shell/
  "src/tui/shell/action-dispatcher.ts -> src/queue/types.ts",
  "src/tui/shell/command-handlers.ts -> src/engines/workflow-deps.ts",
  "src/tui/shell/command-handlers.ts -> src/queue/question-service.ts",
  "src/tui/shell/command-handlers.ts -> src/queue/types.ts",
  "src/tui/shell/interrupt-controller.ts -> src/engines/workflow-deps.ts",
  "src/tui/shell/interrupt-controller.ts -> src/queue/executor.ts",
  "src/tui/shell/interrupt-controller.ts -> src/queue/types.ts",
  "src/tui/shell/keyboard-controller.ts -> src/queue/question-service.ts",
  "src/tui/shell/keyboard-controller.ts -> src/session/manager.ts",
  "src/tui/shell/prompt-handler.ts -> src/engines/workflow-deps.ts",
  "src/tui/shell/queue-event-wiring.ts -> src/queue/types.ts",
  "src/tui/shell/queue-event-wiring.ts -> src/session/output-persistence.ts",
  "src/tui/shell/queue-execution-runner.ts -> src/engines/workflow-deps.ts",
  "src/tui/shell/queue-execution-runner.ts -> src/queue/context-accumulator.ts",
  "src/tui/shell/queue-execution-runner.ts -> src/queue/executor.ts",
  "src/tui/shell/queue-execution-runner.ts -> src/queue/guardrails.ts",
  "src/tui/shell/queue-execution-runner.ts -> src/queue/persistence.ts",
  "src/tui/shell/queue-execution-runner.ts -> src/queue/question-service.ts",
  "src/tui/shell/queue-execution-runner.ts -> src/queue/steps/plan-consolidate/hooks.ts",
  "src/tui/shell/queue-execution-runner.ts -> src/queue/steps/sprint-work/evaluator.ts",
  "src/tui/shell/queue-execution-runner.ts -> src/queue/types.ts",
  "src/tui/shell/queue-execution-runner.ts -> src/session/budget-tracker.ts",
  "src/tui/shell/queue-execution-runner.ts -> src/session/output-persistence.ts",
  "src/tui/shell/queue-execution-runner.ts -> src/session/persistence.ts",
  "src/tui/shell/queue-execution-runner.ts -> src/session/safe-transition.ts",
  "src/tui/shell/session-lifecycle-runner.ts -> src/queue/question-service.ts",
  "src/tui/shell/session-lifecycle-runner.ts -> src/session/budget-tracker.ts",
  "src/tui/shell/session-lifecycle-runner.ts -> src/session/output-persistence.ts",
  "src/tui/shell/session-lifecycle-runner.ts -> src/session/output-schemas.ts",
  "src/tui/shell/session-lifecycle-runner.ts -> src/session/transcript.ts",
  "src/tui/shell/session-navigation.ts -> src/engines/workflow-deps.ts",
  "src/tui/shell/session-navigation.ts -> src/queue/executor.ts",
  "src/tui/shell/session-navigation.ts -> src/queue/types.ts",
  "src/tui/shell/session-navigation.ts -> src/session/budget-tracker.ts",
  "src/tui/shell/session-navigation.ts -> src/session/manager.ts",
  "src/tui/shell/session-navigation.ts -> src/session/persistence.ts",
  "src/tui/shell/shell-lifecycle.ts -> src/engines/workflow-deps.ts",
  "src/tui/shell/shell-lifecycle.ts -> src/queue/executor.ts",
  "src/tui/shell/shell-lifecycle.ts -> src/queue/question-service.ts",
  "src/tui/shell/shell-lifecycle.ts -> src/queue/types.ts",
  "src/tui/shell/start-command.ts -> src/queue/templates.ts",
  // src/tui/utils/
  "src/tui/utils/question-wiring.ts -> src/queue/question-service.ts",
]);

const rules: BoundaryRule[] = [
  {
    id: "harness-no-tui",
    description: "Files under src/harness may not import from src/tui.",
    matches(importRef): boolean {
      return isUnder(importRef.sourcePath, "src/harness/") && isUnder(importRef.targetPath, "src/tui/");
    },
  },
  {
    id: "harness-no-workflows",
    description: "Files under src/harness may not import from workflow-owned folders except tracked temporary exceptions.",
    matches(importRef): boolean {
      if (!isUnder(importRef.sourcePath, "src/harness/")) return false;
      if (!isWorkflowPath(importRef.targetPath)) return false;
      return !isTemporarilyAllowed(importRef);
    },
  },
  {
    id: "tui-no-direct-harness",
    description: "Files under src/tui may not import from src/harness internals (harness/index.ts is allowed).",
    matches(importRef): boolean {
      if (!isUnder(importRef.sourcePath, "src/tui/")) return false;
      if (!isUnder(importRef.targetPath, "src/harness/")) return false;
      if (importRef.targetPath === "src/harness/index.ts") return false;
      return !isTemporarilyAllowed(importRef);
    },
  },
  {
    id: "protocol-purity",
    description: "Files under src/protocol may not import from higher-level modules.",
    matches(importRef): boolean {
      if (!isUnder(importRef.sourcePath, "src/protocol/")) return false;
      return ["harness", "workflows", "orchestration", "tui"].some((moduleName) =>
        isModulePath(importRef.targetPath, moduleName as ModuleName),
      );
    },
  },
  {
    id: "harness-deep-import-fence",
    description: "Files outside src/harness must import from src/harness/index.ts, not internal modules.",
    matches(importRef): boolean {
      if (isUnder(importRef.sourcePath, "src/harness/")) return false;
      if (!isUnder(importRef.targetPath, "src/harness/")) return false;
      if (importRef.targetPath === "src/harness/index.ts") return false;
      return !isTemporarilyAllowed(importRef);
    },
  },
  {
    id: "orchestration-no-tui",
    description: "Files under src/orchestration may not import from src/tui except tracked temporary exceptions.",
    matches(importRef): boolean {
      if (!isUnder(importRef.sourcePath, "src/orchestration/")) return false;
      if (!isUnder(importRef.targetPath, "src/tui/")) return false;
      return !isTemporarilyAllowed(importRef);
    },
  },
  {
    id: "tui-no-direct-domain",
    description: "Files under src/tui must not import from src/queue, src/session, src/engines, or src/dispatcher directly.",
    matches(importRef): boolean {
      if (!isUnder(importRef.sourcePath, "src/tui/")) return false;
      const isDomainTarget =
        isUnder(importRef.targetPath, "src/queue/") ||
        isUnder(importRef.targetPath, "src/session/") ||
        isUnder(importRef.targetPath, "src/engines/") ||
        isUnder(importRef.targetPath, "src/dispatcher/");
      if (!isDomainTarget) return false;
      return !isTemporarilyAllowed(importRef);
    },
  },
];

function isWorkflowPath(relPath: string): boolean {
  return isUnder(relPath, "src/queue/") || isUnder(relPath, "src/dispatcher/") || isUnder(relPath, "src/evaluator/");
}

function isModulePath(relPath: string, moduleName: ModuleName): boolean {
  switch (moduleName) {
    case "harness":
      return isUnder(relPath, "src/harness/");
    case "workflows":
      return isWorkflowPath(relPath);
    case "orchestration":
      return isUnder(relPath, "src/orchestration/");
    case "tui":
      return isUnder(relPath, "src/tui/");
    case "protocol":
      return isUnder(relPath, "src/protocol/");
  }
}

function isUnder(relPath: string, prefix: string): boolean {
  return relPath === prefix.slice(0, -1) || relPath.startsWith(prefix);
}

function normalizeRel(absPath: string): string {
  return path.relative(repoRoot, absPath).split(path.sep).join("/");
}

function listSourceFiles(dirPath: string): string[] {
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  const results: string[] = [];

  for (const entry of entries) {
    const absPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      results.push(...listSourceFiles(absPath));
      continue;
    }

    if (!entry.isFile()) continue;
    if (!/\.(ts|tsx)$/.test(entry.name)) continue;
    if (entry.name.endsWith(".d.ts")) continue;
    results.push(absPath);
  }

  return results;
}

function collectSpecifiers(fileText: string): Array<{ specifier: string; line: number }> {
  const matches: Array<{ specifier: string; line: number }> = [];
  const patterns = [
    /(?:^|\n)\s*import\s+(?:type\s+)?[\s\S]*?\sfrom\s+["']([^"']+)["']/g,
    /(?:^|\n)\s*import\s*["']([^"']+)["']/g,
    /import\s*\(\s*["']([^"']+)["']\s*\)/g,
  ];

  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(fileText)) !== null) {
      const specifier = match[1];
      if (!specifier) continue;
      matches.push({
        specifier,
        line: 1 + countNewlines(fileText, match.index),
      });
    }
  }

  return matches;
}

function countNewlines(text: string, endIndex: number): number {
  let count = 0;
  for (let i = 0; i < endIndex; i++) {
    if (text.charCodeAt(i) === 10) count++;
  }
  return count;
}

function resolveImport(sourceFileAbs: string, specifier: string): string | null {
  if (specifier.startsWith("@tui/")) {
    const subPath = specifier.slice("@tui/".length);
    return resolveFromBase(path.join(srcRoot, "tui", subPath));
  }

  if (!specifier.startsWith(".")) return null;

  const sourceDir = path.dirname(sourceFileAbs);
  return resolveFromBase(path.resolve(sourceDir, specifier));
}

function resolveFromBase(basePath: string): string | null {
  const candidates = new Set<string>([
    basePath,
    `${basePath}.ts`,
    `${basePath}.tsx`,
    path.join(basePath, "index.ts"),
    path.join(basePath, "index.tsx"),
  ]);

  if (basePath.endsWith(".js") || basePath.endsWith(".jsx")) {
    candidates.add(basePath.replace(/\.jsx?$/, ".ts"));
    candidates.add(basePath.replace(/\.jsx?$/, ".tsx"));
  }

  for (const candidate of candidates) {
    if (!fs.existsSync(candidate)) continue;
    const stat = fs.statSync(candidate);
    if (!stat.isFile()) continue;
    return normalizeRel(candidate);
  }

  return null;
}

function makeImportKey(importRef: ImportRef): string {
  return `${importRef.sourcePath} -> ${importRef.targetPath}`;
}

function isTemporarilyAllowed(importRef: ImportRef): boolean {
  return temporaryAllowlist.has(makeImportKey(importRef));
}

function main(): void {
  const files = listSourceFiles(srcRoot);
  const imports: ImportRef[] = [];

  for (const file of files) {
    const text = fs.readFileSync(file, "utf8");
    const sourcePath = normalizeRel(file);
    const specifiers = collectSpecifiers(text);

    for (const { specifier, line } of specifiers) {
      const targetPath = resolveImport(file, specifier);
      if (!targetPath) continue;
      imports.push({ sourcePath, targetPath, specifier, line });
    }
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
