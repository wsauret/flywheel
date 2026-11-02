import { expect, test } from "bun:test"
import { loginQuestions } from "../../../../src/protocol/client/auth-status-state.js"
import { LOGIN_QUESTION_COPY } from "../../../../src/protocol/client/provider-account-copy.js"
import type { RuntimeAuthLoginQuestion } from "../../../../src/protocol/auth-status-protocol-types.js"

test("login questions preserve owner order across foreground scopes and accept older views", () => {
  const first: RuntimeAuthLoginQuestion = { questionId: "one", providerId: "provider", instanceId: "account", profileId: "b", profileDisplayName: "Profile B", providerDisplayName: "Provider", accountDisplayName: "person@example.com" }
  const second = { ...first, questionId: "two" }
  expect(loginQuestions(undefined)).toEqual([])
  expect(loginQuestions({})).toEqual([])
  const questions = [first, second]
  expect(loginQuestions({ loginQuestions: questions })).toBe(questions)
  expect(LOGIN_QUESTION_COPY.detail(first)).toContain("person@example.com")
  expect(LOGIN_QUESTION_COPY.detail(first)).toContain("Profile B")
  expect(LOGIN_QUESTION_COPY.detail(first)).toContain("this project")
  expect(LOGIN_QUESTION_COPY.detail(first)).toContain("login error")
})
