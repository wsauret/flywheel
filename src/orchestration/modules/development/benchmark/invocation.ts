import type { AgentFactory, AgentOptions, AgentRunResult, RuntimeToolSurfaces } from "../../../agent-runtime/types.js";
import { createAgentHost } from "../../../runner/host.js";

type BenchmarkAgentOptions = Omit<AgentOptions, "conversation" | "lifecycle" | "runtimeSurfaces">;

export interface BenchmarkAgentInvocation {
  readonly createAgent: AgentFactory;
  readonly runtimeSurfaces: RuntimeToolSurfaces;
  readonly agentOptions: BenchmarkAgentOptions;
  readonly prompt: string;
  readonly signal?: AbortSignal;
  readonly deadlineMs?: number;
}

/** Runs one stateless benchmark turn and settles only after its Agent has stopped. */
export async function invokeBenchmarkAgent(invocation: BenchmarkAgentInvocation): Promise<AgentRunResult> {
  if (
    invocation.deadlineMs !== undefined
    && (!Number.isFinite(invocation.deadlineMs) || invocation.deadlineMs <= 0)
  ) {
    throw new Error("Benchmark invocation deadlineMs must be a finite positive number");
  }

  const host = createAgentHost({ createRunner: invocation.createAgent });
  let cancellationRequested = invocation.signal?.aborted ?? false;
  const cancel = (): void => {
    cancellationRequested = true;
    host.abortGeneration();
  };
  invocation.signal?.addEventListener("abort", cancel, { once: true });
  const timer = invocation.deadlineMs === undefined ? undefined : setTimeout(cancel, invocation.deadlineMs);

  try {
    return await host.runTurn({
      createContextOptions: () => ({
        ...invocation.agentOptions,
        runtimeSurfaces: invocation.runtimeSurfaces,
        conversation: { kind: "stateless" },
        lifecycle: { kind: "one-shot" },
      }),
      onContextCreated: (agent) => {
        if (cancellationRequested) agent.abort();
      },
      message: invocation.prompt,
      resilience: {},
    });
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    invocation.signal?.removeEventListener("abort", cancel);
    await host.settle();
  }
}
