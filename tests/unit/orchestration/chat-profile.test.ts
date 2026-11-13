import { describe, expect, it } from "bun:test"
import { composeModules } from "../../../src/infra/module-descriptor"
import { composeModuleServices, moduleServiceHandle, type ModuleServices } from "../../../src/infra/module-service"
import { resolveChatProfile } from "../../../src/orchestration/chat-profile"
import type { ChatProfile } from "../../../src/orchestration/agent-runtime/types"
import type { FirstPartyModule, FirstPartyModuleComposition } from "../../../src/orchestration/modules"

const owned = moduleServiceHandle<{ readonly sessionId: string }>("owner")

function profileModule(id: string, answer: (sessionId: string, modules: ModuleServices) => ChatProfile | undefined): FirstPartyModule {
  return {
    id, dependencies: [], availability: { kind: "available" }, observers: [], transformers: [], gates: [],
    contributions: [{ domain: "chatProfiles", id, value: { profile: ({ sessionId, modules }) => answer(sessionId, modules) } }],
  }
}

function compose(modules: readonly FirstPartyModule[], disabledModuleIds: readonly string[] = []): FirstPartyModuleComposition {
  return composeModules(modules, { disabledModuleIds })
}

const profile: ChatProfile = { prompt: "P", tools: ["read"] }
const services = composeModuleServices([["owner", { sessionId: "a" }]])
const owner = profileModule("owner", (sessionId, modules) => modules.get(owned)?.sessionId === sessionId ? profile : undefined)

describe("resolveChatProfile", () => {
  it("answers the profile that an enabled module gives the session, and none for another session", () => {
    const composition = compose([owner])
    expect(resolveChatProfile(composition, { sessionId: "a", modules: services })).toBe(profile)
    expect(resolveChatProfile(composition, { sessionId: "b", modules: services })).toBeUndefined()
  })

  it("answers none while the module that owns the profile is off", () => {
    expect(resolveChatProfile(compose([owner], ["owner"]), { sessionId: "a", modules: services })).toBeUndefined()
  })

  it("answers the first contribution that gives a profile, past one that declines", () => {
    const declines = profileModule("a-declines", () => undefined)
    const other: ChatProfile = { prompt: "Q", tools: ["search"] }
    const later = profileModule("z-later", () => other)
    expect(resolveChatProfile(compose([later, owner, declines]), { sessionId: "a", modules: services })).toBe(profile)
    expect(resolveChatProfile(compose([later, owner, declines]), { sessionId: "b", modules: services })).toBe(other)
  })
})
