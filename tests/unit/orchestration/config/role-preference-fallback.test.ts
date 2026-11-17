import { describe, expect, test } from "bun:test"
import type { ProviderRequestOptions } from "../../../../src/infra/llm/provider-options.js"
import type { AccessProviderCandidate, AccessProviderCandidateAttribution, AdmittedFailoverPlan } from "../../../../src/infra/llm/access-provider.js"
import { modelStanding } from "../../../../src/orchestration/agent-runtime/llm/model-standing.js"
import type { ProviderAvailability, QuotaExhaustion } from "../../../../src/orchestration/agent-runtime/llm/provider-availability-types.js"
import { resolveCapturedRole, type CapturedRoleSelection, type RoleSetting } from "../../../../src/orchestration/config/role-resolution.js"
import { roleCapture } from "../../../helpers/role-capture.js"
import { fakeAvailability, singletonCandidate, subscriptionCandidate } from "../agent-runtime/llm/_provider-chain-harness.js"

const NOW = Date.parse("2026-11-11T10:00:00Z")
const RESET = Date.parse("2026-11-11T14:21:24Z")

/** The routes of each model as a profile with a ChatGPT and a Claude subscription has them, with an OpenAI API key
 *  as the paid route of the OpenAI models when `paid` is set, and as the only route of the `paidOnly` models. */
function routesOf(model: string, paid: boolean, copilot: boolean, paidOnly: readonly string[]): AccessProviderCandidate[] {
  if (paidOnly.includes(model)) return [singletonCandidate("openai_api")]
  if (model.startsWith("claude")) return [subscriptionCandidate("claude_agent_sdk")]
  return [subscriptionCandidate("chatgpt"), ...(copilot ? [subscriptionCandidate("github_copilot")] : []), ...(paid ? [singletonCandidate("openai_api")] : [])]
}

function scenario(options: { readonly paid?: boolean; readonly copilot?: boolean; readonly paidOnly?: readonly string[]; readonly chatGpt?: QuotaExhaustion } = {}) {
  const fake = fakeAvailability(options.chatGpt === undefined ? {} : { chatGpt: options.chatGpt }, NOW)
  const availability: ProviderAvailability = {
    ...fake.availability,
    claimQuotaProbe: () => { throw new Error("standing never claims a probe") },
    claimServiceProbe: () => { throw new Error("standing never claims a probe") },
  }
  const judged: string[] = []
  const standing = async (plan: AdmittedFailoverPlan, providerOptions: ProviderRequestOptions | undefined) => {
    judged.push(plan.model)
    const candidateAttributions = routesOf(plan.model, options.paid === true, options.copilot === true, options.paidOnly ?? []).map((candidate): AccessProviderCandidateAttribution => ({ candidate, wireModelId: plan.model, dataUse: "standard" }))
    return modelStanding({ ...plan, candidateAttributions }, { availability, conditions: [], ...(providerOptions === undefined ? {} : { providerOptions }) }, (provider) => provider === "chatgpt" ? "ChatGPT" : "Claude")
  }
  const capture = roleCapture(["gpt-6-astra", "gpt-6.1-sol", "claude-opus-5.5"])
  const resolve = async (setting: RoleSetting = { model: "gpt-6-astra", effort: "high" }, agent = true): Promise<CapturedRoleSelection> => {
    judged.length = 0
    return await resolveCapturedRole("workflow-agent", setting, {
      selection: capture.providers.selection, connection: capture.connection, eligibility: capture.eligibility, allowTrainingRoutes: true,
    }, "/scratch", agent ? standing : undefined)
  }
  return { fake, availability, judged, resolve }
}

const served = (selection: CapturedRoleSelection) => selection.kind === "selected" ? { model: selection.role.model, effort: selection.role.effort } : selection.kind

describe("an agent's role passes over a preference whose included quota is spent (PI-MODEL-087)", () => {
  test("spent ChatGPT quota moves the saved and coded OpenAI pairs to the coded Anthropic pair, and the reset moves it back", async () => {
    const { fake, availability, judged, resolve } = scenario()
    availability.observeChatGptQuotaExhausted(subscriptionCandidate("chatgpt"), RESET / 1000)

    const switched = await resolve()
    expect(served(switched)).toEqual({ model: "claude-opus-5.5", effort: "medium" })
    expect(switched.kind === "selected" ? switched.passed : undefined).toEqual({
      model: "gpt-6-astra", effort: "high", reset: { atMs: RESET, hold: { kind: "usage_limit", stated: true } }, providers: ["ChatGPT"],
    })
    expect(judged).toEqual(["gpt-6-astra", "gpt-6.1-sol", "claude-opus-5.5"])

    fake.advance(RESET - NOW)
    const back = await resolve()
    expect(served(back)).toEqual({ model: "gpt-6-astra", effort: "high" })
    expect(back.kind === "selected" ? back.passed : "none").toBeUndefined()
    expect(judged).toEqual(["gpt-6-astra"])
  })

  test("a coded OpenAI default falls over the same way when no model is saved", async () => {
    const { availability, resolve } = scenario()
    availability.observeChatGptQuotaExhausted(subscriptionCandidate("chatgpt"), RESET / 1000)
    expect(served(await resolve({}))).toEqual({ model: "claude-opus-5.5", effort: "medium" })
  })

  test("another included route of the same model keeps the agent on it", async () => {
    const { availability, resolve } = scenario({ copilot: true })
    availability.observeChatGptQuotaExhausted(subscriptionCandidate("chatgpt"), RESET / 1000)
    expect(served(await resolve())).toEqual({ model: "gpt-6-astra", effort: "high" })
  })

  test("a rate limit, an outage, or a spent limit that states no reset never moves the agent", async () => {
    const limited = scenario({ chatGpt: { exhaustedAtMs: NOW, resetsAtMs: RESET, hold: { kind: "rate_limit" } } })
    expect(served(await limited.resolve())).toEqual({ model: "gpt-6-astra", effort: "high" })
    const outage = scenario()
    outage.availability.markUnreachable("chatgpt")
    expect(served(await outage.resolve())).toEqual({ model: "gpt-6-astra", effort: "high" })
    const unstated = scenario()
    unstated.availability.observeChatGptQuotaExhausted(subscriptionCandidate("chatgpt"), undefined)
    expect(served(await unstated.resolve())).toEqual({ model: "gpt-6-astra", effort: "high" })
  })

  test("a recheck that is due or pending never moves the agent", async () => {
    const { fake, availability, resolve } = scenario()
    availability.observeChatGptQuotaExhausted(subscriptionCandidate("chatgpt"), RESET / 1000)
    fake.advance(RESET - NOW)
    expect(availability.chatGptStanding(subscriptionCandidate("chatgpt")).kind).toBe("probe_due")
    expect(served(await resolve())).toEqual({ model: "gpt-6-astra", effort: "high" })

    fake.availability.claimQuotaProbe(subscriptionCandidate("chatgpt"))
    expect(availability.chatGptStanding(subscriptionCandidate("chatgpt")).kind).toBe("recheck_pending")
    expect(served(await resolve())).toEqual({ model: "gpt-6-astra", effort: "high" })
  })

  test("another family's included quota wins over a paid route of the spent model, and the paid route serves when no included quota is left", async () => {
    const { availability, resolve } = scenario({ paid: true })
    availability.observeChatGptQuotaExhausted(subscriptionCandidate("chatgpt"), RESET / 1000)
    expect(served(await resolve())).toEqual({ model: "claude-opus-5.5", effort: "medium" })

    availability.markQuotaExhausted(subscriptionCandidate("claude_agent_sdk"), RESET + 60_000)
    const paid = await resolve()
    expect(served(paid)).toEqual({ model: "gpt-6-astra", effort: "high" })
    expect(paid.kind === "selected" ? [paid.passed, paid.spentUntil] : []).toEqual([undefined, undefined])
  })

  test("a saved model that serves only on a paid route yields to the next preference with included quota, with no spent quota to announce", async () => {
    const { resolve } = scenario({ paidOnly: ["gpt-6-astra"] })
    const selected = await resolve()
    expect(served(selected)).toEqual({ model: "gpt-6.1-sol", effort: "medium" })
    expect(selected.kind === "selected" ? [selected.passed, selected.spentUntil] : []).toEqual([undefined, undefined])
  })

  test("a preference that the role's provider options make unservable cannot serve, so fast mode never moves the agent onto a Claude subscription", async () => {
    const { availability, judged, resolve } = scenario()
    availability.observeChatGptQuotaExhausted(subscriptionCandidate("chatgpt"), RESET / 1000)
    const none = await resolve({ model: "gpt-6-astra", effort: "high", provider_options: { anthropic: { speed: "fast" } } })
    expect(judged).toEqual(["gpt-6-astra", "gpt-6.1-sol", "claude-opus-5.5"])
    expect(served(none)).toEqual({ model: "gpt-6-astra", effort: "high" })
    expect(none.kind === "selected" ? none.spentUntil : undefined).toEqual({ atMs: RESET, hold: { kind: "usage_limit", stated: true } })
  })

  test("when no preference serves, the role keeps its model and states the earliest moment one serves again", async () => {
    const { availability, resolve } = scenario()
    availability.observeChatGptQuotaExhausted(subscriptionCandidate("chatgpt"), (RESET + 3_600_000) / 1000)
    availability.markQuotaExhausted(subscriptionCandidate("claude_agent_sdk"), RESET)
    const none = await resolve()
    expect(served(none)).toEqual({ model: "gpt-6-astra", effort: "high" })
    expect(none.kind === "selected" ? [none.passed, none.spentUntil] : []).toEqual([undefined, { atMs: RESET, hold: { kind: "usage_limit", stated: true } }])
  })

  test("a request that is not an agent's keeps its model and judges nothing", async () => {
    const { availability, judged, resolve } = scenario()
    availability.observeChatGptQuotaExhausted(subscriptionCandidate("chatgpt"), RESET / 1000)
    expect(served(await resolve(undefined, false))).toEqual({ model: "gpt-6-astra", effort: "high" })
    expect(judged).toEqual([])
  })
})
