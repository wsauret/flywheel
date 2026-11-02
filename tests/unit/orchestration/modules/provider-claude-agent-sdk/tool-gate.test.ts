import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createToolGate } from "../../../../../src/orchestration/modules/provider-claude-agent-sdk/tool-gate.js";

const READ_SCHEMA = { type: "object" as const, properties: { path: { type: "string" } }, required: ["path"] };
const BASH_SCHEMA = { type: "object" as const, properties: { command: { type: "string" } } };
const TOOLS = [
  { name: "read", description: "Reads a file.", inputSchema: READ_SCHEMA },
  { name: "bash", description: "Runs a command.", inputSchema: BASH_SCHEMA },
];

/** The gate's server, reached as the CLI reaches it: through an MCP client over a linked transport. */
async function connectedGate() {
  const gate = createToolGate(TOOLS);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await gate.server.connect(serverSide);
  const client = new Client({ name: "claude-cli", version: "0.0.0" });
  await client.connect(clientSide);
  const call = (name: string, toolUseId: string) => client.callTool({ name, arguments: {}, _meta: { "claudecode/toolUseId": toolUseId } });
  return { gate, client, call, close: () => client.close() };
}

/** Lets pending transport messages run without a real timer. */
async function settle(): Promise<void> {
  for (let turn = 0; turn < 5; turn += 1) await Promise.resolve();
}

describe("the bridge tool gate", () => {
  test("declares the raw tool schemas, each always loaded and with the result size annotation, and only the tools capability", async () => {
    const { client, close } = await connectedGate();

    expect(client.getServerCapabilities()).toEqual({ tools: {} });
    expect((await client.listTools()).tools).toEqual([
      { name: "read", description: "Reads a file.", inputSchema: READ_SCHEMA, _meta: { "anthropic/alwaysLoad": true, "anthropic/maxResultSizeChars": 500_000 } },
      { name: "bash", description: "Runs a command.", inputSchema: BASH_SCHEMA, _meta: { "anthropic/alwaysLoad": true, "anthropic/maxResultSizeChars": 500_000 } },
    ]);
    await close();
  });

  test("a call parks by its tool use id until Flywheel's result arrives", async () => {
    const { gate, call, close } = await connectedGate();
    let answered = false;
    const pending = call("read", "toolu_1").then((result) => { answered = true; return result; });
    await settle();
    expect(answered).toBe(false);

    gate.deliver([{ toolUseId: "toolu_1", content: [{ type: "text", text: "file text" }, { type: "text", text: "more" }] }]);

    expect(await pending).toEqual({ content: [{ type: "text", text: "file text" }, { type: "text", text: "more" }] });
    await close();
  });

  test("a result that arrives before its call enters answers the call when it enters, once", async () => {
    const { gate, call, close } = await connectedGate();
    gate.deliver([{ toolUseId: "toolu_2", content: [{ type: "text", text: "early" }] }]);

    expect(await call("bash", "toolu_2")).toEqual({ content: [{ type: "text", text: "early" }] });
    const repeated = call("bash", "toolu_2");
    await settle();
    gate.close();
    expect((await repeated).isError).toBe(true);
    await close();
  });

  test("serial calls: one delivery answers the waiting call and the call the CLI makes after it returns", async () => {
    const { gate, call, close } = await connectedGate();
    const first = call("read", "toolu_a");
    await settle();
    gate.deliver([{ toolUseId: "toolu_a", content: [{ type: "text", text: "A" }] }, { toolUseId: "toolu_b", content: [{ type: "text", text: "B" }] }]);
    await first;
    const second = await call("bash", "toolu_b");

    expect([await first, second]).toEqual([{ content: [{ type: "text", text: "A" }] }, { content: [{ type: "text", text: "B" }] }]);
    await close();
  });

  test("closing settles every waiting call and refuses later ones without a Flywheel result", async () => {
    const { gate, call, close } = await connectedGate();
    const waiting = call("read", "toolu_w");
    await settle();
    gate.deliver([{ toolUseId: "toolu_unused", content: [{ type: "text", text: "never sent" }] }]);
    gate.close();

    expect((await waiting).isError).toBe(true);
    expect(await call("bash", "toolu_unused")).toMatchObject({ isError: true, content: [{ type: "text", text: "The host did not return a result for this call." }] });
    await close();
  });
});
