import { expect, test } from "bun:test"
import { createRoot, createSignal } from "solid-js"
import type { RuntimeAuthLoginQuestion, RuntimeAuthView } from "../../../src/protocol/auth-status-protocol-types.js"
import { observeLoginQuestions } from "./login-question.js"
import { SUBSCRIPTION_SPEND_DETECTION_FAILURE_MESSAGE } from "../../../src/protocol/subscription-spend-consent-protocol-types.js"

const question: RuntimeAuthLoginQuestion = { questionId: "episode-b", providerId: "claude_agent_sdk", instanceId: "account-b", profileId: "b", profileDisplayName: "Background", providerDisplayName: "Anthropic Subscription", accountDisplayName: "long-personal-account@example.invalid" }
function view(questions: readonly RuntimeAuthLoginQuestion[]): RuntimeAuthView {
  return { loginQuestions: questions, providers: [], warnings: [], profile: { id: "foreground", displayName: "Foreground", source: "default", availableProfiles: [] }, subscriptionSpendConsent: { kind: "unavailable", profileId: "foreground", message: SUBSCRIPTION_SPEND_DETECTION_FAILURE_MESSAGE } }
}
test("project questions target their captured account once and owner removal sends no decline", async () => {
  await createRoot(async (dispose) => {
    const [auth, setAuth] = createSignal<RuntimeAuthView | undefined>(view([question]))
    const answers: ((yes: boolean) => void)[] = []
    const opened: unknown[] = []
    const declined: unknown[] = []
    observeLoginQuestions({
      auth,
      confirm: (_request, signal) => new Promise((resolve) => { answers.push(resolve); signal?.addEventListener("abort", () => resolve(false), { once: true }) }),
      open: (target) => { opened.push(target) },
      decline: async (target) => { declined.push(target) },
      failed: () => {},
    })
    await Promise.resolve()
    setAuth(view([{ ...question }]))
    await Promise.resolve()
    expect(answers).toHaveLength(1)
    answers[0]!(true)
    await Promise.resolve()
    expect(opened).toEqual([question])
    setAuth(view([{ ...question, questionId: "next" }]))
    await Promise.resolve()
    setAuth(view([]))
    await Promise.resolve()
    expect(declined).toEqual([])
    dispose()
  })
})

test("a deliberate No declines the exact episode and disposal does not", async () => {
  await createRoot(async (dispose) => {
    const declined: string[] = []
    observeLoginQuestions({
      auth: () => view([question]),
      confirm: async () => false,
      open: () => {},
      decline: async (target) => { declined.push(target.questionId) },
      failed: () => {},
    })
    await Promise.resolve()
    await Promise.resolve()
    expect(declined).toEqual(["episode-b"])
    dispose()
  })
})

test("an undelivered No asks again on the next auth publication", async () => {
  await createRoot(async (dispose) => {
    const [auth, publish] = createSignal(view([question]))
    let asked = 0
    const answers: ((yes: boolean) => void)[] = []
    observeLoginQuestions({
      auth,
      confirm: () => { asked++; return new Promise((resolve) => { answers.push(resolve) }) },
      open: () => {},
      decline: async () => { throw new Error("transport disconnected") },
      failed: () => {},
    })
    try {
      await Promise.resolve()
      answers[0]!(false)
      for (let index = 0; index < 8; index++) await Promise.resolve()
      publish(view([question]))
      await Promise.resolve()
      expect(asked).toBe(2)
    } finally { dispose() }
  })
})
