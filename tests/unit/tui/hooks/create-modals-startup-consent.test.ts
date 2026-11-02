import { afterEach, expect, test } from "bun:test"
import type { RuntimeClient, RuntimeQuery } from "../../../../src/protocol/app-service-types.js"
import type { RuntimeAuthView } from "../../../../src/protocol/auth-status-protocol-types.js"
import { inspectActiveProfileConsent } from "../../../../src/tui/hooks/create-modals.js"
import { runtimeDispatch, runtimeQuery } from "../../../helpers/runtime-dispatch.js"

const accountCorrelationId = "account-correlation"
const originalDialogPolicy = process.env.FLYWHEEL_TEST_SUPPRESS_AUTO_DIALOGS
afterEach(() => {
  if (originalDialogPolicy === undefined) delete process.env.FLYWHEEL_TEST_SUPPRESS_AUTO_DIALOGS
  else process.env.FLYWHEEL_TEST_SUPPRESS_AUTO_DIALOGS = originalDialogPolicy
})
const auth: RuntimeAuthView = {
  profile: { id: "default", displayName: "Default", source: "default", availableProfiles: [{ id: "default", displayName: "Default" }] },
  providers: [],
  warnings: [],
  subscriptionSpendConsent: {
    kind: "available",
    profileId: "default",
    usageGeneration: 1,
    authorityIncarnation: "authority",
    authorityRevision: 1,
    accounts: [{
      providerId: "chatgpt",
      providerDisplayName: "ChatGPT",
      accountCorrelationId,
      providerStatus: "ok",
      modes: [{ mode: "prepaid", envelopeId: "subscription", evidence: { kind: "prepaid", availability: "available" }, decision: "unreviewed" }],
    }],
  },
}

/** A runtime query that records each request and answers it with the auth snapshot at position 17, the only query this hook makes. */
function snapshotQuery(record: (request: RuntimeQuery) => void): RuntimeClient["query"] {
  return runtimeQuery({ authStatusSnapshot: async (request) => {
    record(request)
    return { auth, snapshotPosition: 17 }
  } })
}

test("startup asks the paid-use question from the cached consent snapshot without joining auth refresh", async () => {
  const requests: Array<{ kind: "query" | "dispatch"; type: string }> = []
  const opened: unknown[][] = []
  const appService = {
    query: snapshotQuery((request) => { requests.push({ kind: "query", type: request.type }) }),
    dispatch: (request) => {
      requests.push({ kind: "dispatch", type: request.type })
      return new Promise<never>(() => {})
    },
  } satisfies Pick<RuntimeClient, "query" | "dispatch">

  await inspectActiveProfileConsent({
    appService,
    auth: () => auth,
    authScope: () => ({ kind: "session", sessionId: "session-1" }),
    agentState: () => "idle",
    showRefreshFailure: () => {},
    openPaidUseQuestion: (...args) => { opened.push(args); return true },
  }, false)

  expect(requests).toEqual([{ kind: "query", type: "authStatusSnapshot" }])
  expect(opened).toEqual([[auth, 17, "chatgpt", accountCorrelationId]])
})

test.each(["1", "0"])("automatic profile review preserves refresh with suppression %s", async (flag) => {
  process.env.FLYWHEEL_TEST_SUPPRESS_AUTO_DIALOGS = flag
  const requests: string[] = []
  const opened: unknown[][] = []
  const appService = {
    dispatch: runtimeDispatch({ "auth.refresh": async (request) => { requests.push(request.type); return { ok: true } } }),
    query: snapshotQuery((request) => { requests.push(request.type) }),
  } satisfies Pick<RuntimeClient, "query" | "dispatch">

  await inspectActiveProfileConsent({
    appService, auth: () => auth, authScope: () => ({ kind: "session", sessionId: "session-1" }),
    agentState: () => "idle", showRefreshFailure: () => {},
    openPaidUseQuestion: (...args) => { opened.push(args); return true },
  }, true, true)

  expect(requests).toEqual(["auth.refresh", "authStatusSnapshot"])
  expect(opened).toEqual(flag === "1" ? [] : [[auth, 17, "chatgpt", accountCorrelationId]])
})
