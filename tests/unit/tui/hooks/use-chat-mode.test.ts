import { describe, expect, it } from "bun:test"
import { RpcClientError } from "effect/unstable/rpc"
import { Socket } from "effect/unstable/socket"
import { useChatMode } from "../../../../src/tui/hooks/use-chat-mode.js"
import { runtimeDispatch } from "../../../helpers/runtime-dispatch.js"

describe("useChatMode", () => {
  it("reports failed and rejected question mutations and returns failure for retry", async () => {
    const messages: string[] = []
    const showToast = ({ message }: { message: string }) => { messages.push(message) }
    let attempts = 0
    // The runtime refuses the first question request and is offline for the next.
    const answer = async () => {
      if (attempts++ === 0) return { ok: false as const, error: "Not accepted" }
      throw new Error("offline")
    }
    const dispatch = runtimeDispatch({ "question.answer": answer, "question.cancel": answer })
    const hook = useChatMode({
      signals: {
        foregroundId: () => "chat-a",
      },
      appService: { dispatch },
      showToast,
    })
    expect(await hook.answerQuestion("tool-a", {})).toBe(false)
    expect(await hook.cancelQuestion("tool-a")).toBe(false)
    expect(messages).toEqual(["Not accepted", "Question cancel failed: Error: offline"])
  })

  it("reports an interrupt that failed, and shows nothing for one the runtime's clean close lost", async () => {
    const messages: string[] = []
    const rejections = [new RpcClientError.RpcClientError({ reason: new Socket.SocketCloseError({ code: 1000 }) }), new Error("offline")]
    const dispatched = Promise.withResolvers<void>()
    const dispatch = runtimeDispatch({ "chat.interrupt": async () => {
      const rejection = rejections.shift()
      if (rejections.length === 0) queueMicrotask(dispatched.resolve)
      throw rejection
    } })
    const hook = useChatMode({
      signals: { foregroundId: () => "chat-a" },
      appService: { dispatch },
      showToast: ({ message }) => { messages.push(message) },
    })
    hook.interruptChat()
    hook.interruptChat()
    await dispatched.promise
    await Promise.resolve()

    expect(messages).toEqual(["Interrupt failed: offline"])
  })
})
