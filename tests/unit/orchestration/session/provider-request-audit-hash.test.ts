import { describe, expect, test } from "bun:test"
import { hashAgentPrompt, hashToolSurface } from "../../../../src/orchestration/session/provider-request-audit-hash"
import { createConversationMessageEntries } from "../../../../src/orchestration/session/conversation/conversation-tree"
import { buildSessionContext } from "../../../../src/orchestration/session/conversation/conversation-tree-context"
import type { ConversationMessage } from "../../../../src/orchestration/agent-runtime/llm/types"

function tool(input_schema: { [key: string]: unknown }) {
  return {
    name: "search",
    registrationId: "search.native",
    executableId: "search",
    description: "Search",
    input_schema,
  }
}

const schema = {
  type: "object",
  properties: {
    query: { type: "string", description: "Search query" },
    options: {
      type: "object",
      properties: {
        limit: { type: "number", minimum: 1 },
        exact: { type: "boolean" },
      },
      required: ["limit"],
    },
  },
  required: ["query", "options"],
}

const reorderedSchema = {
  required: ["query", "options"],
  properties: {
    options: {
      required: ["limit"],
      properties: {
        exact: { type: "boolean" },
        limit: { minimum: 1, type: "number" },
      },
      type: "object",
    },
    query: { description: "Search query", type: "string" },
  },
  type: "object",
}

describe("provider request audit hashes", () => {
  for (const deliveryField of ["dispatchIds", "backgroundNotificationIds"] as const) {
    test(`prompt hash survives persistence of a user message with ${deliveryField}`, async () => {
      const message: ConversationMessage = {
        kind: "user", content: "delivered content", origin: "system",
        submissionIds: ["durable-submission"], [deliveryField]: ["temporary-delivery"],
      }
      const entries = await createConversationMessageEntries([message], null, () => "entry", () => "2026-09-24T00:00:00.000Z")
      const rebuilt = buildSessionContext(entries).messages
      const input = { systemPrompt: "system", messages: [message], tools: [tool(schema)] }
      const original = hashAgentPrompt(input)
      expect(rebuilt[0]).not.toHaveProperty(deliveryField)
      expect(original).toBe(hashAgentPrompt({ ...input, messages: rebuilt }))
      expect(original).not.toBe(hashAgentPrompt({ ...input, messages: [{ ...message, content: "changed content" }] }))
      expect(original).not.toBe(hashAgentPrompt({ ...input, messages: [{ ...message, submissionIds: ["other-submission"] }] }))
      expect(message[deliveryField]).toEqual(["temporary-delivery"])
    })
  }

  test("delivery-named keys inside content remain part of the prompt hash", () => {
    const input = { systemPrompt: "system", tools: [], messages: [{ kind: "user", content: { kind: "user", dispatchIds: ["first"], backgroundNotificationIds: ["first"] } }] }
    expect(hashAgentPrompt(input)).not.toBe(hashAgentPrompt({
      ...input, messages: [{ kind: "user", content: { kind: "user", dispatchIds: ["second"], backgroundNotificationIds: ["first"] } }],
    }))
    expect(hashAgentPrompt(input)).not.toBe(hashAgentPrompt({
      ...input, messages: [{ kind: "user", content: { kind: "user", dispatchIds: ["first"], backgroundNotificationIds: ["second"] } }],
    }))
  })

  test("tool surface hash ignores object property insertion order at every depth", () => {
    expect(hashToolSurface([tool(schema)], [])).toBe(hashToolSurface([tool(reorderedSchema)], []))
  })

  test("tool surface hash includes presentation kind and exact format hash", () => {
    const functionTool = { ...tool(schema), kind: "function" as const, inputFormatSha256: "a".repeat(64) };
    const customTool = { ...functionTool, kind: "custom" as const };
    const otherGrammar = { ...customTool, inputFormatSha256: "b".repeat(64) };

    expect(hashToolSurface([functionTool], [])).not.toBe(hashToolSurface([customTool], []));
    expect(hashToolSurface([customTool], [])).not.toBe(hashToolSurface([otherGrammar], []));
  });

  test("step prompt hash ignores nested message and schema property insertion order", () => {
    const first = hashAgentPrompt({
      systemPrompt: "system",
      messages: [{ role: "user", content: [{ type: "tool_result", payload: { count: 1, result: "ok" } }] }],
      tools: [tool(schema)],
    })
    const reordered = hashAgentPrompt({
      systemPrompt: "system",
      messages: [{ content: [{ payload: { result: "ok", count: 1 }, type: "tool_result" }], role: "user" }],
      tools: [tool(reorderedSchema)],
    })

    expect(first).toBe(reordered)
  })

  test("preserves array order and primitive differences", () => {
    expect(hashToolSurface([tool(schema)], [])).not.toBe(hashToolSurface([tool({ ...schema, required: ["options", "query"] })], []))
    expect(hashAgentPrompt({ systemPrompt: "system", messages: [{ value: 1 }], tools: [] })).not.toBe(
      hashAgentPrompt({ systemPrompt: "system", messages: [{ value: 2 }], tools: [] }),
    )
  })

  test("rejects values outside JSON", () => {
    expect(() => hashToolSurface([tool({ type: "object", invalid: undefined })], [])).toThrow("unsupported JSON value")
  })
})
