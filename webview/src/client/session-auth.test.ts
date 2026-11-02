import assert from "node:assert/strict"
import { test } from "node:test"
import { createRuntimeSession } from "./session.js"
import { authView, fakeConnection, provider, settle } from "./session-connection-fixture.js"
import type { FrontendEvent } from "../../../src/protocol/app-service-types.js"
import type { RuntimeAuthStatusSnapshotResult } from "../../../src/protocol/auth-status-protocol-types.js"
import type { RuntimeConnection } from "../../../src/protocol/client/connection.js"
import { runtimeQuery } from "../../../tests/helpers/runtime-dispatch.js"

test("auth intake holds early settlement patches and rejects stale ones", async () => {
  const listeners = new Set<(event: FrontendEvent) => void>()
  const authSnapshot = Promise.withResolvers<RuntimeAuthStatusSnapshotResult>()
  const base = fakeConnection([])
  let authReads = 0
  const query = runtimeQuery({ authStatusSnapshot: async () => {
    authReads += 1
    return await authSnapshot.promise
  } }, base.query)
  const connection: RuntimeConnection = {
    ...base,
    query,
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  }
  const session = createRuntimeSession({ connection })
  const status = () => session.authStatus
  const settlement = { kind: "failed" as const, operationId: "oauth-operation", providerId: "chatgpt", message: "OAuth state mismatch" }
  const auth = { ...authView([]), settlement }

  for (const listener of listeners) {
    listener({
      type: "patch",
      patch: {
        cursor: { scope: "workspace", domain: "auth" },
        position: 2,
        prevPosition: 1,
        payload: { kind: "auth.changed", auth },
      },
    })
  }

  assert.equal(status(), undefined)
  authSnapshot.resolve({ auth: authView([]), snapshotPosition: 1 })
  await settle()
  assert.equal(authReads, 2)
  assert.equal(status()?.snapshotPosition, 2)
  assert.deepEqual(status()?.auth.settlement, settlement)

  for (const listener of listeners) {
    listener({
      type: "patch",
      patch: {
        cursor: { scope: "workspace", domain: "auth" },
        position: 1,
        prevPosition: 0,
        payload: { kind: "auth.changed", auth: { ...auth, settlement: { kind: "completed", operationId: "stale", providerId: "chatgpt" } } },
      },
    })
  }
  assert.equal(authReads, 2)
  assert.deepEqual(status()?.auth.settlement, settlement)
  session.dispose()
})

test("an unanswered auth read is not treated as no providers", async () => {
  const session = createRuntimeSession({ connection: fakeConnection("never-answers") })
  await settle()
  // Otherwise every user sees the setup screen for as long as the read takes,
  // including the ones who connected a provider months ago.
  assert.equal(session.providerSetup, "loading")
  assert.deepEqual(session.providers, [])
  session.dispose()
})

test("a read that finds nothing connected opens the setup screen", async () => {
  const session = createRuntimeSession({
    connection: fakeConnection([provider({ source: "unconfigured" })]),
  })
  await settle()
  assert.equal(session.providerSetup, "none")
  assert.equal(session.providers.length, 1)
  assert.equal(session.providers[0]?.connected, false)
  session.dispose()
})

test("an expired credential does not count as usable", async () => {
  const session = createRuntimeSession({
    connection: fakeConnection([provider({ source: "oauth", expired: true })]),
  })
  await settle()
  // The panel must send this user back through login rather than let them ask a
  // question that will fail on the first token.
  assert.equal(session.providerSetup, "none")
  assert.equal(session.providers[0]?.expired, true)
  session.dispose()
})

test("one working provider is enough, alongside broken ones", async () => {
  const session = createRuntimeSession({
    connection: fakeConnection([
      provider({ providerId: "openai", displayName: "OpenAI", source: "unconfigured" }),
      provider({ providerId: "anthropic", displayName: "Anthropic", source: "stored_key" }),
    ]),
  })
  await settle()
  assert.equal(session.providerSetup, "usable")
  session.dispose()
})

test("a rejected credential is reported as rejected, not as never connected", async () => {
  const session = createRuntimeSession({
    connection: fakeConnection([provider({ source: "invalid" })]),
  })
  await settle()
  assert.equal(session.providerSetup, "none")
  assert.equal(session.providers[0]?.source, "invalid")
  session.dispose()
})

test("a misconfigured provider carries the loader's reason", async () => {
  const session = createRuntimeSession({
    connection: fakeConnection([provider({ source: "misconfigured", detail: "missing base_url" })]),
  })
  await settle()
  // Telling this user to "paste an API key" sends them to do something that
  // cannot fix it.
  assert.equal(session.providers[0]?.detail, "missing base_url")
  session.dispose()
})

test("only model providers are offered", async () => {
  const session = createRuntimeSession({
    connection: fakeConnection([
      provider({ providerId: "tavily", displayName: "Tavily", group: "web", source: "unconfigured" }),
    ]),
  })
  await settle()
  // A search key in the "connect a model provider" list sends the user to
  // configure something that will not make the panel work.
  assert.deepEqual(session.providers, [])
  session.dispose()
})

test("providers are listed in a stable order", async () => {
  const session = createRuntimeSession({
    connection: fakeConnection([
      provider({ providerId: "openai", displayName: "OpenAI", source: "unconfigured" }),
      provider({ providerId: "anthropic", displayName: "Anthropic", source: "unconfigured" }),
    ]),
  })
  await settle()
  // The runtime does not promise an order, and a list that reshuffles under the
  // cursor is a list people mis-click.
  assert.deepEqual(session.providers.map((entry) => entry.displayName), ["Anthropic", "OpenAI"])
  session.dispose()
})
