import { createHash } from "node:crypto";
import { describe, expect, it } from "bun:test";
import { createMcpManager } from "../../../../../src/orchestration/modules/mcp/manager.js";
import { AUTH_DIR, fakeConnection, settlement } from "./_manager-fixtures.js";

describe("MCP manager diagnostics", () => {
  it("settles a ready attempt even when a status subscriber throws", async () => {
    const connection = fakeConnection();
    const manager = createMcpManager({
      executionCwd: "/scratch",
      authDir: AUTH_DIR,
      servers: { test: { command: "bun", args: [], env: {}, enabled: true } },
      connect: async () => connection,
      log: (message) => { if (message === "MCP status listener failed") throw new Error("diagnostics failed"); },
    });
    manager.subscribe(() => { throw new Error("projection failed"); });

    expect(await settlement(manager.acquire("test"), 20)).toBe("resolved");
    expect(manager.entries()[0]?.state.tag).toBe("ready");
    await manager.dispose();
  });

  it("notifies every status subscriber when tools change and one subscriber throws", async () => {
    const connection = fakeConnection();
    const observed: string[] = [];
    const manager = createMcpManager({
      executionCwd: "/scratch",
      authDir: AUTH_DIR,
      servers: { test: { command: "bun", args: [], env: {}, enabled: true } },
      connect: async () => connection,
    });
    manager.subscribe(() => { throw new Error("projection failed"); });
    manager.subscribe(() => { for (const row of manager.status()) observed.push(row.status); });
    await manager.acquire("test");
    observed.length = 0;

    connection.toolsChanged();

    expect(observed).toEqual(["ready"]);
    await manager.dispose();
  });

  it("keeps connection and listener failures out of status and diagnostics", async () => {
    const secrets = [
      "secret-server-token",
      "query-token",
      "authorization-secret",
      "authored-command-secret",
      "authored-env-secret",
      "listener-secret",
    ];
    const diagnostics: Array<{ message: string; fields: unknown }> = [];
    const manager = createMcpManager({
      executionCwd: "/scratch",
      authDir: AUTH_DIR,
      servers: {
        "secret-server-token": {
          command: "authored-command-secret",
          args: ["https://example.test/mcp?token=query-token", "Authorization: authorization-secret"],
          env: { API_KEY: "authored-env-secret" },
          enabled: true,
        },
      },
      connect: async () => {
        throw new Error("https://example.test/mcp?token=query-token Authorization: authorization-secret authored-command-secret authored-env-secret");
      },
      log: (message, fields) => { diagnostics.push({ message, fields }); },
    });
    manager.subscribe(() => { throw new Error("listener-secret"); });

    await expect(manager.acquire("secret-server-token")).rejects.toThrow("query-token");

    expect(manager.status()).toEqual([{
      name: "secret-server-token",
      status: "failed",
      toolCount: 0,
      error: "Connection failed. Check the server settings and try again.",
      errorCode: "connection_failed",
    }]);
    const serializedDiagnostics = JSON.stringify(diagnostics);
    for (const secret of secrets) expect(serializedDiagnostics).not.toContain(secret);
    expect(diagnostics).toContainEqual({
      message: "MCP state transition",
      fields: { server: createHash("sha256").update("secret-server-token").digest("hex").slice(0, 12), from: "pending", to: "failed", errorCode: "connection_failed" },
    });
    expect(diagnostics).toContainEqual({
      message: "MCP status listener failed",
      fields: { errorCode: "listener_failed" },
    });
    await manager.dispose();
  });
});
