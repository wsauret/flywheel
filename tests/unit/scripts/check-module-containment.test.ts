import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { findFactRetentionViolations, type FactRetentionRegistry } from "../../../scripts/check-fact-retention.js";
import { clientRegistryEntries, discoverModuleHomes, findModuleHomeImportViolations, findModuleRegistryViolations, findModuleVocabularyViolations, type ModuleContainmentRegistry, type ModuleVocabulary } from "../../../scripts/check-module-containment.js";
import { moduleHomeImportViolation } from "../../../scripts/module-homes.js";
import type { ModuleContainmentAllowance } from "../../../scripts/module-containment-allowlist.js";
import { collectImportSpecifiers } from "../../../scripts/source-imports.js";

const MODULE_IDS = ["gizmo", "widget"];

const VOCABULARY: ModuleVocabulary = {
  moduleIds: MODULE_IDS,
  domains: [{ literal: "gizmo_view", module: "gizmo" }, { literal: "gizmoViewSnapshot", module: "gizmo" }],
  facts: [{ type: "gizmo.recorded", module: "gizmo" }],
};

type Files = { readonly [relPath: string]: string };

function withTree<T>(files: Files, run: (root: string) => T): T {
  const root = mkdtempSync(join(tmpdir(), "flywheel-module-containment-"));
  try {
    for (const [relPath, content] of Object.entries(files)) {
      const file = join(root, relPath);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, content);
    }
    return run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function violations(files: Files, allowlist: readonly ModuleContainmentAllowance[] = []) {
  return withTree(files, (root) => findModuleVocabularyViolations(root, VOCABULARY, allowlist));
}

const summary = (report: ReturnType<typeof findModuleVocabularyViolations>): string[] =>
  report.violations.map((violation) => `${violation.path} ${violation.rule} ${violation.literal}`);

describe("check-module-containment", () => {
  test("a module id in a foreign file that handles module ids fails", () => {
    const report = violations({
      "src/orchestration/app-service/host.ts": 'import type { ModuleId } from "../modules.js"\nexport const ceiling: readonly ModuleId[] = ["gizmo"]\n',
    });
    expect(summary(report)).toEqual(["src/orchestration/app-service/host.ts module-id gizmo"]);
  });

  test("a tool term that shares a module's spelling passes as the argument of a capability check", () => {
    const report = violations({
      "src/orchestration/app-service/host.ts": 'import type { ModuleId } from "../modules.js"\nexport const shell = (has: (term: string) => boolean) => has("gizmo") && disabledToolReason("widget", selection) === undefined\n',
    });
    expect(summary(report)).toEqual([]);
  });

  test("the same literal in the module's homes and the registries passes", () => {
    const report = violations({
      "src/orchestration/modules/gizmo.ts": 'import type { FirstPartyModule } from "../modules.js"\nexport const gizmoModule = { id: "gizmo", dependencies: ["widget"] } as const satisfies FirstPartyModule\n',
      "src/orchestration/modules/gizmo/runtime.ts": 'export const kind = "gizmo"\n',
      "src/tui/modules/gizmo/strip.tsx": 'export const id = "gizmo"\n',
      "src/orchestration/modules.ts": 'export const ids = ["gizmo", "widget"]\n',
      "src/protocol/module-ids.ts": 'export const MODULE_IDS = ["gizmo", "widget"] as const\n',
    });
    expect(summary(report)).toEqual([]);
  });

  test("a same-spelled literal in a file that never handles module ids is another vocabulary", () => {
    const report = violations({
      "src/infra/shell.ts": 'export const command = ["gizmo", "-c", "echo"]\n',
    });
    expect(summary(report)).toEqual([]);
  });

  test("a protocol domain or query discriminant outside the protocol home fails", () => {
    const report = violations({
      "src/protocol/modules/gizmo.ts": 'export const domain = { domain: "gizmo_view", query: "gizmoViewSnapshot" }\n',
      "src/orchestration/app-service/router.ts": 'export const route = { "gizmoViewSnapshot": 1 }\n',
      "webview/src/app/intake.ts": "export const cursor = 'gizmo_view'\n",
    });
    expect(summary(report)).toEqual([
      "src/orchestration/app-service/router.ts protocol-domain gizmoViewSnapshot",
      "webview/src/app/intake.ts protocol-domain gizmo_view",
    ]);
  });

  test("a fact family defined outside its owner's home fails", () => {
    const report = violations({
      "src/orchestration/session/gizmo-facts.ts": 'export const schema = defineFact({\n  type: "gizmo.recorded",\n})\n',
      "src/orchestration/modules/gizmo/facts.ts": 'export const schema = defineFact({\n  type: "gizmo.recorded",\n})\n',
    });
    expect(summary(report)).toEqual(["src/orchestration/session/gizmo-facts.ts fact-family gizmo.recorded"]);
  });

  test("an allowance suppresses one hit and a stale allowance fails", () => {
    const report = violations(
      { "src/orchestration/session/gizmo-facts.ts": 'const type = "gizmo.recorded"\n' },
      [
        { path: "src/orchestration/session/gizmo-facts.ts", literal: "gizmo.recorded", unit: 13 },
        { path: "src/orchestration/session/gone.ts", literal: "gizmo", unit: 13 },
      ],
    );
    expect(summary(report)).toEqual([]);
    expect(report.stale).toEqual([{ path: "src/orchestration/session/gone.ts", literal: "gizmo", unit: 13 }]);
  });
});

const protocolContract = (id: string) => ({ id });

function containmentRegistry(overrides: Partial<ModuleContainmentRegistry> = {}): ModuleContainmentRegistry {
  const gizmoProtocol = protocolContract("gizmo");
  return {
    catalog: [{ id: "gizmo", protocol: { contract: gizmoProtocol } }],
    protocol: [gizmoProtocol],
    tui: [{ id: "gizmo" }],
    web: [{ id: "gizmo" }],
    homes: {
      orchestration: ["gizmo"],
      protocol: ["gizmo"],
      tui: ["gizmo"],
      web: ["gizmo"],
    },
    ...overrides,
  };
}

describe("module registry containment", () => {
  test("rejects duplicate registry identities", () => {
    const failures = findModuleRegistryViolations(containmentRegistry({
      tui: [{ id: "gizmo" }, { id: "gizmo" }],
    }));

    expect(failures).toContain('tui registry declares duplicate module id "gizmo"');
  });

  test("requires every protocol contract to have one matching orchestration owner", () => {
    const registered = protocolContract("gizmo");
    expect(findModuleRegistryViolations(containmentRegistry({
      catalog: [{ id: "gizmo", protocol: { contract: protocolContract("widget") } }],
      protocol: [registered],
    }))).toContain('orchestration module "gizmo" binds protocol contract "widget"');

    expect(findModuleRegistryViolations(containmentRegistry({
      catalog: [{ id: "gizmo" }],
      protocol: [registered],
    }))).toContain('protocol module "gizmo" has no orchestration binding');

    expect(findModuleRegistryViolations(containmentRegistry({
      catalog: [{ id: "gizmo", protocol: { contract: registered } }],
      protocol: [],
    }))).toContain('orchestration module "gizmo" binds a protocol contract absent from the protocol registry');

    expect(findModuleRegistryViolations(containmentRegistry({
      catalog: [{ id: "gizmo", protocol: { contract: protocolContract("gizmo") } }],
      protocol: [registered],
    }))).toContain('orchestration module "gizmo" does not bind the registered "gizmo" protocol contract');
  });

  test("requires registry membership and canonical homes to agree", () => {
    expect(findModuleRegistryViolations(containmentRegistry({
      homes: { orchestration: ["gizmo"], protocol: ["gizmo"], tui: [], web: ["gizmo"] },
    }))).toContain('tui registry module "gizmo" has no canonical home');

    expect(findModuleRegistryViolations(containmentRegistry({
      tui: [],
    }))).toContain('tui module home "gizmo" has no registry entry');
  });

  test("reads membership from the registry array rather than its imports", () => {
    const imports = [{
      sourcePath: "src/tui/modules.ts",
      targetPath: "src/tui/modules/mcp/index.ts",
      specifier: "./modules/mcp/index.js",
      line: 1,
      isTypeOnly: false,
      dynamic: false,
    }];

    expect(clientRegistryEntries(imports, "src/tui/modules.ts", "export const TUI_MODULES = [] as const", "TUI_MODULES")).toEqual([]);
    expect(clientRegistryEntries(imports, "src/tui/modules.ts", 'import { mcpTui } from "./modules/mcp/index.js"\nexport const TUI_MODULES = [mcpTui, mcpTui] as const', "TUI_MODULES")).toEqual([{ id: "mcp" }, { id: "mcp" }]);
  });

  test("discovers an unknown module home independently of the module vocabulary", () => {
    const homes = withTree({
      "src/orchestration/modules/unregistered.ts": "export const value = true\n",
    }, discoverModuleHomes);

    expect(homes.orchestration).toContain("unregistered");
    expect(findModuleRegistryViolations({
      catalog: [],
      protocol: [],
      tui: [],
      web: [],
      homes,
    })).toContain('orchestration module home "unregistered" has no registry entry');
  });
});

describe("check-fact-retention ownership", () => {
  const registry = (overrides: Partial<FactRetentionRegistry> = {}): FactRetentionRegistry => ({
    retention: () => ({ policy: "history" }),
    owner: () => "experiments",
    declaredTypes: () => ["gizmo.recorded"],
    retiredTypes: () => [],
    prunable: [],
    prefixes: () => ["gizmo."],
    ...overrides,
  });

  test("a module-owned family defined under its owner's fact home passes", () => {
    const { failures } = withTree(
      { "src/orchestration/modules/experiments/facts.ts": 'defineFact({\n  type: "gizmo.recorded",\n})\n' },
      (root) => findFactRetentionViolations(root, registry()),
    );
    expect(failures).toEqual([]);
  });

  test("a module-owned family defined outside its owner's fact home fails", () => {
    const { failures } = withTree(
      { "src/orchestration/session/gizmo-facts.ts": 'defineFact({\n  type: "gizmo.recorded",\n})\n' },
      (root) => findFactRetentionViolations(root, registry()),
    );
    expect(failures).toEqual([
      '"gizmo.recorded" is owned by experiments but is defined in src/orchestration/session/gizmo-facts.ts, outside that module\'s fact home (src/orchestration/modules/experiments.ts, src/orchestration/modules/experiments/)',
    ]);
  });

  test("a module-owned family that carries none of the owner's prefixes fails", () => {
    const { failures } = withTree(
      { "src/orchestration/modules/experiments/facts.ts": 'defineFact({\n  type: "gizmo.recorded",\n})\n' },
      (root) => findFactRetentionViolations(root, registry({ prefixes: () => ["experiment."] })),
    );
    expect(failures).toEqual(['"gizmo.recorded" is owned by experiments but carries none of its declared fact prefixes (experiment.)']);
  });
});

describe("module home boundary rule", () => {
  test("the shared scanner preserves static, type-only, side-effect, and dynamic imports", () => {
    expect(collectImportSpecifiers([
      'import { value } from "./static.js"',
      'import type { Shape } from "./types.js"',
      'import "./effect.js"',
      'const lazy = import("./lazy.js")',
    ].join("\n"))).toEqual([
      { specifier: "./static.js", line: 1, isTypeOnly: false, dynamic: false },
      { specifier: "./types.js", line: 2, isTypeOnly: true, dynamic: false },
      { specifier: "./effect.js", line: 3, isTypeOnly: false, dynamic: false },
      { specifier: "./lazy.js", line: 4, isTypeOnly: false, dynamic: true },
    ]);
  });

  test("the containment report carries the importing path, target, and owner", () => {
    expect(findModuleHomeImportViolations([{
      sourcePath: "src/orchestration/host.ts",
      targetPath: "src/orchestration/modules/gizmo/runtime.ts",
      specifier: "./modules/gizmo/runtime.js",
      line: 7,
      isTypeOnly: false,
      dynamic: false,
    }], MODULE_IDS)).toEqual([{
      path: "src/orchestration/host.ts",
      line: 7,
      target: "src/orchestration/modules/gizmo/runtime.ts",
      module: "gizmo",
    }]);
  });

  test("a registry import passes", () => {
    expect(moduleHomeImportViolation("src/orchestration/modules.ts", "src/orchestration/modules/gizmo.ts", MODULE_IDS)).toBeUndefined();
    expect(moduleHomeImportViolation("src/tui/modules.ts", "src/tui/modules/gizmo/index.ts", MODULE_IDS)).toBeUndefined();
  });

  test("a module's own homes import each other across layers", () => {
    expect(moduleHomeImportViolation("src/tui/modules/gizmo/strip.tsx", "src/protocol/modules/gizmo/transport.ts", MODULE_IDS)).toBeUndefined();
    expect(moduleHomeImportViolation("relay/src/host.ts", "src/protocol/modules/gizmo/transport.ts", MODULE_IDS)).toBeUndefined();
    expect(moduleHomeImportViolation("vscode/src/host.ts", "src/protocol/modules/gizmo.ts", MODULE_IDS)).toBeUndefined();
    expect(moduleHomeImportViolation("relay/src/host.ts", "src/orchestration/modules/gizmo/runtime.ts", MODULE_IDS)).toBe("gizmo");
    expect(moduleHomeImportViolation("webview/src/host.ts", "src/protocol/modules/gizmo/transport.ts", MODULE_IDS)).toBeUndefined();
    expect(moduleHomeImportViolation("webview/src/app.tsx", "src/protocol/modules/gizmo/transport.ts", MODULE_IDS)).toBe("gizmo");
    expect(moduleHomeImportViolation("src/tui/modules/gizmo/strip.tsx", "src/protocol/modules/gizmo.ts", MODULE_IDS)).toBeUndefined();
    expect(moduleHomeImportViolation("src/orchestration/modules/gizmo.ts", "src/orchestration/modules/gizmo/runtime.ts", MODULE_IDS)).toBeUndefined();
  });

  test("a foreign import fails and names the module whose home it crosses into", () => {
    expect(moduleHomeImportViolation("src/orchestration/app-service/host.ts", "src/orchestration/modules/gizmo/runtime.ts", MODULE_IDS)).toBe("gizmo");
    expect(moduleHomeImportViolation("src/orchestration/modules/widget.ts", "src/orchestration/modules/gizmo.ts", MODULE_IDS)).toBe("gizmo");
    expect(moduleHomeImportViolation("src/orchestration/app-service/host.ts", "src/orchestration/modules/gizmo-parser.ts", MODULE_IDS)).toBeUndefined();
  });
});
