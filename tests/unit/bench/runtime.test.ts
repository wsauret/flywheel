import { describe, expect, it } from "bun:test";
import { realpathSync } from "node:fs";
import { join } from "node:path";
import { temporaryDirectories } from "../../helpers/directories.js";
import {
  createBenchmarkRuntime,
  type BenchmarkRuntimeComposition,
  type PreparedBenchmarkRuntime,
} from "../../../bench/shared/runtime.js";
import { createBackgroundExecutionOwner } from "../../../src/orchestration/agent-runtime/background-execution/background-execution-owner.js";
import { createBackgroundWorkRegistry } from "../../../src/orchestration/agent-runtime/background-work/background-work.js";
import {
  createForegroundBashHoldController,
  type ForegroundBashHoldController,
} from "../../../src/orchestration/agent-runtime/background-work/foreground-bash-hold.js";
import type { UsageAuthorityGeneration } from "../../../src/orchestration/agent-runtime/request/usage/usage-settlement.js";
import { createInstalledDefinitionRegistry } from "../../../src/orchestration/definition-catalog.js";
import { refusingLauncher } from "../../helpers/launcher-fake.js";
import { makeWorkflowDeps } from "../orchestration/headless/_headless-run-fixtures.js";
import type { ComposedModuleServices } from "../../../src/orchestration/app-service/module-service-host.js";

const deps = makeWorkflowDeps();
const launcher = refusingLauncher;
const background = createBackgroundExecutionOwner(createBackgroundWorkRegistry({ kind: "chat", enqueueNotification: () => {} }));
const shell = background.shell;
const foregroundBashHold = createForegroundBashHoldController(() => {});
const usageAuthority: UsageAuthorityGeneration = { profileId: "fixture", authorityIncarnation: "fixture-generation" };

/** Module services that record their start, settled startup, and disposal. */
function moduleServices(order: string[]): ComposedModuleServices {
  return {
    services: { get: () => undefined },
    instances: [],
    reconcile: () => {},
    start: () => { order.push("module-services-started"); },
    settleStartup: async () => { order.push("module-services-settled"); return []; },
    closeAdmission: () => {},
    dispose: async () => { order.push("module-services-disposed"); },
  };
}

function preparedRuntime(dispose: () => Promise<void>, order: string[] = []): PreparedBenchmarkRuntime {
  return {
    deps,
    profileId: usageAuthority.profileId,
    usageAuthority,
    background,
    foregroundBashHold,
    launcher,
    shell,
    moduleServices: moduleServices(order),
    assertUsageAuthority: (expected) => {
      expect(expected).toEqual(usageAuthority);
    },
    dispose,
  };
}

function composition(
  order: string[],
  prepare: BenchmarkRuntimeComposition["prepare"],
): BenchmarkRuntimeComposition {
  return {
    acquireAvailability: () => { order.push("availability-acquired"); },
    prepare,
    disposeAvailability: async () => { order.push("availability-disposed"); },
  };
}

describe("benchmark process runtime", () => {
  const directory = temporaryDirectories();

  it("keeps explicit account authority separate from the process HOME", async () => {
    const accountHome = realpathSync(directory("benchmark-account-"));
    const cellHome = directory("benchmark-cell-");
    const previousHome = process.env.HOME;
    process.env.HOME = cellHome;
    try {
      await using _runtime = await createBenchmarkRuntime(process.cwd(), {
        accountHome,
        composition: composition([], async (selected) => {
          expect(selected.accountHome).toBe(accountHome);
          expect(selected.userDataRoot).toBe(join(accountHome, ".flywheel"));
          expect(process.env.HOME).toBe(cellHome);
          return preparedRuntime(async () => {});
        }),
      });
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
    }
  });

  it("acquires provider availability before dependency preparation, starts the module services before the first cell, and releases availability last", async () => {
    const order: string[] = [];
    const root = directory("benchmark-definitions-");
    const definitions = createInstalledDefinitionRegistry({
      projectRoot: root,
      accountHome: root,
      userDataRoot: join(root, ".flywheel"),
    });
    const runtime = await createBenchmarkRuntime(process.cwd(), { definitions, composition: composition(
      order,
      async (_directories, { definitions: selectedDefinitions }) => {
        expect(selectedDefinitions).toBe(definitions);
        order.push("deps-prepared");
        return preparedRuntime(async () => { order.push("generation-disposed"); }, order);
      },
    ) });

    expect(order).toEqual(["availability-acquired", "deps-prepared", "module-services-started", "module-services-settled"]);
    expect(runtime.profileId).toBe("fixture");
    expect(runtime.foregroundBashHold).toBe(foregroundBashHold);
    runtime.assertUsageAuthority(runtime.usageAuthority);
    await runtime[Symbol.asyncDispose]();
    await runtime[Symbol.asyncDispose]();
    expect(order).toEqual([
      "availability-acquired",
      "deps-prepared",
      "module-services-started",
      "module-services-settled",
      "module-services-disposed",
      "generation-disposed",
      "availability-disposed",
    ]);
  });

  it("creates foreground Bash ownership after generation validation", async () => {
    const source = await Bun.file(new URL("../../../bench/shared/runtime.ts", import.meta.url)).text();
    const registrations = [
      "await launcher.dispose()",
      "await configOwner.dispose()",
      "usagePool.closeAdmission()",
      "await residentUsage.release()",
      "await usageOwner.settled()",
      "await profileRuntime.dispose()",
      "const deps = await profileRuntime.prepare()",
      "if (stored) profileRuntime.assertGeneration(stored)",
      "const background = createBackgroundExecutionOwner",
      "const foregroundBashHold = createForegroundBashHoldController",
      "const generationResources = resources.move()",
    ];
    let previous = -1;
    for (const registration of registrations) {
      const index = source.indexOf(registration);
      expect(index, registration).toBeGreaterThan(previous);
      previous = index;
    }
  });
});

describe("benchmark process runtime disposal", () => {
  it("closes background execution, then foreground Bash, then the module services, before the generation", async () => {
    const order: string[] = [];
    const hold: ForegroundBashHoldController = {
      register: () => { throw new Error("not used"); },
      release: () => false,
      transferForReplacement: async () => {},
      awaitSettlement: async () => { order.push("foreground-settled"); },
      dispose: () => { order.push("foreground-disposed"); },
    };
    const runtime = await createBenchmarkRuntime(process.cwd(), { composition: composition(order,
      async () => ({
        ...preparedRuntime(async () => { order.push("generation-disposed"); }, order),
        background: {
          ...background,
          close: async () => { order.push("background-closed"); },
        },
        foregroundBashHold: hold,
      }),
    ) });

    await runtime[Symbol.asyncDispose]();

    expect(order).toEqual([
      "availability-acquired",
      "module-services-started",
      "module-services-settled",
      "background-closed",
      "foreground-settled",
      "foreground-disposed",
      "module-services-disposed",
      "generation-disposed",
      "availability-disposed",
    ]);
  });

  it("releases provider availability even when the prepared generation's disposal rejects", async () => {
    const order: string[] = [];
    const runtime = await createBenchmarkRuntime(process.cwd(), { composition: composition(order,
      async () => preparedRuntime(async () => {
        order.push("launcher-disposal-failed");
        throw new Error("launcher disposal failed");
      }),
    ) });

    await expect(runtime[Symbol.asyncDispose]()).rejects.toThrow("launcher disposal failed");
    // A leaked availability lease outlives the process that took it, so it is
    // released before the failure is reported.
    expect(order).toEqual(["availability-acquired", "launcher-disposal-failed", "availability-disposed"]);
  });
});