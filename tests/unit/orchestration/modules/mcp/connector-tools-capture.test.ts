import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ConnectorToolsRefusedError, createDebugToolCapture, type ConnectorToolsRefusal, type DebugToolCapture } from "../../../../../src/orchestration/modules/mcp/connector-tools-capture.js";

const SERVER = "claude_ai_Claude_Docs";
/** The stderr window of one real `get_context_usage` call on a discovery engine that held only the Claude Docs
 *  connector: an empty count block, then the count block with the connector's eight tools. Personal identifiers are
 *  placeholders; the masked header values are as the engine wrote them. */
const FIXTURE = readFileSync(join(import.meta.dir, "fixtures", "connector-count-tokens.log"), "utf8").replace(/\n$/u, "").split("\n");

const feeding = (capture: DebugToolCapture, lines: readonly string[]) => async () => {
  for (const line of lines) capture.onLine(line);
};

/** A count block as the engine's Anthropic client logs it: Bun's console inspection, which `Bun.inspect` matches. */
function countBlock(tools: readonly object[], depth = 64): string[] {
  const request = {
    method: "POST",
    url: "https://api.anthropic.com/v1/messages/count_tokens?beta=true",
    options: { method: "post", path: "/v1/messages/count_tokens?beta=true", body: { model: "claude-opus-5-5", messages: [{ role: "user", content: "foo" }], tools } },
    headers: { accept: "application/json", authorization: "***" },
  };
  const [, ...rest] = Bun.inspect(request, { depth }).split("\n");
  return ["[Anthropic SDK DEBUG] [log_abc123] sending request {", ...rest];
}

async function refusal(answer: Promise<unknown>): Promise<ConnectorToolsRefusal | "answered"> {
  try {
    await answer;
    return "answered";
  } catch (error) {
    if (!(error instanceof ConnectorToolsRefusedError)) throw error;
    expect(error.message).toBe("Flywheel cannot read this connector's tools");
    return error.kind;
  }
}

describe("createDebugToolCapture", () => {
  test("reads the connector's tools from the real count block exactly", async () => {
    const headers = FIXTURE.filter((line) => /^\s*"?(?:proxy-authorization|authorization|x-api-key|api-key|set-cookie|cookie)"?:/iu.test(line));
    expect(headers.length).toBeGreaterThan(0);
    for (const line of headers) expect(line.trim()).toBe("authorization: \"***\",");

    const capture = createDebugToolCapture();
    const tools = await capture.capture(SERVER, feeding(capture, FIXTURE));

    expect(tools.map((tool) => tool.name)).toEqual(["batch", "create", "delete", "export", "guide", "query", "read", "update"].map((name) => `mcp__${SERVER}__${name}`));
    expect(tools[0]).toStrictEqual({
      name: "mcp__claude_ai_Claude_Docs__batch",
      description: "Create a doc, or apply several operations to one doc atomically.",
      input_schema: {
        type: "object",
        properties: {
          batch: { type: "array" },
          container: { type: "object", properties: { kind: { type: "string" }, id: { type: "string" }, create: { type: "object" } }, required: ["kind"] },
          verbose: { type: "boolean" },
          opId: { type: "string" },
        },
      },
    });
    expect(tools[3]?.description).toBe("Export one tab inline as base64: pdf, docx, html, text, markdown or notion (Notion-flavored markdown, what notion-create-pages takes). To just keep the file in the doc's files, create a blob {from: {object: \"file\", id}, format} instead (no large result).");
    expect(tools[6]?.description).toBe("Read a doc (lists its tabs), a tab's contents, or a comment. A claude.ai/[code/]artifact/[<title>-]<id> link → `ref {\"object\":\"project\",\"id\":\"<id>\"}` first; reads inside it take `container {\"kind\":\"project\",\"id\":\"<id>\"}`.");
    expect(tools[3]?.input_schema).toMatchObject({ properties: { maxBytes: { type: "integer", minimum: 1, maximum: 11534336 }, pictures: { enum: ["fit"] } }, required: ["container", "file", "format"] });
  });

  test("refuses the whole capture when one credential header value is not masked", async () => {
    const lines = FIXTURE.map((line, index) => index === FIXTURE.lastIndexOf("    authorization: \"***\",") ? "    authorization: \"abc123\"," : line);
    const capture = createDebugToolCapture();
    expect(await refusal(capture.capture(SERVER, feeding(capture, lines)))).toBe("unmasked-credential");
  });

  test("refuses the whole capture when an unmasked credential follows the tools block before the request settles", async () => {
    const capture = createDebugToolCapture();
    expect(await refusal(capture.capture(SERVER, feeding(capture, [...FIXTURE, "    \"set-cookie\": \"session=abc123\","])))).toBe("unmasked-credential");
  });

  test("refuses a count block that Bun cut after 100 items", async () => {
    const block = countBlock(Array.from({ length: 103 }, (_, index) => ({ name: `mcp__${SERVER}__tool_${index}`, input_schema: { type: "object" } })));
    expect(block).toContain("        ... 3 more items");
    const capture = createDebugToolCapture();
    expect(await refusal(capture.capture(SERVER, feeding(capture, block)))).toBe("truncated");
  });

  test("refuses a count block that Bun cut at its inspection depth", async () => {
    const block = countBlock([{ name: `mcp__${SERVER}__deep`, input_schema: { type: "object", properties: { a: { type: "object" } } } }], 5);
    expect(block.some((line) => line.includes("[Object ...]"))).toBe(true);
    const capture = createDebugToolCapture();
    expect(await refusal(capture.capture(SERVER, feeding(capture, block)))).toBe("truncated");
  });

  test("keeps every character of a description", async () => {
    const description = "Start \"quoted\" 'single' back\\slash\nnew line\ttab \u0001 ctrl \u007f del é accent \u{1F600} emoji key: value, } ] [Object ...] ... 3 more items END";
    const tool = { name: `mcp__${SERVER}__fidelity`, description, input_schema: { type: "object", properties: { "with-dash": { type: "number", minimum: -1, maximum: 1e21 }, flag: { type: "boolean", default: false }, empty: { type: "object", properties: {}, required: [] }, nothing: { default: null } } } };
    const capture = createDebugToolCapture();
    expect(await capture.capture(SERVER, feeding(capture, countBlock([tool, { name: "mcp__other__tool", input_schema: { type: "object" } }])))).toStrictEqual([tool]);
  });

  test("drops lines that arrive while no capture runs", async () => {
    const capture = createDebugToolCapture();
    capture.onLine("    authorization: \"abc123\",");
    expect((await capture.capture(SERVER, feeding(capture, FIXTURE))).length).toBe(8);
  });

  test("refuses when no count block with the server's tools closes in time", async () => {
    const capture = createDebugToolCapture();
    expect(await refusal(capture.capture(SERVER, feeding(capture, FIXTURE.slice(0, 50)), 20))).toBe("no-definitions");
  });
});
