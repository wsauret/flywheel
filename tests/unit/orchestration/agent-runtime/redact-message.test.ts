import { describe, expect, it } from "bun:test"

import { redactMessage } from "../../../../src/orchestration/agent-runtime/agent-loop-history.js"
import type { ContentBlock, ConversationMessage } from "../../../../src/orchestration/agent-runtime/llm/types.js"
import type { LlmToolOutputPart } from "../../../../src/orchestration/agent-runtime/llm/messages.js"

describe("redactMessage", () => {
  const recognizedSecret = ["sk", "proj", "aB3".repeat(12)].join("-")
  it("masks a toolResult text part and passes an image part through", () => {
    const content: LlmToolOutputPart[] = [
      { type: "text", text: `OPENAI_API_KEY=${recognizedSecret}` },
      { type: "image", mediaType: "image/png", data: "base64data" },
    ]
    const out = redactMessage({ kind: "toolResult", toolUseId: "t1", content }, false)
    if (out.kind !== "toolResult") throw new Error("expected toolResult")
    const [text, image] = out.content
    if (text?.type !== "text") throw new Error("expected text part")
    expect(text.text).not.toContain(recognizedSecret)
    expect(text.text).toContain("[redacted secret]")
    expect(image).toEqual({ type: "image", mediaType: "image/png", data: "base64data" })
  })

  it("masks an assistant text block and passes a tool_use block through", () => {
    const content: ContentBlock[] = [
      { type: "text", text: `GITHUB_TOKEN=${recognizedSecret}` },
      { type: "tool_use", id: "u1", name: "bash", input: { cmd: "ls" } },
    ]
    const out = redactMessage({ kind: "assistant", content }, false)
    if (out.kind !== "assistant" || typeof out.content === "string") throw new Error("expected assistant blocks")
    const [text, toolUse] = out.content
    if (text?.type !== "text") throw new Error("expected text block")
    expect(text.text).toBe("GITHUB_TOKEN=[redacted secret]")
    expect(toolUse).toEqual({ type: "tool_use", id: "u1", name: "bash", input: { cmd: "ls" } })
  })

  it("passes a thinking block through unchanged (signature must match original content for replay)", () => {
    const content: ContentBlock[] = [
      { type: "thinking", thinking: "the secret is DB_PASSWORD=hunter2", signature: "sig-abc" },
    ]
    const out = redactMessage({ kind: "assistant", content }, false)
    if (out.kind !== "assistant" || typeof out.content === "string") throw new Error("expected assistant blocks")
    const [thinking] = out.content
    if (thinking?.type !== "thinking") throw new Error("expected thinking block")
    // Thinking is model reasoning, not a tool-output egress path. Rewriting its
    // text would invalidate the signature Anthropic checks against the content.
    expect(thinking.thinking).toBe("the secret is DB_PASSWORD=hunter2")
    expect(thinking.signature).toBe("sig-abc")
  })

  it("redacts secret string leaves inside a tool_use input, preserving structure", () => {
    const content: ContentBlock[] = [
      {
        type: "tool_use",
        id: "u1",
        name: "bash",
        input: {
          command: `curl -H 'Authorization: Bearer ${recognizedSecret}' https://api.example.com`,
          timeout: 30,
          flags: ["--silent", `API_KEY=${recognizedSecret}`],
        },
      },
    ]
    const out = redactMessage({ kind: "assistant", content }, false)
    if (out.kind !== "assistant" || typeof out.content === "string") throw new Error("expected assistant blocks")
    const [toolUse] = out.content
    if (toolUse?.type !== "tool_use") throw new Error("expected tool_use block")
    const command = toolUse.input.command
    if (typeof command !== "string") throw new Error("expected command string")
    expect(command).not.toContain(recognizedSecret)
    expect(command).toContain("[redacted secret]")
    // Non-secret structure and scalars are preserved.
    expect(toolUse.input.timeout).toBe(30)
    expect(toolUse.id).toBe("u1")
    expect(toolUse.name).toBe("bash")
    const flags = toolUse.input.flags
    if (!Array.isArray(flags)) throw new Error("expected flags array")
    expect(flags[0]).toBe("--silent")
    expect(flags[1]).toBe("API_KEY=[redacted secret]")
  })

  it("masks a produced (non-human) user plain-string secret", () => {
    // humanTyped=false: a system-injected user-role message (notification/nudge).
    const out = redactMessage({ kind: "user", content: `API_KEY=${recognizedSecret}` }, false)
    if (out.kind !== "user" || typeof out.content !== "string") throw new Error("expected user string")
    expect(out.content).toBe("API_KEY=[redacted secret]")
  })

  it("masks a produced (non-human) user text block and passes a user image block through", () => {
    const content: ContentBlock[] = [
      { type: "text", text: `SECRET_TOKEN=${recognizedSecret}` },
      { type: "image", mediaType: "image/jpeg", data: "imgdata" },
    ]
    const out = redactMessage({ kind: "user", content }, false)
    if (out.kind !== "user" || typeof out.content === "string") throw new Error("expected user blocks")
    const [text, image] = out.content
    if (text?.type !== "text") throw new Error("expected text block")
    expect(text.text).toBe("SECRET_TOKEN=[redacted secret]")
    expect(image).toEqual({ type: "image", mediaType: "image/jpeg", data: "imgdata" })
  })

  it("passes a genuinely human-typed user secret through UNREDACTED (provenance policy)", () => {
    // Policy: a user who deliberately pastes a secret must have it reach the
    // model and the durable tree verbatim. humanTyped=true bypasses masking.
    const stringMessage = redactMessage({ kind: "user", content: "here is my key sk-live_abc123DEF456, use it" }, true)
    if (stringMessage.kind !== "user" || typeof stringMessage.content !== "string") throw new Error("expected user string")
    expect(stringMessage.content).toBe("here is my key sk-live_abc123DEF456, use it")

    const blockContent: ContentBlock[] = [{ type: "text", text: "OPENAI_API_KEY=sk-live_xyz789" }]
    const blockMessage = redactMessage({ kind: "user", content: blockContent }, true)
    if (blockMessage.kind !== "user" || typeof blockMessage.content === "string") throw new Error("expected user blocks")
    const [text] = blockMessage.content
    if (text?.type !== "text") throw new Error("expected text block")
    expect(text.text).toBe("OPENAI_API_KEY=sk-live_xyz789")
  })

  it("stamps origin 'system' on produced user messages and leaves human turns unstamped", () => {
    const produced = redactMessage({ kind: "user", content: "<subagent_notifications>...</subagent_notifications>" }, false)
    if (produced.kind !== "user") throw new Error("expected user")
    expect(produced.origin).toBe("system")

    const human = redactMessage({ kind: "user", content: "hello" }, true)
    if (human.kind !== "user") throw new Error("expected user")
    expect(human.origin).toBeUndefined()
  })

  it("keeps the runtime-notice label and the request framing of a produced user message while it masks its text", () => {
    expect(redactMessage({ kind: "user", content: `AUTH_TOKEN=${recognizedSecret}`, runtimeNotice: true }, false))
      .toEqual({ kind: "user", content: "AUTH_TOKEN=[redacted secret]", origin: "system", runtimeNotice: true })
    expect(redactMessage({ kind: "user", content: `AUTH_TOKEN=${recognizedSecret}`, framing: "claude" }, false))
      .toEqual({ kind: "user", content: "AUTH_TOKEN=[redacted secret]", origin: "system", framing: "claude" })
  })

  it("masks system and compactionSummary string content", () => {
    const system = redactMessage({ kind: "system", content: `AUTH_TOKEN=${recognizedSecret}` }, false)
    if (system.kind !== "system") throw new Error("expected system")
    expect(system.content).toBe("AUTH_TOKEN=[redacted secret]")

    const summary = redactMessage({ kind: "compactionSummary", content: `PASSWORD=${recognizedSecret}` }, false)
    if (summary.kind !== "compactionSummary") throw new Error("expected compactionSummary")
    expect(summary.content).toBe("PASSWORD=[redacted secret]")
  })

  it("keeps a content-repair decision and masks a secret in its note", () => {
    const contentRepair = { kind: "withhold", toolUseId: "t1", partIndex: 0, partKind: "text" } as const
    const decision = redactMessage({ kind: "system", content: `Refused: AUTH_TOKEN=${recognizedSecret}`, contentRepair }, false)
    expect(decision).toEqual({ kind: "system", content: "Refused: AUTH_TOKEN=[redacted secret]", contentRepair })
  })

  it("is idempotent over an already-redacted message (resume re-pushes redacted history)", () => {
    const message: ConversationMessage = {
      kind: "toolResult",
      toolUseId: "t1",
      content: [{ type: "text", text: `DB_PASSWORD=${recognizedSecret}\nPATH=/usr/bin` }],
    }
    const once = redactMessage(message, false)
    const twice = redactMessage(once, false)
    expect(twice).toEqual(once)
  })

  it("round-trips a non-secret message deep-equal (no spurious mutation)", () => {
    const message: ConversationMessage = {
      kind: "assistant",
      content: [
        { type: "text", text: "step 3 completed in 404ms" },
        { type: "tool_use", id: "u1", name: "bash", input: { cmd: "echo ok" } },
      ],
      stopReason: "end_turn",
    }
    expect(redactMessage(message, false)).toEqual(message)
  })
})
