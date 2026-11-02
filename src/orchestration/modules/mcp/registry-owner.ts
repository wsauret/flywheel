import { createOrderedLane } from "../../../infra/ordered-lane.js";
import type { McpServerRegistry } from "./config.js";
import type { McpManager, McpManagerOptions, McpManagerResource } from "./manager.js";

type ResourceFactory = (options: McpManagerOptions) => McpManagerResource;

function serverRegistryFingerprint(servers: McpServerRegistry): string {
  return JSON.stringify(Object.entries(servers)
    .toSorted(([left], [right]) => left.localeCompare(right))
    .map(([name, config]) => [name, "command" in config
      ? { command: config.command, args: config.args, env: Object.entries(config.env ?? {}).toSorted(([left], [right]) => left.localeCompare(right)), enabled: config.enabled }
      : { url: config.url, headers: Object.entries(config.headers).toSorted(([left], [right]) => left.localeCompare(right)), oauth: config.oauth, enabled: config.enabled }]));
}

/** Owns one published MCP registry. Candidate registries warm in isolation, but
 * never become observable until the previous registry has retired safely. */
export function createMcpRegistryOwner(options: McpManagerOptions, createResource: ResourceFactory): McpManager {
  let active = createResource(options);
  let activeFingerprint = serverRegistryFingerprint(options.servers);
  let disposed = false;
  const replacements = createOrderedLane();
  let building: McpManagerResource | undefined;
  let handoff: Promise<void> | undefined;
  let terminalFailure: Error | undefined;
  let disposeSettlement: Promise<void> | undefined;
  const listeners = new Set<() => void>();
  const publish = (): void => {
    for (const listener of listeners) {
      try {
        listener();
      } catch {
        try {
          options.log?.("MCP status listener failed", { errorCode: "listener_failed" });
        } catch {
          // A diagnostic sink cannot participate in lifecycle settlement.
        }
      }
    }
  };
  let unsubscribe = active.subscribe(publish);

  const replaceServers = (servers: McpServerRegistry): Promise<void> => {
    return replacements.run(async () => {
      const previousFailure = terminalFailure;
      if (previousFailure !== undefined) throw toError(previousFailure);
      if (disposed) throw new Error("MCP manager is disposed");
      const candidateFingerprint = serverRegistryFingerprint(servers);
      if (candidateFingerprint === activeFingerprint) return;
      const candidate = createResource({ ...options, servers });
      building = candidate;
      try {
        await Promise.all(Object.entries(servers)
          .filter(([, config]) => config.enabled)
          .map(async ([name]) => {
            try {
              await candidate.acquire(name);
            } catch (error) {
              const state = candidate.entries().find((entry) => entry.name === name)?.state;
              if (state?.tag !== "needs_auth" && !(state?.tag === "failed" && state.retryable)) throw error;
            }
          }));
      } catch (cause) {
        let failure = toError(cause);
        try {
          await candidate.dispose();
        } catch (cleanupError) {
          failure = new AggregateError([failure, cleanupError], "MCP candidate warmup failed");
          terminalFailure = failure;
        }
        throw failure;
      } finally {
        if (building === candidate) building = undefined;
      }
      if (disposed) {
        await candidate.dispose();
        throw new Error("MCP manager was disposed during replacement");
      }
      const previous = active;
      const pending = Promise.withResolvers<void>();
      void ignoreRejection(pending.promise);
      handoff = pending.promise;
      unsubscribe();
      try {
        await previous.dispose();
        if (disposed) throw new Error("MCP manager was disposed during replacement");
        active = candidate;
        activeFingerprint = candidateFingerprint;
        unsubscribe = active.subscribe(publish);
        publish();
        pending.resolve();
      } catch (cause) {
        const failures: unknown[] = [cause];
        try {
          await candidate.dispose();
        } catch (error) {
          failures.push(error);
        }
        const failure = failures.length === 1
          ? toError(cause)
          : new AggregateError(failures, "MCP registry handoff failed");
        terminalFailure = failure;
        pending.reject(failure);
        throw failure;
      } finally {
        if (handoff === pending.promise) handoff = undefined;
      }
    });
  };

  function dispose(): Promise<void> {
    disposeSettlement ??= disposeManager();
    return disposeSettlement;
  }

  async function disposeManager(): Promise<void> {
    if (disposed) return;
    disposed = true;
    const failures: unknown[] = terminalFailure === undefined ? [] : [terminalFailure];
    try {
      await building?.dispose();
    } catch (error) {
      failures.push(error);
    }
    await replacements.settled();
    unsubscribe();
    try {
      await active.dispose();
    } catch (error) {
      failures.push(error);
    }
    listeners.clear();
    if (failures.length > 0) throw new AggregateError(failures, "MCP manager disposal failed");
  }

  return {
    servers: () => active.servers(),
    entries: () => active.entries(),
    acquire: async (server) => {
      const failure = terminalFailure;
      if (failure !== undefined) throw toError(failure);
      const transition = handoff;
      if (transition !== undefined) await transition;
      return await active.acquire(server);
    },
    tools: () => handoff === undefined ? active.tools() : [],
    call: async (request) => {
      const failure = terminalFailure;
      if (failure !== undefined) throw toError(failure);
      const transition = handoff;
      if (transition !== undefined) await transition;
      return await active.call(request);
    },
    credentialUpdated: async (server) => {
      const failure = terminalFailure;
      if (failure !== undefined) throw toError(failure);
      const transition = handoff;
      if (transition !== undefined) await transition;
      await active.credentialUpdated(server);
    },
    authorize: async (server) => {
      const failure = terminalFailure;
      if (failure !== undefined) throw toError(failure);
      const transition = handoff;
      if (transition !== undefined) await transition;
      return await active.authorize(server);
    },
    status: () => active.status(),
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    replaceServers,
    dispose,
  };
}

async function ignoreRejection(promise: Promise<unknown>): Promise<void> {
  try {
    await promise;
  } catch {
    // A public caller observes the same handoff promise when one is waiting.
  }
}

function toError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause));
}
