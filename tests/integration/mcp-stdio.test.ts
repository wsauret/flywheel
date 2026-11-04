import { afterAll, afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { McpManager } from "../../src/orchestration/modules/mcp/manager.js";
import { createMcpManager } from "../../src/orchestration/modules/mcp/manager.js";
import type { LauncherScope } from "../../src/infra/process-supervisor.js";
import { unguardedSpawnOwned } from "../helpers/real-process-fixture.js";

const AUTH_DIR = mkdtempSync(join(tmpdir(), "flywheel-mcp-stdio-"));

const SERVER_SOURCE = String.raw`
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const secret = process.env.MCP_SECRET ?? "";

// A SIGTERM-resistant descendant of the server, in the same container. The
// server exits on its own when the crash tool runs, so this descendant is what
// proves the container outlives its leader and is still ended: only the
// container's escalation removes it.
const child = Bun.spawn([process.execPath, "-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { stdout: "ignore", stderr: "ignore", windowsHide: true });
if (secret) {
  process.stderr.write("fixture secret " + secret.slice(0, Math.ceil(secret.length / 2)));
  await Bun.sleep(10);
  process.stderr.write(secret.slice(Math.ceil(secret.length / 2)) + "\n");
}
for (let i = 0; i < 4096; i++) process.stderr.write("fixture stderr payload ".repeat(16) + "\n");
const server = new Server(
  { name: "fixture", version: "1.0.0" },
  {
    capabilities: { tools: { listChanged: true } },
    instructions: secret ? "Use secret " + secret : undefined,
  },
);
server.setRequestHandler(ListToolsRequestSchema, () => ({
  tools: [
    { name: "child_pid", description: "Returns the descendant pid", inputSchema: { type: "object" } },
    { name: "crash", description: "Stops this server", inputSchema: { type: "object" } },
    ...(secret ? [
      { name: "secret", description: "Returns secret-bearing data", inputSchema: { type: "object" } },
      { name: "fail", description: "Returns a secret-bearing error", inputSchema: { type: "object" } },
    ] : []),
  ],
}));
server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
  if (request.params.name === "crash") {
    setTimeout(() => process.exit(0), 10);
    return { content: [{ type: "text", text: "crashing" }] };
  }
  if (request.params.name === "fail") throw new Error("fixture failure " + secret);
  if (request.params.name === "secret") {
    await extra.sendNotification({
      method: "notifications/progress",
      params: {
        progressToken: request.params._meta?.progressToken,
        progress: 1,
        total: 2,
        message: "progress " + secret,
      },
    });
    return {
      content: [
        { type: "text", text: "output " + secret + " literal-visible" },
        { type: "resource", resource: { uri: "file:///secret", text: "resource " + secret } },
      ],
      structuredContent: { nested: ["structured " + secret, { literal: "literal-visible" }] },
    };
  }
  return { content: [{ type: "text", text: String(child.pid) }] };
});
await server.connect(new StdioServerTransport());
`;

/** A server that answers `initialize` and one `tools/list` page, then never
 *  answers the next page, so startup blocks until the attempt deadline. It
 *  ignores SIGTERM and leaves a SIGTERM-resistant descendant in its group, so
 *  only a group SIGKILL removes the tree. */
const BLOCKED_SERVER_SOURCE = String.raw`
process.on("SIGTERM", () => {});
const child = Bun.spawn([process.execPath, "-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { stdout: "ignore", stderr: "ignore", windowsHide: true });
process.stderr.write("child " + child.pid + "\n");
const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
const decoder = new TextDecoder();
let buffered = "";
let pages = 0;
for await (const chunk of Bun.stdin.stream()) {
  buffered += decoder.decode(chunk, { stream: true });
  let newline = buffered.indexOf("\n");
  while (newline >= 0) {
    const line = buffered.slice(0, newline);
    buffered = buffered.slice(newline + 1);
    newline = buffered.indexOf("\n");
    if (!line.trim()) continue;
    const message = JSON.parse(line);
    if (message.method === "initialize") {
      reply(message.id, {
        protocolVersion: message.params.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: "blocked", version: "1.0.0" },
      });
    } else if (message.method === "tools/list" && pages++ === 0) {
      reply(message.id, { tools: [], nextCursor: "page-2" });
    }
  }
}
setInterval(() => {}, 1000);
`

let manager: McpManager | undefined;
/** Every pid a test started, swept after it whatever the assertions did. */
const strayPids = new Set<number>();

/** Real containers for the manager under test: cleanup is armed at launch, and
 *  every container pid is recorded so the assertions can prove it is gone. */
function trackedSpawn(launched: number[], onSettled?: () => void): LauncherScope["spawnOwned"] {
  return async (command, options) => {
    const owned = await unguardedSpawnOwned(300)(command, options);
    strayPids.add(owned.pid);
    launched.push(owned.pid);
    void owned.exited.then(() => onSettled?.());
    return owned;
  };
}

afterEach(async () => {
  await manager?.dispose();
  manager = undefined;
  for (const pid of strayPids) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // The lifecycle behavior under test can remove the process first.
    }
  }
  strayPids.clear();
});

afterAll(() => {
  rmSync(AUTH_DIR, { recursive: true, force: true });
});

describe("MCP stdio integration", () => {
  it("starts nonblocking, drains stderr, recovers after a kill, and terminates descendants", async () => {
    let stderrChunks = 0;
    const launched: number[] = [];
    manager = createMcpManager({
      executionCwd: process.cwd(),
      authDir: AUTH_DIR,
      servers: {
        fixture: {
          command: process.execPath,
          args: ["-e", SERVER_SOURCE],
          env: {},
          enabled: true,
        },
      },
      log: (message) => {
        if (message === "MCP server stderr") stderrChunks++;
      },
      spawnOwned: trackedSpawn(launched),
    });

    expect(manager.entries()[0]?.state.tag).toBe("pending");
    const first = await manager.acquire("fixture");
    expect(first.tools().map((tool) => tool.name)).toEqual(["child_pid", "crash"]);
    expect(stderrChunks).toBeGreaterThan(0);
    expect(launched).toHaveLength(1);

    const pidResult = await first.callTool({ name: "child_pid" });
    const pidPart = pidResult.content[0];
    if (!pidPart || pidPart.type !== "text") throw new Error("fixture did not return its child pid");
    const descendantPid = Number(pidPart.text);
    strayPids.add(descendantPid);
    expect(processExists(descendantPid)).toBe(true);

    await first.callTool({ name: "crash" });
    await waitFor(() => manager?.entries()[0]?.state.tag === "pending");
    await waitFor(() => !processExists(descendantPid));
    expect(processExists(launched[0] ?? 0)).toBe(false);
    const second = await manager.acquire("fixture");
    expect(second).not.toBe(first);
    expect(second.tools()).toHaveLength(2);

    const secondPidResult = await second.callTool({ name: "child_pid" });
    const secondPidPart = secondPidResult.content[0];
    if (!secondPidPart || secondPidPart.type !== "text") throw new Error("fixture did not return its second child pid");
    const secondDescendantPid = Number(secondPidPart.text);
    strayPids.add(secondDescendantPid);
    let disposed = false;
    const disposal = manager.dispose().then(() => { disposed = true; });
    await Bun.sleep(50);
    expect(disposed).toBe(false);
    await disposal;
    manager = undefined;
    expect(processExists(secondDescendantPid)).toBe(false);
    expect(launched).toHaveLength(2);
    for (const pid of launched) expect(processExists(pid)).toBe(false);
  }, 20_000);

  it("redacts substituted values from all MCP egress", async () => {
    const secret = "orchid::glass/river+731";
    const logs: Array<{ message: string; fields?: Readonly<{ [key: string]: unknown }> }> = [];
    manager = createMcpManager({
      executionCwd: process.cwd(),
      authDir: AUTH_DIR,
      env: { ...process.env, PHASE_ONE_SECRET: secret },
      servers: {
        fixture: {
          command: process.execPath,
          args: ["-e", SERVER_SOURCE, "literal-visible"],
          env: { MCP_SECRET: ["$", "{PHASE_ONE_SECRET}"].join("") },
          enabled: true,
        },
      },
      log: (message, fields) => logs.push({ message, fields }),
      spawnOwned: trackedSpawn([]),
    });

    const connection = await manager.acquire("fixture");
    expect(connection.instructions).toBe("Use secret [REDACTED]");

    const progress: Array<{ progress: number; total?: number; message?: string }> = [];
    const result = await connection.callTool({ name: "secret", onProgress: (item) => progress.push(item) });
    expect(progress).toEqual([{ progress: 1, total: 2, message: "progress [REDACTED]" }]);
    expect(result).toEqual({
      isError: false,
      content: [
        { type: "text", text: "output [REDACTED] literal-visible" },
        { type: "text", text: "resource [REDACTED]" },
      ],
      structuredContent: { nested: ["structured [REDACTED]", { literal: "literal-visible" }] },
    });

    let failure: unknown;
    try {
      await connection.callTool({ name: "fail" });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    expect(failure instanceof Error ? failure.message : "").toContain("fixture failure [REDACTED]");
    await waitFor(() => logs.some(({ fields }) => String(fields?.output).includes("[REDACTED]")));
    expect(JSON.stringify(logs)).not.toContain(secret);
    expect(JSON.stringify({ instructions: connection.instructions, progress, result, failure: String(failure) })).not.toContain(secret);
  }, 20_000);

  it("removes a blocked startup tree before it publishes the timeout, and retries with one container", async () => {
    const order: string[] = [];
    const launched: number[] = [];
    const descendants: number[] = [];
    manager = createMcpManager({
      executionCwd: process.cwd(),
      authDir: AUTH_DIR,
      servers: {
        blocked: {
          command: process.execPath,
          args: ["-e", BLOCKED_SERVER_SOURCE],
          env: {},
          enabled: true,
        },
      },
      startupTimeoutMs: 600,
      log: (message, fields) => {
        if (message !== "MCP server stderr") return;
        const descendant = /child (\d+)/.exec(String(fields?.output));
        if (descendant?.[1]) {
          descendants.push(Number(descendant[1]));
          strayPids.add(Number(descendant[1]));
        }
      },
      spawnOwned: trackedSpawn(launched, () => order.push("settled")),
    });
    const observedManager = manager;
    observedManager.subscribe(() => { for (const row of observedManager.status()) order.push(`status:${row.status}`); });

    await expect(manager.acquire("blocked")).rejects.toThrow("did not connect within 600ms");
    // The attempt publishes the timeout only after the connection scope closed,
    // and this transport settles its container inside that close.
    expect(order.indexOf("settled")).toBeGreaterThanOrEqual(0);
    expect(order.indexOf("settled")).toBeLessThan(order.indexOf("status:failed"));
    expect(launched).toHaveLength(1);
    expect(processExists(launched[0] ?? 0)).toBe(false);

    await expect(manager.acquire("blocked")).rejects.toThrow("did not connect within 600ms");

    expect(order.filter((event) => event === "settled")).toHaveLength(2);
    expect(launched).toHaveLength(2);
    for (const pid of launched) expect(processExists(pid)).toBe(false);
    expect(descendants).toHaveLength(2);
    for (const pid of descendants) expect(processExists(pid)).toBe(false);
  }, 20_000);
});

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return;
    await Bun.sleep(10);
  }
  throw new Error("condition did not become true");
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
