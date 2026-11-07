import { createRequire } from "node:module";
import { watch, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { installModuleCatalog } from "../../src/orchestration/module-catalog.js";
import { osAccount } from "../../src/infra/os-account.js";
import type { FirstPartyModule } from "../../src/orchestration/modules.js";
import type { createClaudeAgentSdkModule as CreateSdkModule } from "../../src/orchestration/modules/provider-claude-agent-sdk/module.js";
import { decodeNativePersonaRequest, nativePersonaStartupFailure, writeNativePersonaResult, NATIVE_CANDIDATE_TIMEOUT_MS, type NativePersonaResult } from "../../src/orchestration/modules/development/benchmark/native-persona-codec.js";

const load = createRequire(import.meta.url);
let accountHome: string;
installModuleCatalog({
  credentialProviders: () => {
    const shipped: readonly FirstPartyModule[] = load("../../src/orchestration/credential-provider-modules.js").CREDENTIAL_PROVIDER_MODULES;
    const create: typeof CreateSdkModule = load("../../src/orchestration/modules/provider-claude-agent-sdk/module.js").createClaudeAgentSdkModule;
    const sdk = create({ account: () => ({ home: accountHome, user: osAccount().user }) });
    return shipped.map(module => module.id === sdk.id ? sdk : module);
  },
  otherModules: () => [
    ...load("../../src/orchestration/modules.js").SHIPPED_OTHER_MODULES,
    ...load("../../src/orchestration/development-modules.js").DEVELOPMENT_MODULES,
  ],
});

/** One confined process owns one ordinary runtime generation. Candidate accounting is recoverable during disposal. */
async function main(requestPath: string, resultPath: string, cancelPath: string): Promise<void> {
  const startedAt = performance.now();
  let phase: Parameters<typeof nativePersonaStartupFailure>[0] = "request";
  let cause: Parameters<typeof nativePersonaStartupFailure>[1] = "operation-failed";
  let result: NativePersonaResult | undefined;
  const controller = new AbortController();
  const onAbort = (): void => controller.abort();
  let watcher: ReturnType<typeof watch> | undefined;
  try {
    const request = decodeNativePersonaRequest(JSON.parse(await Bun.file(requestPath).text()));
    accountHome = request.accountHome;
    phase = "imports";
    const [
      { createBenchmarkRuntime },
      { createInstalledDefinitionRegistry },
      { selectStartupDirectories },
      { admitBenchmark },
      { runPersonaTask, renderPersonaTaskGuidance, PersonaTaskFailure },
      { structuredIdentity },
    ] = await Promise.all([
      import("./runtime.js"),
      import("../../src/orchestration/definition-catalog.js"),
      import("../../src/infra/directory-authorities.js"),
      import("../../src/orchestration/modules/development/benchmark/admission.js"),
      import("../../src/orchestration/modules/development/benchmark/persona-run.js"),
      import("../../src/orchestration/modules/development/benchmark/content-identity.js"),
    ]);
    watcher = watch(dirname(cancelPath), (_event, name) => { if (name?.toString() === "cancel") onAbort(); });
    process.once("SIGTERM", onAbort);
    process.once("SIGINT", onAbort);
    if (await Bun.file(cancelPath).exists()) onAbort();
    phase = "runtime";
    const directories = selectStartupDirectories({
      projectRootOption: request.sourceRoot, cwd: request.sourceRoot, env: process.env, home: request.accountHome,
    });
    const definitions = createInstalledDefinitionRegistry(directories);
    await using runtime = await createBenchmarkRuntime(request.workspace, {
      definitions,
      accountHome: request.accountHome,
      stored: request.usageAuthority,
      authProfile: request.usageAuthority.profileId,
      watchConfig: true,
    });
    let settling = false;
    const markSettling = (): void => {
      if (settling) return;
      settling = true;
      writeFileSync(join(dirname(requestPath), "settling"), "");
    };
    phase = "identity";
    runtime.assertUsageAuthority(request.usageAuthority);
    if (runtime.profileId !== request.usageAuthority.profileId || runtime.deps.accountHome !== request.accountHome) {
      cause = "account-identity-changed";
      throw new Error("Native worker account identity changed");
    }
    if (structuredIdentity(runtime.deps.moduleSelection().enabledModuleIds) !== structuredIdentity(request.moduleIds)) {
      cause = "module-selection-changed";
      throw new Error("Native worker module selection changed");
    }
    const registry = new Map(request.registry);
    if (structuredIdentity(renderPersonaTaskGuidance(request.persona, registry, runtime.deps)) !== request.guidanceIdentity) {
      cause = "guidance-changed";
      throw new Error("Native worker persona guidance, skills, or tool grants changed");
    }
    phase = "admission";
    const admission = await admitBenchmark({
      ...runtime.deps,
      profileId: runtime.profileId,
      authorityIncarnation: runtime.usageAuthority.authorityIncarnation,
      launcher: runtime.launcher,
      background: runtime.background,
      foregroundBashHold: runtime.foregroundBashHold,
      shell: runtime.shell,
    }, [{ role: "candidate", roleId: request.persona.role, ...request.seat }]);
    if (admission.runtime.admissionIdentity?.runtimeConfig !== request.admissionIdentity.runtimeConfig) {
      cause = "admission-changed";
      throw new Error("Native worker runtime configuration changed");
    }
    try {
      const timeoutMs = request.timeoutMs ?? NATIVE_CANDIDATE_TIMEOUT_MS;
      try {
        const outcome = await runPersonaTask(admission.runtime, {
          persona: request.persona,
          seat: request.seat,
          prompt: request.prompt,
          label: request.label,
          workspace: request.workspace,
          agentRegistry: registry,
          signal: controller.signal,
          timeoutMs,
          ...(request.transcriptPath === undefined ? {} : { transcriptPath: request.transcriptPath }),
          onPhase: phase => {
            if (phase === "ready") writeFileSync(join(dirname(requestPath), "ready"), "");
            else markSettling();
          },
        });
        result = { ...outcome, kind: "completed", handoff: outcome.handoff ?? null };
      } catch (error) {
        if (!(error instanceof PersonaTaskFailure)) throw error;
        result = { kind: "unsuccessful", ...error.accounting, terminal: error.terminal, message: error.message };
      }
    } finally {
      markSettling();
      if (result) await writeNativePersonaResult(resultPath, result);
    }
  } catch {
    const message = "Native worker settlement failed";
    result = result ? {
      kind: "unsuccessful",
      terminal: controller.signal.aborted ? { kind: "cancelled" } : { kind: "failed", message },
      message,
      durationMs: result.durationMs,
      accounting: result.accounting,
    } : nativePersonaStartupFailure(phase, cause, Math.round(performance.now() - startedAt));
  } finally {
    watcher?.close();
    process.off("SIGTERM", onAbort);
    process.off("SIGINT", onAbort);
  }
  if (result) await writeNativePersonaResult(resultPath, result);
}

const [requestPath, resultPath, cancelPath] = process.argv.slice(2);
if (!requestPath || !resultPath || !cancelPath) throw new Error("Native worker requires request, result, and cancellation paths");
await main(requestPath, resultPath, cancelPath);
