import { createHash } from "node:crypto";
import { Deferred, Effect, Exit, Fiber, Redacted, Scope } from "effect";
import type { McpConnectionStatusRow } from "../../../protocol/modules/mcp.js";
import type { McpServerConfig, McpServerRegistry } from "./config.js";
import { MCP_STARTUP_TIMEOUT_MS, redactMcpError, resolveMcpTemplate } from "./config.js";
import type { McpCallResult, McpConnection, McpConnectionOptions, McpToolHit } from "./connection.js";
import { createMcpCredentialStore, credentialKey, type McpCredential, type McpCredentialStore } from "./credentials.js";
import { McpNeedsAuthError, McpOAuthNeedsAuthError } from "./errors.js";
import type { McpOAuthAuthorization, McpPreregisteredClient } from "./oauth.js";
import { createMcpRegistryOwner } from "./registry-owner.js";

/** One connection attempt for one server, and the only authority over it: the
 *  cancellation signal every request of the attempt shares, the single startup
 *  deadline, the scope that owns its fiber and its connection finalizers, and
 *  the result every caller awaits. A server in `pending` or `ready` always has
 *  exactly one attempt, so a superseded or timed-out attempt settles its own
 *  waiters but can never publish server state again. */
interface McpAttempt {
  readonly deferred: Deferred.Deferred<McpConnection, Error>;
  readonly controller: AbortController;
  /** Epoch ms every startup request of this attempt shares. */
  readonly deadline: number;
  readonly scope: Scope.Closeable;
  /** Resolves once the attempt published its result and everything it started
   *  - connect, client close, scope finalizers - has settled. */
  readonly settled: Promise<void>;
  /** Set by the owner that retired this attempt. */
  cancelled: boolean;
}

/** The `tag` values must stay the wire's `McpServerStatus` set: every row
 *  build assigns `state.tag` to that stated union, so a state added here
 *  without a wire counterpart fails to compile at the row builder. */
type McpServerEntry =
  | { readonly tag: "pending"; readonly kind: "attempt"; readonly attempt: McpAttempt }
  | { readonly tag: "pending"; readonly kind: "transition"; readonly result: Promise<McpConnection> }
  | { readonly tag: "ready"; readonly attempt: McpAttempt; readonly connection: McpConnection }
  | { readonly tag: "failed"; readonly error: Error; readonly retryable: boolean }
  | { readonly tag: "needs_auth" }
  | { readonly tag: "disabled" };

const MCP_CONNECTION_FAILED_MESSAGE = "Connection failed. Check the server settings and try again.";

/** One tool call as the code projection makes it: the server beside what the connection's `callTool` takes. */
type McpCallRequest = Parameters<McpConnection["callTool"]>[0] & { readonly server: string };

export interface McpManager {
  /** Every configured server that is not disabled, whatever its connection state. */
  servers(): readonly string[];
  entries(): ReadonlyArray<{ readonly name: string; readonly state: McpServerEntry }>;
  acquire(server: string): Promise<McpConnection>;
  tools(): ReadonlyArray<McpToolHit>;
  /** Calls one tool on one server. A server that needs authentication or
   *  failed refuses with the repair the person can make; the raw failure
   *  never travels, so a credential in it never reaches a model. */
  call(request: McpCallRequest): Promise<McpCallResult>;
  credentialUpdated(server: string): Promise<void>;
  authorize(server: string): Promise<McpOAuthAuthorization>;
  status(): readonly McpConnectionStatusRow[];
  /** Observe status changes, including an empty replacement; read the current list with status(). */
  subscribe(listener: () => void): () => void;
  replaceServers(servers: McpServerRegistry): Promise<void>;
  dispose(): Promise<void>;
}

export type McpManagerResource = Omit<McpManager, "replaceServers">;

/** What a runner reaches through the module's handle: the catalog and the call, never a connection. */
export type McpPorts = Pick<McpManager, "servers" | "tools" | "call">;



type Environment = { readonly [K in string]: string | undefined };

type DiagnosticFields = { readonly [K in string]: unknown };

/** A short stable digest of a server name for diagnostics. */
function serverDigest(name: string): string {
  return createHash("sha256").update(name).digest("hex").slice(0, 12);
}

export interface McpManagerOptions {
  readonly servers: McpServerRegistry;
  readonly executionCwd: string;
  /** Account credential directory the OAuth credential store lives in. */
  readonly authDir: string;
  readonly env?: Environment;
  readonly log?: McpConnectionOptions["log"];
  readonly spawnOwned?: McpConnectionOptions["spawnOwned"];
  readonly connect?: (options: McpConnectionOptions) => Promise<McpConnection>;
  readonly startupTimeoutMs?: number;
  readonly credentialStore?: McpCredentialStore;
}

function createMcpManagerResource(options: McpManagerOptions): McpManagerResource {
  const states = new Map<string, McpServerEntry>();
  const running = new Set<McpAttempt>();
  const unsafe = new Map<McpAttempt, unknown>();
  const root = Scope.makeUnsafe("sequential");
  // The connection and OAuth code load the MCP SDK, so they load at the first
  // connection attempt rather than when the manager is built.
  const connect = options.connect ?? (async (connectionOptions: McpConnectionOptions) => (await import("./connection.js")).createMcpConnection(connectionOptions));
  const credentialStore = options.credentialStore ?? createMcpCredentialStore(options.authDir);
  const credentialLanes = createLanes();
  // One transition lane per server: a replacement is retire-then-start, and two
  // owners running that pair at once would each install one.
  const transitionLanes = createLanes();
  const listeners = new Set<() => void>();
  const timeoutMs = options.startupTimeoutMs ?? MCP_STARTUP_TIMEOUT_MS;
  let disposed = false;
  let disposeSettlement: Promise<void> | undefined;

  function statusRow(name: string, state: McpServerEntry): McpConnectionStatusRow {
    return {
      name,
      status: state.tag,
      toolCount: state.tag === "ready" ? state.connection.tools().length : 0,
      ...(state.tag === "failed" ? { error: MCP_CONNECTION_FAILED_MESSAGE, errorCode: "connection_failed" as const } : {}),
    };
  }

  /** Diagnostics and projections observe state. They never own it and cannot
   *  block an attempt's terminal result. */
  function report(message: string, fields?: DiagnosticFields): void {
    try {
      options.log?.(message, fields);
    } catch {
      // A diagnostic sink cannot participate in lifecycle settlement.
    }
  }

  function publishStatus(): void {
    for (const listener of listeners) {
      try {
        listener();
      } catch {
        report("MCP status listener failed", { errorCode: "listener_failed" });
      }
    }
  }

  function transition(name: string, next: McpServerEntry): void {
    const previous = states.get(name);
    if (previous === next) return;
    states.set(name, next);
    const row = statusRow(name, next);
    report("MCP state transition", {
      // A digest, not the name: a server name is authored config and can
      // carry a secret, and the digest still tells one server from another.
      server: serverDigest(name),
      from: previous?.tag ?? "unconfigured",
      to: next.tag,
      ...(row.errorCode === undefined ? {} : { errorCode: row.errorCode }),
    });
    publishStatus();
  }
  for (const [name, config] of Object.entries(options.servers)) {
    if (!config.enabled) {
      transition(name, { tag: "disabled" });
      continue;
    }
    startAttempt(name, config);
  }

  function attemptOf(name: string): McpAttempt | undefined {
    const state = states.get(name);
    if (state?.tag === "ready") return state.attempt;
    return state?.tag === "pending" && state.kind === "attempt" ? state.attempt : undefined;
  }

  /** True while `attempt` is still the published authority for `name`. Every
   *  transition an attempt or one of its connection callbacks makes is gated on
   *  this, so a retired attempt and a stale callback stay silent. */
  function publishable(name: string, attempt: McpAttempt): boolean {
    return !disposed && !attempt.cancelled && attemptOf(name) === attempt;
  }

  /** Publishes a fresh pending attempt for `name` and starts its work. A disposed
   *  manager owns no attempts, so every caller gates on `disposed` first and this
   *  throws rather than start work nothing will retire. */
  function startAttempt(name: string, config: McpServerConfig): McpAttempt {
    if (disposed) throw new Error(`MCP manager was disposed before '${name}' could connect`);
    const settlement = Promise.withResolvers<void>();
    void settlement.promise.catch(() => {});
    const attempt: McpAttempt = {
      deferred: Deferred.makeUnsafe<McpConnection, Error>(),
      controller: new AbortController(),
      deadline: Date.now() + timeoutMs,
      scope: Effect.runSync(Scope.fork(root)),
      settled: settlement.promise,
      cancelled: false,
    };
    running.add(attempt);
    transition(name, { tag: "pending", kind: "attempt", attempt });
    // Work starts on the next microtask, so neither constructing the manager
    // nor replacing a connection performs I/O inline.
    queueMicrotask(() => {
      void runAttempt(name, config, attempt).then(
        () => {
          running.delete(attempt);
          settlement.resolve();
        },
        (error: unknown) => {
          report("MCP attempt cleanup failed", { errorCode: "cleanup_failed" });
          settlement.reject(error);
        },
      );
    });
    return attempt;
  }

  async function runAttempt(name: string, config: McpServerConfig, attempt: McpAttempt): Promise<void> {
    if (attempt.controller.signal.aborted) {
      const cleanupFailure = await settleCleanup("attempt scope", () => Effect.runPromise(Scope.close(attempt.scope, Exit.void)));
      const error = cancellationError(name, attempt);
      Effect.runSync(Deferred.fail(attempt.deferred, cleanupFailure === undefined ? error : toError(cleanupFailure)));
      if (cleanupFailure !== undefined) throw cleanupFailure;
      return;
    }
    const work = connectWithCredentials(name, config, attempt);
    const fiber = Effect.runSync(Effect.forkIn(
      Effect.tryPromise({ try: () => work, catch: toError }),
      attempt.scope,
    ));
    let deadlineError: Error | undefined;
    let scopeSettlement: Promise<void> | null = null;
    const timer = setTimeout(() => {
      deadlineError = new Error(`MCP server '${name}' did not connect within ${timeoutMs}ms`);
      attempt.controller.abort(deadlineError);
      Effect.runFork(Fiber.interrupt(fiber));
      scopeSettlement ??= Effect.runPromise(Scope.close(attempt.scope, Exit.void));
    }, timeoutMs);
    await Effect.runPromise(Fiber.await(fiber));
    const outcome = await settleWork(work);
    const cleanupFailures: unknown[] = [];
    const closingScope = scopeSettlement;
    if (closingScope !== null) {
      const failure = await settleCleanup("attempt scope", () => closingScope);
      if (failure !== undefined) cleanupFailures.push(failure);
    }
    clearTimeout(timer);
    if (outcome.tag === "connected" && deadlineError === undefined && publishable(name, attempt)) {
      const connection = outcome.connection;
      Effect.runSync(Scope.addFinalizer(attempt.scope, Effect.promise(() => connection.close())));
      const ready = { tag: "ready", attempt, connection } as const;
      transition(name, ready);
      connection.onClose(() => {
        if (!publishable(name, attempt)) return;
        beginPublishedTransition(name, config, attempt, new Error(`MCP server '${name}' connection closed`), "restart");
      });
      connection.onToolsChanged((result) => {
        if (!publishable(name, attempt)) return;
        if (result.tag === "failure") {
          beginPublishedTransition(name, config, attempt, result.error, "fail");
          return;
        }
        report("MCP tools changed", { tools: result.tools.length });
        publishStatus();
      });
      Effect.runSync(Deferred.succeed(attempt.deferred, connection));
      return;
    }
    if (outcome.tag === "connected") {
      const failure = await settleCleanup("late connection", () => outcome.connection.close());
      if (failure !== undefined) cleanupFailures.push(failure);
    }
    if (scopeSettlement === null) {
      const failure = await settleCleanup("attempt scope", () => Effect.runPromise(Scope.close(attempt.scope, Exit.void)));
      if (failure !== undefined) cleanupFailures.push(failure);
    }
    const cause = deadlineError
      ?? (outcome.tag === "failed" ? outcome.error : cancellationError(name, attempt));
    const error = cleanupFailures.length === 0
      ? cause
      : new AggregateError(cleanupFailures, "MCP attempt cleanup failed");
    if (publishable(name, attempt)) {
      transition(name, cleanupFailures.length === 0 && (cause instanceof McpNeedsAuthError || cause instanceof McpOAuthNeedsAuthError)
        ? { tag: "needs_auth" }
        : { tag: "failed", error, retryable: cleanupFailures.length === 0 });
    }
    Effect.runSync(Deferred.fail(attempt.deferred, error));
    if (cleanupFailures.length > 0) throw error;
  }

  /** Records cleanup diagnostics while preserving failure as a terminal unsafe
   *  outcome for the owner that must decide whether replacement is safe. */
  async function settleCleanup(owner: string, cleanup: () => Promise<void>): Promise<Error | undefined> {
    try {
      await cleanup();
      return undefined;
    } catch (error) {
      report("MCP attempt cleanup failed", { owner, errorCode: "cleanup_failed" });
      return toError(error);
    }
  }

  /** Cancels one attempt, aborts what it started, and joins its settlement. The
   *  caller owns the replacement state. */
  async function retireAttempt(attempt: McpAttempt, reason: Error): Promise<void> {
    attempt.cancelled = true;
    // Abort cancels startup work only. A published connection is closed by its
    // scope finalizer instead, so its transport shuts down gracefully.
    if (running.has(attempt)) attempt.controller.abort(reason);
    const settlements = await Promise.allSettled([
      Effect.runPromise(Scope.close(attempt.scope, Exit.void)),
      attempt.settled,
    ]);
    const failures = settlements
      .filter((result): result is PromiseRejectedResult => result.status === "rejected")
      .map((result) => result.reason);
    if (failures.length > 0) {
      const failure = new AggregateError(failures, "MCP attempt retirement failed");
      unsafe.set(attempt, failure);
      throw failure;
    }
  }

  function beginPublishedTransition(
    name: string,
    config: McpServerConfig,
    attempt: McpAttempt | undefined,
    reason: Error,
    outcome: "restart" | "fail" | "needs_auth",
  ): Promise<McpConnection> {
    const result = transitionLanes.run(name, undefined, async () => {
      if (attempt !== undefined) await retireAttempt(attempt, reason);
      const current = states.get(name);
      if (disposed || current?.tag !== "pending" || current.kind !== "transition" || current.result !== result) {
        throw reason;
      }
      if (outcome === "fail") {
        transition(name, { tag: "failed", error: reason, retryable: true });
        throw reason;
      }
      if (outcome === "needs_auth") {
        transition(name, { tag: "needs_auth" });
        throw reason;
      }
      return await Effect.runPromise(Deferred.await(startAttempt(name, config).deferred));
    });
    transition(name, { tag: "pending", kind: "transition", result });
    void result.catch((cause: unknown) => {
      const current = states.get(name);
      if (!disposed && current?.tag === "pending" && current.kind === "transition" && current.result === result) {
        transition(name, { tag: "failed", error: toError(cause), retryable: cause === reason });
      }
    });
    return result;
  }

  async function connectWithCredentials(
    name: string,
    config: McpServerConfig,
    attempt: McpAttempt,
  ): Promise<McpConnection> {
    const signal = attempt.controller.signal;
    const connectionOptions: McpConnectionOptions = {
      server: name,
      config,
      executionCwd: options.executionCwd,
      env: options.env,
      log: report,
      signal,
      startupDeadline: attempt.deadline,
      spawnOwned: options.spawnOwned,
    };
    if (config.url === undefined) return await connect(connectionOptions);
    const url = Redacted.value(resolveMcpTemplate(config.url, options.env ?? process.env));
    const key = credentialKey(name, url);
    return await credentialLanes.run(key, signal, async () => {
      const credential = credentialStore.get(name, url);
      const stored: Pick<McpConnectionOptions, "storedHeaders" | "secrets"> = credential?.headers === undefined ? {} : {
        storedHeaders: credential.headers,
        secrets: Object.values(credential.headers),
      };
      if (credential?.tokens === undefined) {
        return httpConnection(name, await connect({ ...connectionOptions, ...stored }));
      }
      const { createSilentMcpOAuth } = await import("./oauth.js");
      const oauth = createSilentMcpOAuth(name, url, credentialStore, credential, preregisteredClient(config, credential));
      try {
        await oauth.refreshIfNeeded(signal);
      } catch (error) {
        if (error instanceof McpOAuthNeedsAuthError) throw error;
        throw redactMcpError(error, oauth.secrets);
      }
      for (const secret of stored.secrets ?? []) {
        if (!oauth.secrets.some((known) => Redacted.value(known) === Redacted.value(secret))) oauth.secrets.push(secret);
      }
      // The OAuth secret list is shared, not copied: a token the SDK refreshes
      // mid-session must be redacted from output the connection produces after
      // that refresh.
      return httpConnection(
        name,
        await connect({
          ...connectionOptions,
          ...stored,
          authProvider: oauth.provider,
          secrets: oauth.secrets,
        }),
        key,
      );
    });
  }

  function httpConnection(name: string, connection: McpConnection, oauthCredentialKey?: string): McpConnection {
    const wrapped: McpConnection = {
      instructions: connection.instructions,
      tools: () => connection.tools(),
      callTool: async (input) => {
        try {
          // The SDK can refresh and persist OAuth credentials during a tool call.
          return await (oauthCredentialKey === undefined
            ? connection.callTool(input)
            : credentialLanes.run(oauthCredentialKey, input.signal, () => connection.callTool(input)));
        } catch (error) {
          const state = states.get(name);
          if (error instanceof McpNeedsAuthError && state?.tag === "ready" && state.connection === wrapped) {
            try {
              await beginPublishedTransition(name, requireConfig(name), state.attempt, error, "needs_auth");
            } catch (retirementError) {
              if (retirementError !== error) throw retirementError;
            }
          }
          throw error;
        }
      },
      onClose: (callback) => connection.onClose(callback),
      onToolsChanged: (callback) => connection.onToolsChanged(callback),
      close: () => connection.close(),
    };
    return wrapped;
  }

  function requireConfig(server: string): McpServerConfig {
    const config = options.servers[server];
    if (!config) throw new Error(`MCP server not found: ${server}`);
    return config;
  }

  /** Publishes one transition before retirement starts. Every concurrent update
   *  or acquisition then joins that same retire-and-replace settlement. */
  async function credentialUpdated(server: string): Promise<void> {
    const config = requireConfig(server);
    if (disposed) return;
    const current = states.get(server);
    if (current === undefined || current.tag === "disabled") return;
    if (current.tag === "pending" && current.kind === "transition") {
      await current.result;
      return;
    }
    if (current.tag === "failed" && !current.retryable) throw current.error;
    const reason = new Error(`MCP server '${server}' credentials changed`);
    const attempt = current.tag === "pending" || current.tag === "ready" ? current.attempt : undefined;
    try {
      await beginPublishedTransition(server, config, attempt, reason, "restart");
    } catch (error) {
      if (!disposed || error !== reason) throw error;
    }
  }

  const dispose = (): Promise<void> => {
    disposeSettlement ??= disposeResource();
    return disposeSettlement;
  };

  async function disposeResource(): Promise<void> {
    if (disposed) return;
    disposed = true;
    const reason = new Error("MCP manager disposed");
    const knownUnsafe = [...unsafe.values()];
    const settlements = await Promise.allSettled([...running].filter((attempt) => !unsafe.has(attempt)).map((attempt) => retireAttempt(attempt, reason)));
    let rootFailure: unknown;
    try {
      await Effect.runPromise(Scope.close(root, Exit.void));
    } catch (error) {
      rootFailure = error;
    }
    states.clear();
    listeners.clear();
    running.clear();
    unsafe.clear();
    const failures = [
      ...knownUnsafe,
      ...settlements
        .filter((result): result is PromiseRejectedResult => result.status === "rejected")
        .map((result) => result.reason),
    ];
    if (rootFailure !== undefined) failures.push(rootFailure);
    if (failures.length > 0) throw new AggregateError(failures, "MCP resource disposal failed");
  }

  async function acquire(server: string): Promise<McpConnection> {
    const config = requireConfig(server);
    const state = states.get(server);
    if (!state) throw new Error(`MCP server not found: ${server}`);
    if (state.tag === "ready") return state.connection;
    if (state.tag === "disabled") throw new Error(`MCP server '${server}' is disabled`);
    if (state.tag === "needs_auth") throw new Error(`MCP server '${server}' needs authentication`);
    if (state.tag === "pending" && state.kind === "transition") return await state.result;
    if (state.tag === "failed" && !state.retryable) throw state.error;
    const attempt = state.tag === "failed" ? startAttempt(server, config) : state.attempt;
    return await Effect.runPromise(Deferred.await(attempt.deferred));
  }

  return {
    servers: () => [...states].flatMap(([name, state]) => state.tag === "disabled" ? [] : [name]),
    entries: () => [...states].map(([name, state]) => ({ name, state })),
    status: () => [...states].map(([name, state]) => statusRow(name, state)),
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    acquire,
    async call({ server, ...request }) {
      const state = states.get(server)?.tag;
      if (state === "needs_auth") throw new Error(`MCP server '${server}' needs authentication; ask the user to run /mcp and reauthenticate it`);
      if (state === "failed") throw new Error(`MCP server '${server}' failed to connect; ask the user to run /mcp and reconnect it`);
      return await (await acquire(server)).callTool(request);
    },
    tools: () => [...states.values()].flatMap((state) => state.tag === "ready" ? [...state.connection.tools()] : []),
    credentialUpdated,
    async authorize(server) {
      const config = requireConfig(server);
      if (config.url === undefined) throw new Error(`MCP server '${server}' does not use HTTP`);
      const url = Redacted.value(resolveMcpTemplate(config.url, options.env ?? process.env));
      const { authorizeMcpServer } = await import("./oauth.js");
      const authorization = await authorizeMcpServer({
        server,
        url,
        credentialStore,
        client: preregisteredClient(config, credentialStore.get(server, url)),
        ...(config.oauth?.scope === undefined ? {} : { scope: config.oauth.scope }),
        ...(config.oauth?.callback_port === undefined ? {} : { callbackPort: config.oauth.callback_port }),
      });
      const key = credentialKey(server, url);
      return {
        ...authorization,
        complete: () => credentialLanes.run(key, undefined, authorization.complete),
      };
    },
    dispose,
  };
}

/** The configured `oauth.client_id` with the secret stored for it, or nothing when
 *  the server relies on dynamic client registration. */
function preregisteredClient(config: McpServerConfig, credential: McpCredential | undefined): McpPreregisteredClient | undefined {
  const clientId = config.oauth?.client_id;
  if (clientId === undefined) return undefined;
  return { clientId, ...(credential?.clientSecret === undefined ? {} : { clientSecret: credential.clientSecret }) };
}

export function createMcpManager(options: McpManagerOptions): McpManager {
  return createMcpRegistryOwner(options, createMcpManagerResource);
}

type McpWorkOutcome =
  | { readonly tag: "connected"; readonly connection: McpConnection }
  | { readonly tag: "failed"; readonly error: Error };

async function settleWork(work: Promise<McpConnection>): Promise<McpWorkOutcome> {
  try {
    return { tag: "connected", connection: await work };
  } catch (cause) {
    return { tag: "failed", error: toError(cause) };
  }
}

/** The reason the attempt was aborted, so a waiter learns why its attempt was
 *  retired rather than a generic cancellation. */
function cancellationError(name: string, attempt: McpAttempt): Error {
  const reason: unknown = attempt.controller.signal.reason;
  return reason instanceof Error ? reason : new Error(`MCP server '${name}' connection attempt was superseded`);
}

function toError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause));
}

interface Lanes {
  /** Runs `operation` with exclusive access to `key`. A waiter still queued when
   *  `signal` aborts leaves the queue and rejects with the abort reason, so a
   *  cancelled attempt never holds the lane; admitted work keeps the lane until
   *  it settles even when it ignores the abort, because admitted work - a
   *  credential save, a server transition - must never be torn in half. */
  run<T>(key: string, signal: AbortSignal | undefined, operation: () => Promise<T>): Promise<T>;
}

interface Lane {
  readonly waiting: Array<{ readonly admit: () => void; readonly reject: (reason: Error) => void }>;
  admitted: boolean;
}

function createLanes(): Lanes {
  const lanes = new Map<string, Lane>();

  function drain(lane: Lane): void {
    if (lane.admitted) return;
    const next = lane.waiting.shift();
    if (next === undefined) return;
    lane.admitted = true;
    next.admit();
  }

  function admit(lane: Lane, signal: AbortSignal | undefined): Promise<void> {
    if (signal?.aborted === true) return Promise.reject(abortReason(signal));
    const admission = Promise.withResolvers<void>();
    const waiter = { admit: admission.resolve, reject: admission.reject };
    lane.waiting.push(waiter);
    if (signal !== undefined) {
      const onAbort = (): void => {
        const queued = lane.waiting.indexOf(waiter);
        if (queued < 0) return;
        lane.waiting.splice(queued, 1);
        waiter.reject(abortReason(signal));
      };
      signal.addEventListener("abort", onAbort, { once: true });
      const forget = (): void => signal.removeEventListener("abort", onAbort);
      admission.promise.then(forget, forget);
    }
    drain(lane);
    return admission.promise;
  }

  return {
    async run(key, signal, operation) {
      const lane = lanes.get(key) ?? { waiting: [], admitted: false };
      lanes.set(key, lane);
      let admitted = false;
      try {
        await admit(lane, signal);
        admitted = true;
        return await operation();
      } finally {
        if (admitted) {
          lane.admitted = false;
          drain(lane);
        }
        if (!lane.admitted && lane.waiting.length === 0) lanes.delete(key);
      }
    },
  };
}

function abortReason(signal: AbortSignal): Error {
  const reason: unknown = signal.reason;
  return reason instanceof Error ? reason : new Error("credential lane wait was cancelled");
}
