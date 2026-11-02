import { describe, expect, it } from "bun:test";
import { Redacted } from "effect";
import type { McpConnection, McpConnectionOptions } from "../../../../../src/orchestration/modules/mcp/connection.js";
import type { McpCredentialStore } from "../../../../../src/orchestration/modules/mcp/credentials.js";
import { createMcpManager } from "../../../../../src/orchestration/modules/mcp/manager.js";
import { McpNeedsAuthError, McpOAuthNeedsAuthError } from "../../../../../src/orchestration/modules/mcp/errors.js";
import { AUTH_DIR, fakeConnection, settlement } from "./_manager-fixtures.js";

function gatedConnection(): McpConnection & { calls: string[]; release(): void } {
  const gate = Promise.withResolvers<void>();
  const calls: string[] = [];
  return {
    instructions: undefined,
    tools: () => [],
    async callTool(input) {
      calls.push(input.name);
      await gate.promise;
      return { content: [], isError: false };
    },
    onClose() {},
    onToolsChanged() {},
    async close() {},
    calls,
    release: () => gate.resolve(),
  };
}

describe("MCP manager", () => {
  it("connects eagerly without blocking construction, retains disabled entries, and names only enabled servers", async () => {
    let connects = 0;
    const connection = fakeConnection();
    const manager = createMcpManager({
      executionCwd: "/scratch",
      authDir: AUTH_DIR,
      servers: {
        active: { command: "bun", args: [], env: {}, enabled: true },
        off: { command: "bun", args: [], env: {}, enabled: false },
      },
      connect: async () => { connects++; return connection; },
    });

    expect(connects).toBe(0);
    expect(manager.entries().find((entry) => entry.name === "off")?.state.tag).toBe("disabled");
    // A server still connecting is named, so the catalog lists it before its tools arrive.
    expect(manager.entries().find((entry) => entry.name === "active")?.state.tag).toBe("pending");
    expect(manager.servers()).toEqual(["active"]);
    await Promise.resolve();
    await manager.acquire("active");
    expect(connects).toBe(1);
    expect(manager.entries().find((entry) => entry.name === "active")?.state.tag).toBe("ready");
    await manager.dispose();
    expect(connection.closed()).toBe(true);
  });

  it("shares one pending reacquisition after failure", async () => {
    let connects = 0;
    let release = (_connection: McpConnection): void => {};
    const manager = createMcpManager({
      executionCwd: "/scratch",
      authDir: AUTH_DIR,
      servers: { test: { command: "bun", args: [], env: {}, enabled: true } },
      startupTimeoutMs: 1_000,
      connect: async () => {
        connects++;
        if (connects === 1) throw new Error("first failure");
        return await new Promise<McpConnection>((resolve) => { release = resolve; });
      },
    });

    await waitForState(manager, "failed");
    const first = manager.acquire("test");
    const second = manager.acquire("test");
    await Promise.resolve();
    expect(connects).toBe(2);
    const connection = fakeConnection();
    release(connection);
    expect(await first).toBe(connection);
    expect(await second).toBe(connection);
    await manager.dispose();
  });

  it("moves a closed ready connection to pending and ignores stale callbacks", async () => {
    const connections = [fakeConnection(), fakeConnection()];
    let index = 0;
    const manager = createMcpManager({
      executionCwd: "/scratch",
      authDir: AUTH_DIR,
      servers: { test: { command: "bun", args: [], env: {}, enabled: true } },
      connect: async () => {
        const connection = connections[index];
        index++;
        if (!connection) throw new Error("unexpected connection attempt");
        return connection;
      },
    });

    const first = await manager.acquire("test");
    connections[0]?.disconnect();
    expect(manager.entries()[0]?.state.tag).toBe("pending");
    const second = await manager.acquire("test");
    expect(second).not.toBe(first);
    connections[0]?.disconnect();
    expect(manager.entries()[0]?.state.tag).toBe("ready");
    await manager.dispose();
  });

  it("reconnects only the credential-updated server", async () => {
    const connections = new Map<string, McpConnection[]>([
      ["a", [fakeConnection(), fakeConnection()]],
      ["b", [fakeConnection()]],
    ]);
    const manager = createMcpManager({
      executionCwd: "/scratch",
      authDir: AUTH_DIR,
      servers: {
        a: { command: "bun", args: [], env: {}, enabled: true },
        b: { command: "bun", args: [], env: {}, enabled: true },
      },
      connect: async ({ server }) => {
        const connection = connections.get(server)?.shift();
        if (connection === undefined) throw new Error("unexpected connection attempt");
        return connection;
      },
    });
    await Promise.all([manager.acquire("a"), manager.acquire("b")]);
    const before = new Map(manager.entries().map((entry) => [entry.name, entry.state]));

    await manager.credentialUpdated("a");

    const after = new Map(manager.entries().map((entry) => [entry.name, entry.state]));
    expect(after.get("a")).not.toBe(before.get("a"));
    expect(after.get("b")).toBe(before.get("b"));
    expect(after.get("a")?.tag).toBe("ready");
    await manager.dispose();
  });

  it("merges stored headers with OAuth secrets in the connection options", async () => {
    let seen: McpConnectionOptions | undefined;
    const credentialStore: McpCredentialStore = {
      get: () => ({
        headers: { CONTEXT7_API_KEY: Redacted.make("stored-key") },
        tokens: {
          accessToken: Redacted.make("access-token"),
          refreshToken: Redacted.make("refresh-token"),
          tokenType: "Bearer",
          expiresAt: Date.now() + 60_000,
        },
      }),
      save: async () => {},
      delete: async () => {},
    };
    const manager = createMcpManager({
      executionCwd: "/scratch",
      authDir: AUTH_DIR,
      servers: { context7: { url: "https://mcp.example", headers: {}, enabled: true } },
      credentialStore,
      connect: async (options) => { seen = options; return fakeConnection(); },
    });

    await manager.acquire("context7");
    expect(seen?.storedHeaders === undefined ? undefined : Redacted.value(seen.storedHeaders.CONTEXT7_API_KEY ?? Redacted.make(""))).toBe("stored-key");
    expect(seen?.secrets?.map(Redacted.value)).toEqual(["access-token", "refresh-token", "stored-key"]);
    await manager.dispose();
  });

  describe.each([
    ["no credentials", {}, undefined],
    ["configured static headers", { KEY: "configured-key" }, undefined],
    ["stored static headers", {}, { headers: { KEY: Redacted.make("stored-key") } }],
  ] as const)("HTTP with %s", (_label, headers, credential) => {
    it("admits both parallel tool calls before either remote call settles", async () => {
      const connection = gatedConnection();
      const manager = createMcpManager({
        executionCwd: "/scratch",
        authDir: AUTH_DIR,
        servers: { http: { url: "https://mcp.example", headers, enabled: true } },
        credentialStore: {
          get: () => credential,
          save: async () => {},
          delete: async () => {},
        },
        connect: async (options) => {
          expect(options.authProvider).toBeUndefined();
          expect(options.storedHeaders).toEqual(credential?.headers);
          return connection;
        },
      });
      const acquired = await manager.acquire("http");
      const calls = Promise.all([
        acquired.callTool({ name: "first" }),
        acquired.callTool({ name: "second" }),
      ]);

      try {
        await Promise.resolve();
        expect(connection.calls).toEqual(["first", "second"]);
      } finally {
        connection.release();
        await calls;
        await manager.dispose();
      }
    });

    it("retires the connection when parallel calls need authentication", async () => {
      const connection = fakeConnection();
      const error = new McpNeedsAuthError("http");
      const manager = createMcpManager({
        executionCwd: "/scratch",
        authDir: AUTH_DIR,
        servers: { http: { url: "https://mcp.example", headers, enabled: true } },
        credentialStore: {
          get: () => credential,
          save: async () => {},
          delete: async () => {},
        },
        connect: async () => ({
          ...connection,
          callTool: async () => { throw error; },
        }),
      });

      try {
        const acquired = await manager.acquire("http");
        await Promise.all([
          expect(acquired.callTool({ name: "first" })).rejects.toBe(error),
          expect(acquired.callTool({ name: "second" })).rejects.toBe(error),
        ]);
        expect(manager.status()[0]?.status).toBe("needs_auth");
        expect(connection.closed()).toBe(true);
      } finally {
        await manager.dispose();
      }
    });
  });

  it("publishes one shared startup timeout only after the aborted attempt settles", async () => {
    const work = Promise.withResolvers<McpConnection>();
    const timedOut = Promise.withResolvers<void>();
    const manager = createMcpManager({
      executionCwd: "/scratch",
      authDir: AUTH_DIR,
      servers: { test: { command: "bun", args: [], env: {}, enabled: true } },
      startupTimeoutMs: 10,
      connect: async ({ signal }) => {
        signal.addEventListener("abort", () => timedOut.resolve(), { once: true });
        return await work.promise;
      },
    });

    const acquired = manager.acquire("test");
    // Wait for the timeout itself: a fixed sleep loses to a late timer on a loaded machine.
    await timedOut.promise;

    expect(await settlement(acquired, 5)).toBe("pending");
    expect(manager.entries()[0]?.state.tag).toBe("pending");

    work.reject(new Error("connect gave up"));

    expect(await settlement(acquired, 20)).toBe("MCP server 'test' did not connect within 10ms");
    expect(manager.entries()[0]?.state.tag).toBe("failed");
    await manager.dispose();
  });

  it.each(["initial", "replacement"])("reports unsafe settlement when a timed-out %s connection cannot close", async (placement) => {
    const work = Promise.withResolvers<McpConnection>();
    const timedOut = Promise.withResolvers<void>();
    let closeAttempted = false;
    let connects = 0;
    const connection: McpConnection = {
      ...fakeConnection(),
      close: async () => {
        closeAttempted = true;
        throw new Error("late close failed");
      },
    };
    const manager = createMcpManager({
      executionCwd: "/scratch",
      authDir: AUTH_DIR,
      servers: placement === "initial" ? { test: { command: "bun", args: [], env: {}, enabled: true } } : {},
      startupTimeoutMs: 10,
      connect: async ({ signal }) => {
        connects++;
        signal.addEventListener("abort", () => timedOut.resolve(), { once: true });
        return await work.promise;
      },
      log: (message) => { if (message === "MCP attempt cleanup failed") throw new Error("diagnostics failed"); },
    });

    const acquired = placement === "initial"
      ? manager.acquire("test")
      : manager.replaceServers({ test: { command: "bun", args: [], env: {}, enabled: true } });
    await timedOut.promise;
    work.resolve(connection);

    expect(await settlement(acquired, 30)).toBe(placement === "initial" ? "MCP attempt cleanup failed" : "MCP candidate warmup failed");
    expect(closeAttempted).toBe(true);
    if (placement === "initial") {
      expect(manager.entries()[0]?.state.tag).toBe("failed");
    } else {
      expect(manager.status()).toEqual([]);
      await expect(manager.replaceServers({ next: { command: "next", args: [], env: {}, enabled: true } })).rejects.toThrow("MCP candidate warmup failed");
      expect(connects).toBe(1);
    }
    expect(await settlement(manager.dispose(), 30)).toBe("MCP manager disposal failed");
  });

  it("lets one superseded attempt settle its waiters without publishing state", async () => {
    const stale = fakeConnection();
    const fresh = fakeConnection();
    const held = Promise.withResolvers<McpConnection>();
    let connects = 0;
    const manager = createMcpManager({
      executionCwd: "/scratch",
      authDir: AUTH_DIR,
      servers: { test: { command: "bun", args: [], env: {}, enabled: true } },
      startupTimeoutMs: 1_000,
      connect: async ({ signal }) => {
        connects++;
        if (connects > 1) return fresh;
        // Abort-ignoring work: it still produces a connection the retired
        // attempt owns and must close.
        signal.addEventListener("abort", () => held.resolve(stale));
        return await held.promise;
      },
    });

    const superseded = manager.acquire("test");
    await Bun.sleep(1);
    await manager.credentialUpdated("test");

    expect(manager.entries()[0]?.state.tag).toBe("ready");
    expect(await manager.acquire("test")).toBe(fresh);
    expect(stale.closed()).toBe(true);
    expect(await settlement(superseded, 20)).toContain("credentials changed");
    await manager.dispose();
  });

  it("drops a cancelled OAuth credential-lane waiter and keeps admitted work", async () => {
    const connection = gatedConnection();
    const credentialStore: McpCredentialStore = {
      get: () => ({
        tokens: {
          accessToken: Redacted.make("access-token"),
          refreshToken: Redacted.make("refresh-token"),
          tokenType: "Bearer",
          expiresAt: Date.now() + 60_000,
        },
      }),
      save: async () => {},
      delete: async () => {},
    };
    const manager = createMcpManager({
      executionCwd: "/scratch",
      authDir: AUTH_DIR,
      servers: { http: { url: "https://mcp.example", headers: {}, enabled: true } },
      credentialStore,
      connect: async () => connection,
    });

    const acquired = await manager.acquire("http");
    const admitted = acquired.callTool({ name: "first" });
    await Bun.sleep(1);
    const controller = new AbortController();
    const queued = acquired.callTool({ name: "second", signal: controller.signal });
    controller.abort(new Error("caller gave up"));

    expect(await settlement(queued, 10)).toBe("caller gave up");
    expect(connection.calls).toEqual(["first"]);

    connection.release();

    expect((await admitted).isError).toBe(false);
    await manager.dispose();
  });

  it("joins two concurrent credential updates to one replacement", async () => {
    const opened: Array<(connection: McpConnection) => void> = [];
    let inFlight = 0;
    let peak = 0;
    const manager = createMcpManager({
      executionCwd: "/scratch",
      authDir: AUTH_DIR,
      servers: { test: { command: "bun", args: [], env: {}, enabled: true } },
      startupTimeoutMs: 1_000,
      connect: async () => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        try {
          return await new Promise<McpConnection>((resolve) => { opened.push(resolve); });
        } finally {
          inFlight--;
        }
      },
    });

    await waitFor(() => opened.length === 1, "first connect started");
    opened[0]?.(fakeConnection());
    await manager.acquire("test");

    const first = manager.credentialUpdated("test");
    const second = manager.credentialUpdated("test");
    await waitFor(() => opened.length >= 2, "replacement started");
    expect(opened).toHaveLength(2);

    opened[1]?.(fakeConnection());
    expect(await settlement(first, 20)).toBe("resolved");
    expect(await settlement(second, 20)).toBe("resolved");
    expect(peak).toBe(1);
    expect(manager.entries()[0]?.state.tag).toBe("ready");
    await manager.dispose();
  });

  it("starts no replacement when dispose wins the credential update", async () => {
    const closing = Promise.withResolvers<void>();
    let closeCalls = 0;
    let connects = 0;
    const manager = createMcpManager({
      executionCwd: "/scratch",
      authDir: AUTH_DIR,
      servers: { test: { command: "bun", args: [], env: {}, enabled: true } },
      startupTimeoutMs: 1_000,
      connect: async () => {
        connects++;
        return {
          instructions: undefined,
          tools: () => [],
          callTool: async () => ({ content: [], isError: false }),
          onClose() {},
          onToolsChanged() {},
          close: async () => {
            closeCalls++;
            await closing.promise;
          },
        };
      },
    });

    await manager.acquire("test");
    const update = manager.credentialUpdated("test");
    await waitFor(() => closeCalls === 1, "retirement started closing the connection");

    const disposing = manager.dispose();
    closing.resolve();

    expect(await settlement(update, 50)).toBe("resolved");
    await disposing;
    expect(connects).toBe(1);
  });

  it("retires the prior registry before publishing its ready replacement", async () => {
    const calls: string[] = [];
    const manager = createMcpManager({
      executionCwd: "/scratch",
      authDir: AUTH_DIR,
      servers: { old: { command: "old", args: [], env: {}, enabled: true } },
      connect: async ({ config }) => {
        const command = config.command ?? "unknown";
        calls.push(`open:${command}`);
        const connection = fakeConnection();
        return { ...connection, close: async () => { calls.push(`close:${command}`); connection.disconnect(); } };
      },
    });
    await manager.acquire("old");
    await manager.replaceServers({ next: { command: "next", args: [], env: {}, enabled: true } });
    expect(manager.entries().map((entry) => entry.name)).toEqual(["next"]);
    expect(calls).toEqual(["open:old", "open:next", "close:old"]);
    await manager.dispose();
  });

  it.each([
    { status: "needs_auth", error: new McpOAuthNeedsAuthError() },
    { status: "failed", error: new Error("server unavailable") },
  ])("retires the prior registry before publishing its $status replacement alongside a healthy server", async ({ status, error }) => {
    const calls: string[] = [];
    let authorized = false;
    const manager = createMcpManager({
      executionCwd: "/scratch",
      authDir: AUTH_DIR,
      servers: { old: { command: "old", args: [], env: {}, enabled: true } },
      connect: async ({ config }) => {
        const command = config.command ?? "unknown";
        calls.push(`open:${command}`);
        if (command === "next" && !authorized) throw error;
        const connection = fakeConnection();
        return { ...connection, close: async () => { calls.push(`close:${command}`); connection.disconnect(); } };
      },
    });
    await manager.acquire("old");
    manager.subscribe(() => {
      const row = manager.status().find((current) => current.name === "next");
      if (row?.status === status) calls.push(`publish:${status}`);
    });

    await manager.replaceServers({
      next: { command: "next", args: [], env: {}, enabled: true },
      healthy: { command: "healthy", args: [], env: {}, enabled: true },
    });
    expect(manager.status()).toMatchObject([
      { name: "next", status, toolCount: 0 },
      { name: "healthy", status: "ready", toolCount: 0 },
    ]);
    expect(calls).toEqual(["open:old", "open:next", "open:healthy", "close:old", `publish:${status}`]);

    authorized = true;
    await manager.credentialUpdated("next");
    expect(manager.status()).toEqual([
      { name: "next", status: "ready", toolCount: 0 },
      { name: "healthy", status: "ready", toolCount: 0 },
    ]);
    await manager.replaceServers({ later: { command: "later", args: [], env: {}, enabled: true } });
    expect(manager.status()).toEqual([{ name: "later", status: "ready", toolCount: 0 }]);
    await manager.dispose();
  });

  it("does not rebuild an unchanged server registry", async () => {
    let connects = 0;
    const servers = { test: { command: "bun", args: [], env: {}, enabled: true } };
    const manager = createMcpManager({
      executionCwd: "/scratch",
      authDir: AUTH_DIR,
      servers,
      connect: async () => {
        connects++;
        return fakeConnection();
      },
    });

    await manager.acquire("test");
    await manager.replaceServers({ test: { command: "bun", args: [], env: {}, enabled: true } });

    expect(connects).toBe(1);
    await manager.dispose();
  });

  it("replaces HTTP connections when only OAuth options change", async () => {
    let connects = 0;
    const connections: ReturnType<typeof fakeConnection>[] = [];
    const manager = createMcpManager({
      executionCwd: "/scratch",
      authDir: AUTH_DIR,
      servers: { test: { url: "https://example.test/mcp", headers: {}, enabled: true, oauth: { client_id: "old" } } },
      connect: async () => {
        connects++;
        const connection = fakeConnection();
        connections.push(connection);
        return connection;
      },
    });
    try {
      await manager.acquire("test");
      await manager.replaceServers({ test: { url: "https://example.test/mcp", headers: {}, enabled: true, oauth: { client_id: "new" } } });
      expect(connects).toBe(2);
      expect(connections[0]?.closed()).toBe(true);
      await manager.replaceServers({ test: { url: "https://example.test/mcp", headers: {}, enabled: true, oauth: { client_id: "new" } } });
      expect(connects).toBe(2);
    } finally {
      await manager.dispose();
    }
  });
});

async function waitForState(manager: ReturnType<typeof createMcpManager>, tag: string): Promise<void> {
  await waitFor(() => manager.entries()[0]?.state.tag === tag, `state ${tag}`);
}

/** Polls a synchronous condition between microtask ticks, so a case gates on
 *  observable manager progress instead of on a timer. */
async function waitFor(condition: () => boolean, label: string): Promise<void> {
  for (let tick = 0; tick < 200; tick++) {
    if (condition()) return;
    await Bun.sleep(0);
  }
  throw new Error(`MCP manager condition not met: ${label}`);
}
