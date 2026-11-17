import { afterEach, describe, expect, it } from "bun:test"
import { composeModules } from "../../../../src/infra/module-descriptor"
import { composeModuleServices, moduleServiceHandle } from "../../../../src/infra/module-service"
import { createBackgroundExecutionOwner } from "../../../../src/orchestration/agent-runtime/background-execution-owner"
import { createBackgroundWorkRegistry } from "../../../../src/orchestration/agent-runtime/background-work"
import { createForegroundBashHoldController } from "../../../../src/orchestration/agent-runtime/foreground-bash-hold"
import { openProviderSession, type HeldProviderSession } from "../../../../src/orchestration/agent-runtime/provider-runtime-cache"
import type { ChatProfile } from "../../../../src/orchestration/agent-runtime/types"
import { createChatRequestOptions } from "../../../../src/orchestration/chat/chat-request-options"
import type { FirstPartyModule } from "../../../../src/orchestration/modules"
import { askUserStub, createTestChatSessionDeps } from "./_chat-session-agent-runtime-fixtures"

const profile: ChatProfile = { prompt: "P", tools: ["read"], role: "owned-role" }
const owned = moduleServiceHandle<{ readonly sessionId: string }>("owner")
const owner: FirstPartyModule = {
  id: "owner", dependencies: [], availability: { kind: "available" }, observers: [], transformers: [], gates: [],
  contributions: [{ domain: "chatProfiles", id: "owner", value: { profile: ({ sessionId, modules }) => modules.get(owned)?.sessionId === sessionId ? profile : undefined } }],
}
const on = composeModules([owner])
const off = composeModules([owner], { disabledModuleIds: ["owner"] })

const held: HeldProviderSession[] = []
const closers: Array<() => Promise<void>> = []
afterEach(async () => {
  await Promise.all([...held.splice(0).map((session) => session.close()), ...closers.splice(0).map((close) => close())])
})

function requestOptions(sessionId: string) {
  const deps = createTestChatSessionDeps({
    sessionId,
    createAgent: () => { throw new Error("createAgent not used") },
    moduleServices: composeModuleServices([["owner", { sessionId: "a" }]]),
    moduleSelection: () => on,
  })
  const background = createBackgroundExecutionOwner(createBackgroundWorkRegistry({ kind: "chat", enqueueNotification: () => {} }))
  const foregroundBashHold = createForegroundBashHoldController(() => {})
  closers.push(async () => { await background.close(); foregroundBashHold.dispose() })
  const provider = openProviderSession(() => undefined)
  held.push(provider)
  const options = createChatRequestOptions({
    deps, surfaces: { background, foregroundBashHold, askUser: askUserStub() }, applyNestedStoredFact: () => {}, providerSessionKey: () => "provider-key",
  })
  return { options, provider: provider.session }
}

describe("chat request options", () => {
  it("answer the chat profile of their own session", () => {
    const a = requestOptions("a")
    const b = requestOptions("b")
    expect(a.options.send(undefined, a.provider).chatProfile?.(on)).toBe(profile)
    expect(b.options.send(undefined, b.provider).chatProfile?.(on)).toBeUndefined()
  })

  it("answer by the module snapshot of each call, with no fixed profile or prompt, in the send and the pre-start", async () => {
    const { options, provider } = requestOptions("a")
    const send = options.send(undefined, provider)
    expect(send.chatProfile?.(off)).toBeUndefined()
    expect(send.chatProfile?.(on)).toBe(profile)
    expect(send).not.toHaveProperty("toolProfile")
    expect(send).not.toHaveProperty("chatPrompt")

    const { options: prestart } = await options.prestart(provider)
    expect(prestart.chatProfile?.(off)).toBeUndefined()
    expect(prestart.chatProfile?.(on)).toBe(profile)
  })

  it("select the model role that the chat's profile names, and Chat for a chat without a profile", () => {
    const roles = new Map([
      ["chat", { roleId: "chat", model: "chat-model", effort: "medium" }],
      ["owned-role", { roleId: "owned-role", model: "owned-model", effort: "low" }],
    ])
    const a = requestOptions("a")
    const b = requestOptions("b")
    expect(a.options.chatRole()).toBe("owned-role")
    expect(a.options.send(undefined, a.provider).requestSelection(roles)).toMatchObject({ roleId: "owned-role", model: "owned-model", effort: "low" })
    expect(b.options.chatRole()).toBe("chat")
    expect(b.options.send(undefined, b.provider).requestSelection(roles)).toMatchObject({ roleId: "chat", model: "chat-model" })
  })
})
