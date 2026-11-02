import { describe, expect, it } from "bun:test"

import { chatInputContent } from "../../../src/infra/chat-input.js"
import { Schema } from "effect"
import { ChatInputObjectSchema } from "../../../src/infra/chat-input-schema.js"
import { messageInput } from "../../../src/infra/agent-loop-events.js"
import { FrontendMutationSchema, RuntimeUiPatchSchema } from "../../../src/protocol/runtime-protocol-schemas.js"
import type { FrontendMutation } from "../../../src/protocol/app-service-types.js"
import type { RuntimeUiPatch } from "../../../src/protocol/runtime-ui-protocol-types.js"

describe("chatInputContent", () => {
  it("preserves submission correlation through input decoding without adding it to model content", () => {
    const input = { text: "hello", submissionIds: ["submission-1"] }
    const decoded = Schema.decodeUnknownSync(ChatInputObjectSchema)(input)
    expect(decoded).toEqual(input)
    expect(messageInput(decoded)).toMatchObject({ submissionIds: input.submissionIds })
    expect(chatInputContent(decoded)).toBe("hello")
    const mutation = { type: "session.send", sessionId: "session", input } satisfies FrontendMutation
    expect(Schema.decodeUnknownSync(FrontendMutationSchema)(mutation)).toEqual(mutation)
  })

  it("keeps submission correlation in a transcript patch across the wire", () => {
    const patch = {
      cursor: { scope: "session", domain: "output", sessionId: "session" }, position: 2, prevPosition: 1,
      payload: { kind: "output.delta", delta: { visibleMessageCount: 1, blocks: [{
        kind: "insert", index: 0, blockId: "userMessage:user-1",
        block: { kind: "userMessage", id: "user-1", content: "hello", timestamp: 1, pending: false, injected: false, submissionIds: ["submission-1"] },
      }] } },
    } satisfies RuntimeUiPatch
    expect(Schema.decodeUnknownSync(RuntimeUiPatchSchema)(patch)).toEqual(patch)
  })
  it("converts image attachments to runtime image blocks", () => {
    expect(chatInputContent({
      text: "look [Image #1]",
      attachments: [{ marker: "[Image #1]", mediaType: "image/png", data: "abc" }],
    })).toEqual([
      { type: "text", text: "look [Image #1]" },
      { type: "image", mediaType: "image/png", data: "abc" },
    ])
  })

  it("converts a text file attachment to a named text block holding its decoded contents", () => {
    const csv = "a,b\n1,2\n"
    expect(chatInputContent({
      text: "sum these [File #1 rows.csv]",
      attachments: [{ marker: "[File #1 rows.csv]", mediaType: "text/csv", data: Buffer.from(csv).toString("base64"), name: "rows.csv" }],
    })).toEqual([
      { type: "text", text: "sum these [File #1 rows.csv]" },
      { type: "text", text: `<attachment name="rows.csv" type="text/csv">\n${csv}\n</attachment>` },
    ])
  })

  it("accepts an attachment-only message with a named file over the wire", () => {
    const input = { text: "", attachments: [{ marker: "[File #1 notes.md]", mediaType: "text/markdown", data: "IyBoaQ==", name: "notes.md" }] }
    const mutation = { type: "session.send", sessionId: "session", input } satisfies FrontendMutation
    expect(Schema.decodeUnknownSync(FrontendMutationSchema)(mutation)).toEqual(mutation)
    expect(messageInput(input)).toMatchObject({ attachments: input.attachments })
  })
})
