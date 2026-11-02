import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { watch } from "node:fs";
import type { AgentDefinition } from "../../../../infra/agent-definition.js";
import type { PersonaBenchmarkDeps } from "./persona-benchmark.js";
import type { BenchmarkCatalog } from "./catalog.js";
import { bytesIdentity, structuredIdentity } from "./content-identity.js";
import { unavailableBenchmarkAccounting } from "./evidence.js";
import { PersonaTaskFailure, renderPersonaTaskGuidance, type BenchmarkRuntime } from "./persona-run.js";
import { decodeNativePersonaRequest, decodeNativePersonaResult, NATIVE_STARTUP_TIMEOUT_MS, NATIVE_SETTLEMENT_GRACE_MS, NATIVE_CANDIDATE_TIMEOUT_MS } from "./native-persona-codec.js";

// Signal latency is negligible against the 180 s startup and settlement
// deadlines, and four stat calls a second per cell cost nothing measurable.
const SIGNAL_POLL_MS = 250;

/**
 * Runs each handler once when the worker creates the signal file of the same
 * name in `directory`. File existence is the source of truth: macOS drops
 * fs.watch events under load and never delivers them later, so the watch is
 * only a fast path and a periodic existence check catches what it misses.
 * Returns a function that stops both; no handler runs after it.
 */
function onSignalFiles(directory: string, handlers: ReadonlyMap<string, () => void>): () => void {
  const pending = new Map(handlers);
  let stopped = false;
  let poll: ReturnType<typeof setTimeout> | undefined;
  const fire = (name: string): void => {
    const handler = pending.get(name);
    if (stopped || !handler) return;
    pending.delete(name);
    handler();
  };
  const watcher = watch(directory, (_event, name) => { if (name) fire(name.toString()); });
  const check = async (): Promise<void> => {
    for (const name of pending.keys()) {
      if (await Bun.file(join(directory, name)).exists()) fire(name);
    }
    if (!stopped && pending.size > 0) poll = setTimeout(check, SIGNAL_POLL_MS);
  };
  poll = setTimeout(check, SIGNAL_POLL_MS);
  return () => {
    stopped = true;
    watcher.close();
    clearTimeout(poll);
  };
}

/** Invokes the source tree's native isolation resource. It never substitutes an in-process native candidate. */
export async function createNativePersonaInvocation(
  runtime: BenchmarkRuntime,
  catalog: BenchmarkCatalog,
): Promise<NonNullable<PersonaBenchmarkDeps["nativeInvocation"]>> {
  if (process.platform !== "darwin") throw new Error("Native isolation uses the macOS-only benchmark sandbox-exec backend");
  if (!await Bun.file("/usr/bin/sandbox-exec").exists()) throw new Error("The native isolation backend requires /usr/bin/sandbox-exec");
  const root = catalog.projectRoot;
  const sources = [
    "src/orchestration/modules/development/benchmark/native-persona-invocation.ts",
    "src/orchestration/modules/development/benchmark/native-persona-codec.ts",
    "src/orchestration/modules/development/benchmark/persona-run.ts",
    "bench/shared/native-persona-launcher.ts",
    "bench/shared/native-persona-worker.ts",
    "bench/shared/runtime.ts",
    "bench/chat-ab/isolation.ts",
  ];
  for (const path of sources) {
    if (!await Bun.file(join(root, path)).exists()) {
      throw new Error(`The native isolation backend resource is missing: ${path}. Run from a complete Flywheel source checkout or supply nativeInvocation.`);
    }
  }
  if (!runtime.profileId || !runtime.authorityIncarnation) throw new Error("Native isolation requires an exact profile and Usage authority");
  if (!runtime.admissionIdentity) throw new Error("Native isolation requires normal benchmark admission metadata; call admitBenchmark or supply nativeInvocation");
  const admissionIdentity = runtime.admissionIdentity;
  const usageAuthority = { profileId: runtime.profileId, authorityIncarnation: runtime.authorityIncarnation };
  const sourceIdentity = structuredIdentity({
    backend: "macos-native-persona",
    sources: await Promise.all(sources.map(async path => ({ path, identity: bytesIdentity(new Uint8Array(await Bun.file(join(root, path)).arrayBuffer())) }))),
  });
  return {
    sourceIdentity,
    async run(request, path) {
      const startedAt = performance.now();
      const jobs = join(catalog.resultsRoot, ".native-workers");
      await mkdir(jobs, { recursive: true });
      const job = await mkdtemp(join(jobs, "cell-"));
      const cancelPath = join(job, "cancel");
      const resultPath = join(job, "result.json");
      const controller = new AbortController();
      let forcedCancel: ReturnType<typeof setTimeout> | undefined;
      let cancelWrite: Promise<unknown> | undefined;
      let startupExpired = false;
      let startupTimer: ReturnType<typeof setTimeout> | undefined;
      const beginSettlement = (): void => {
        if (startupTimer) clearTimeout(startupTimer);
        if (!forcedCancel) forcedCancel = setTimeout(() => controller.abort(), NATIVE_SETTLEMENT_GRACE_MS);
      };
      const stopSignals = onSignalFiles(job, new Map([
        ["ready", () => { if (startupTimer) clearTimeout(startupTimer); }],
        ["settling", beginSettlement],
      ]));
      const onAbort = (): void => {
        if (cancelWrite) return;
        cancelWrite = Bun.write(cancelPath, "").catch(() => { controller.abort(); });
        beginSettlement();
      };
      request.signal?.addEventListener("abort", onAbort, { once: true });
      try {
        const registry = request.agentRegistry ?? new Map<string, AgentDefinition>();
        const dto = decodeNativePersonaRequest({
          sourceRoot: root,
          accountHome: runtime.accountHome,
          usageAuthority,
          guidanceIdentity: structuredIdentity(renderPersonaTaskGuidance(request.persona, registry, runtime.definitions.skills())),
          moduleIds: runtime.moduleSelection().enabledModuleIds,
          admissionIdentity: {
            runtimeConfig: admissionIdentity.runtimeConfig,
          },
          persona: request.persona,
          registry: [...registry],
          seat: {
            ...(request.seat.model === undefined ? {} : { model: request.seat.model }),
            ...(request.seat.effort === undefined ? {} : { effort: request.seat.effort }),
          },
          prompt: request.prompt,
          label: request.label,
          workspace: request.workspace,
          path,
          ...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs }),
          ...(request.transcriptPath === undefined ? {} : { transcriptPath: request.transcriptPath }),
        });
        const requestPath = join(job, "request.json");
        await Bun.write(requestPath, JSON.stringify(dto));
        if (request.signal?.aborted) onAbort();
        if (!cancelWrite) startupTimer = setTimeout(() => { startupExpired = true; controller.abort(); }, NATIVE_STARTUP_TIMEOUT_MS);
        const exit = await runtime.runOwnedCommand([
          process.execPath, "--conditions=browser", join(root, "bench", "shared", "native-persona-launcher.ts"),
          requestPath, resultPath, cancelPath, catalog.resultsRoot,
        ], {
          cwd: root,
          timeoutMs: NATIVE_STARTUP_TIMEOUT_MS + (request.timeoutMs ?? NATIVE_CANDIDATE_TIMEOUT_MS) + NATIVE_SETTLEMENT_GRACE_MS,
          signal: controller.signal,
        });
        const result = await Bun.file(resultPath).exists()
          ? decodeNativePersonaResult(JSON.parse(await Bun.file(resultPath).text()))
          : undefined;
        if (result?.kind === "unsuccessful") throw new PersonaTaskFailure(result.terminal, result, result.message);
        if (result && exit.exitCode === 0 && !exit.timedOut && !controller.signal.aborted && !request.signal?.aborted) {
          return { ...result, handoff: result.handoff ?? undefined };
        }
        const terminal = request.signal?.aborted
          ? { kind: "cancelled" as const }
          : startupExpired
            ? { kind: "failed" as const, message: "Native startup deadline exceeded" }
          : result?.kind === "completed" && (exit.timedOut || controller.signal.aborted)
            ? { kind: "failed" as const, message: "Native settlement deadline exceeded" }
          : exit.timedOut || controller.signal.aborted
            ? { kind: "timed-out" as const, timeoutMs: request.timeoutMs ?? NATIVE_CANDIDATE_TIMEOUT_MS }
            : { kind: "failed" as const, message: `Native launcher exited with code ${exit.exitCode}` };
        throw new PersonaTaskFailure(terminal, result ?? {
          durationMs: Math.round(performance.now() - startedAt),
          accounting: unavailableBenchmarkAccounting("the native worker settled without recoverable accounting"),
        }, result ? "Native worker did not settle successfully" : "Native worker settled without a result");
      } finally {
        stopSignals();
        if (startupTimer) clearTimeout(startupTimer);
        request.signal?.removeEventListener("abort", onAbort);
        if (forcedCancel) clearTimeout(forcedCancel);
        await cancelWrite;
        await rm(job, { recursive: true, force: true });
      }
    },
  };
}
