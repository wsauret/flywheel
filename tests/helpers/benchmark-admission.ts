import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OwnedBenchmarkRuntime } from "../../bench/shared/runtime.js";
import { admitBenchmark } from "../../src/orchestration/modules/development/benchmark/admission.js";
import type { BenchmarkRuntime } from "../../src/orchestration/modules/development/benchmark/persona-run.js";
import { composeFirstPartyModules } from "../../src/orchestration/modules.js";
import { createBackgroundExecutionOwner } from "../../src/orchestration/agent-runtime/background-execution-owner.js";
import { createBackgroundWorkRegistry } from "../../src/orchestration/agent-runtime/background-work.js";
import { createForegroundBashHoldController } from "../../src/orchestration/agent-runtime/foreground-bash-hold.js";
import { testDirectories } from "./directories.js";
import { refusingLauncher } from "./launcher-fake.js";
import { repoDefinitions } from "./project-definitions.js";
import { testRuntimeConfigCapture } from "./request-tool-surface.js";

type BenchmarkModelSeat = Parameters<typeof admitBenchmark>[1][number];
type BenchmarkAdmission = Awaited<ReturnType<typeof admitBenchmark>>;

export const TEST_BENCHMARK_AUTHORITY = {
  profileId: "profile",
  authorityIncarnation: "incarnation",
} as const;

/** A benchmark runtime for a dry run, which reads only its admission
 *  identity and disposes it. Every model, command, and launch refuses, and
 *  disposal closes its background owner before it calls `dispose`. */
export function dryRunBenchmarkRuntime(dispose: () => void): OwnedBenchmarkRuntime {
  const paidCall = (): never => { throw new Error("paid call"); };
  const background = createBackgroundExecutionOwner(createBackgroundWorkRegistry({ kind: "chat", enqueueNotification: () => {} }));
  return {
    deps: {
      ...testDirectories(process.cwd()),
      auth: { providers: new Map(), credentialLineages: {}, droppedCredentials: [] },
      availableModels: new Map(),
      modelInfos: new Map(),
      definitions: repoDefinitions(),
      moduleSelection: composeFirstPartyModules,
      createAgent: paidCall,
      prepareRequest: paidCall,
      planCapabilities: paidCall,
      createLLMClient: paidCall,
      captureProviderConnection: paidCall,
      runOwnedCommand: paidCall,
      resolveEnvSnapshot: paidCall,
      captureRuntimeConfig: testRuntimeConfigCapture,
      awaitModelAccessSettled: async () => {},
    },
    profileId: TEST_BENCHMARK_AUTHORITY.profileId,
    usageAuthority: TEST_BENCHMARK_AUTHORITY,
    background,
    foregroundBashHold: createForegroundBashHoldController(() => {}),
    launcher: refusingLauncher,
    shell: background.shell,
    runOwnedCommand: paidCall,
    assertUsageAuthority: () => {},
    [Symbol.asyncDispose]: async () => { await background.close(); dispose(); },
  };
}

export function dryRunBenchmarkAdmission(seats: readonly BenchmarkModelSeat[]): BenchmarkAdmission {
  const paidCall = (): never => { throw new Error("paid call"); };
  // A dry run returns before it reads any of these.
  const runtime: BenchmarkRuntime = {
    definitions: repoDefinitions(),
    userDataRoot: join(tmpdir(), "flywheel-dry-run-user"),
    accountHome: tmpdir(),
    moduleSelection: composeFirstPartyModules,
    createAgent: paidCall,
    createLLMClient: paidCall,
    runOwnedCommand: paidCall,
  };
  return {
    runtime,
    createJudge: async () => { throw new Error("paid judge call"); },
    providerPlans: seats.map((seat) => ({ ...seat, profileId: TEST_BENCHMARK_AUTHORITY.profileId, providers: ["openai_api" as const] })),
  };
}
