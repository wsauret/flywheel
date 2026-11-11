import { describe, expect, test } from "bun:test"
import { Redacted } from "effect"
import { existsSync, linkSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { AuthProfileStore } from "../../../../src/infra/auth/auth-profile-store.js"
import { captureHeadlessSnapshotConnection, type CapturedHeadlessSnapshot, type HeadlessAuthSnapshot, readHeadlessAuthSnapshot } from "../../../../src/orchestration/headless/benchmark-auth-file.js"
import type { AccessProviderCandidate } from "../../../../src/infra/llm/access-provider.js"
import { credentialForCandidate } from "../../../../src/orchestration/agent-runtime/llm/client-factory.js"
import { QuotaExhaustedError } from "../../../../src/orchestration/agent-runtime/llm/errors.js"
import { createProviderAvailability } from "../../../../src/orchestration/agent-runtime/llm/provider-availability.js"
import { accountLimitResetAtMs, cliFailure } from "../../../../src/orchestration/modules/provider-claude-agent-sdk/sdk-events.js"
import { chain, fakeClient, served, subscriptionCandidate, textStream, throwingStream } from "../agent-runtime/llm/_provider-chain-harness.js"

import { apiKey } from "../../../../src/infra/auth/auth-context.js"
import { resolveHeadlessAuth } from "../../../../src/orchestration/headless/headless-profile-runtime.js"
import { fixture, PROVIDERS, privateStage } from "./_auth-snapshot-fixtures.js"
import { resolveSessionAuthProfile } from "../../../../src/orchestration/session/session-auth-profile.js"

const VERTEX_LINEAGE = crypto.randomUUID()

describe("headless auth snapshot", () => {
  test("consumes one private selected-profile snapshot", () => {
    const bundle: HeadlessAuthSnapshot = {
      profile: "Work",
      credentials: {
        openai_api: { type: "api_key", key: "openai-key", lineageId: crypto.randomUUID() },
        chatgpt: [{ id: "chatgpt-primary", identity: "chatgpt@example.com", lineageId: crypto.randomUUID(), credential: { type: "oauth", access: "chatgpt-token", expires: 456 } }],
        github_copilot: [{ id: "copilot-primary", identity: "copilot@example.com", lineageId: crypto.randomUUID(), credential: { type: "oauth", access: "copilot-token", refresh: "github-token", expires: 123 } }],
      },
    }
    const { directory, path } = fixture(JSON.stringify(bundle))
    try {
      expect(readHeadlessAuthSnapshot(path, PROVIDERS)).toEqual(bundle)
      expect(existsSync(path)).toBe(false)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  test("round-trips a subscription account into an access-only connection", async () => {
    const candidate = { id: "account-a", identity: "alice@example.com", label: "Personal", lineageId: crypto.randomUUID(), credential: { type: "oauth" as const, access: "oauth-a", refresh: "refresh-a", expires: 123 } }
    const { directory, path } = fixture(JSON.stringify({ profile: "Work", credentials: { github_copilot: [candidate] } }))
    try {
      const snapshot = await captureHeadlessSnapshotConnection(readHeadlessAuthSnapshot(path, PROVIDERS), directory, PROVIDERS)
      expect(snapshot?.connection.oauthPersistence).toBe("access-only")
      const credentials = snapshot?.connection.subscriptionCredentials.get("github_copilot")
      expect(credentials?.map(({ instanceId, identity, label, lineageId, credential }) => ({ instanceId, identity, label, lineageId, type: credential.type, expires: credential.type === "oauth" ? credential.expires : undefined }))).toEqual([
        { instanceId: "account-a", identity: "alice@example.com", label: "Personal", lineageId: candidate.lineageId, type: "oauth", expires: 123 },
      ])
      expect(credentials?.map(({ credential }) => credential.type === "oauth" ? [Redacted.value(credential.access), credential.refresh === undefined ? undefined : Redacted.value(credential.refresh)] : undefined)).toEqual([
        ["oauth-a", "refresh-a"],
      ])
      expect(existsSync(path)).toBe(false)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  test("refuses a snapshot with two accounts of one subscription provider and names the provider", () => {
    const account = (id: string) => ({ id, identity: `${id}@example.com`, lineageId: crypto.randomUUID(), credential: { type: "oauth", access: `${id}-access`, expires: 1 } })
    const { directory, path } = fixture(JSON.stringify({ profile: "Work", credentials: { chatgpt: [account("one"), account("two")] } }))
    try {
      expect(() => readHeadlessAuthSnapshot(path, PROVIDERS)).toThrow("this profile has 2 chatgpt accounts")
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  test("each token of a token login is its own account, and a weekly usage limit of one token moves the run to the next token, also for its next request; release removes every token's engine directory", async () => {
    const tokens = ["sk-ant-oat-first-token", "sk-ant-oat-second-token"]
    const { directory, path } = fixture(JSON.stringify({ profile: "benchmark", credentials: {}, externalLogins: { claude_agent_sdk: tokens.map((access) => ({ access })) } }))
    const owner = createProviderAvailability()
    let captured: CapturedHeadlessSnapshot | undefined
    try {
      captured = await captureHeadlessSnapshotConnection(readHeadlessAuthSnapshot(path, PROVIDERS), directory, PROVIDERS)
      const connection = captured.connection
      const accounts = connection.subscriptionCredentials.get("claude_agent_sdk") ?? []
      const configDirs = accounts.map(({ credential }) => credential.type === "external" ? credential.configDir : "")
      expect(accounts.map(({ credential }) => credential.type === "external" && credential.token !== undefined ? Redacted.value(credential.token) : undefined).toSorted()).toEqual(tokens)
      expect(new Set(accounts.flatMap(({ instanceId, lineageId }) => [instanceId, lineageId])).size).toBe(2)
      expect(new Set(configDirs).size).toBe(2)

      // The real availability owner and the engine's own classification of its weekly refusal decide the walk.
      const candidates = accounts.map(({ instanceId }) => subscriptionCandidate("claude_agent_sdk", instanceId))
      const availability = owner.forCandidates(captured.profileId, candidates)
      const spent = candidates[0]!
      const other = candidates[1]!
      const weekly = "You've hit your weekly limit · resets Nov 14, 9am (America/Chicago)"
      const resetsAtMs = accountLimitResetAtMs({ status: "rejected", rateLimitType: "seven_day", resetsAt: Math.floor(Date.now() / 1000) + 3 * 86_400 })
      const builds: string[] = []
      const instanceOf = (candidate: AccessProviderCandidate) => candidate.kind === "subscription" ? candidate.instanceId : ""
      const client = chain({
        availability,
        candidates,
        build: async (provider, { candidate }) => {
          if (credentialForCandidate(connection, candidate)?.type !== "external") throw new Error("the candidate has no token login")
          builds.push(instanceOf(candidate))
          if (instanceOf(candidate) !== instanceOf(spent)) return fakeClient(provider, textStream(instanceOf(candidate)))
          const refusal = cliFailure({ error: "rate_limit", text: weekly }, { isError: true, status: 429, terminalReason: undefined, text: weekly, userMessageUuid: undefined }, (reset) => availability.markQuotaExhausted(candidate, reset), resetsAtMs)
          if (!(refusal instanceof QuotaExhaustedError)) throw new Error(`the weekly refusal is a ${refusal.name}`)
          return fakeClient(provider, throwingStream(refusal))
        },
      })
      expect(await served(client)).toBe(instanceOf(other))
      expect(builds.splice(0)).toEqual([instanceOf(spent), instanceOf(other)])
      expect(await served(client)).toBe(instanceOf(other))
      expect(builds).toEqual([instanceOf(other)])

      captured.release()
      for (const configDir of configDirs) expect(existsSync(configDir)).toBe(false)
    } finally {
      captured?.release()
      await owner.dispose()
      rmSync(directory, { recursive: true, force: true })
    }
  })

  test("says that a missing snapshot was consumed by an earlier run", () => {
    const directory = privateStage(tmpdir())
    try {
      expect(() => readHeadlessAuthSnapshot(join(directory, "auth.json"), PROVIDERS)).toThrow("A snapshot works for one run only")
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  test.each([
    ["empty", ""],
    ["malformed JSON", "{"],
    ["excess field", JSON.stringify({ profile: "Work", credentials: { github_copilot: { type: "oauth", access: "a", refresh: "r", expires: 1 } }, EXTRA: "no" })],
    ["oversized", "x".repeat(64 * 1024 + 1)],
    ["unknown provider", JSON.stringify({ profile: "Work", credentials: { unknown_provider: { type: "api_key", key: "secret", lineageId: crypto.randomUUID() } } })],
    ["credential command", JSON.stringify({ profile: "Work", credentials: { openai_api: { type: "api_key", key: "!echo not-allowed", lineageId: crypto.randomUUID() } } })],
    ["stale provider membership", JSON.stringify({ profile: "Work", credentials: {}, providerCatalogs: { chatgpt: ["gpt-test"] } })],
    ["unknown access outcome", JSON.stringify({ profile: "Work", credentials: { google_vertex: { type: "api_key", key: "AQ.test", lineageId: VERTEX_LINEAGE } }, modelAccess: [{ account: { kind: "singleton", providerId: "google_vertex" }, lineage: VERTEX_LINEAGE, outcomes: { model: "unknown" } }] })],
    ["access result for another singleton credential generation", JSON.stringify({ profile: "Work", credentials: { google_vertex: { type: "api_key", key: "AQ.test", lineageId: VERTEX_LINEAGE } }, modelAccess: [{ account: { kind: "singleton", providerId: "google_vertex" }, lineage: crypto.randomUUID(), outcomes: { model: "completed" } }] })],
    ["access account without its credential", JSON.stringify({ profile: "Work", credentials: {}, modelAccess: [{ account: { kind: "singleton", providerId: "google_vertex" }, lineage: crypto.randomUUID(), outcomes: { model: "completed" } }] })],
    ["access result for another credential generation", JSON.stringify({ profile: "Work", credentials: { supergrok: [{ id: "one", identity: "person", lineageId: crypto.randomUUID(), credential: { type: "oauth", access: "a", expires: 123 } }] }, modelAccess: [{ account: { kind: "subscription", providerId: "supergrok", instanceId: "one" }, lineage: crypto.randomUUID(), outcomes: { model: "completed" } }] })],
    // An access-only run never rotates, so a snapshot (also one an older binary wrote) carries no rotating refresh token.
    ["ChatGPT refresh token", JSON.stringify({ profile: "Work", credentials: { chatgpt: [{ id: "one", identity: "person", lineageId: crypto.randomUUID(), credential: { type: "oauth", access: "a", refresh: "r", expires: 123 } }] } })],
    ["SuperGrok refresh token", JSON.stringify({ profile: "Work", credentials: { supergrok: [{ id: "one", identity: "person", lineageId: crypto.randomUUID(), credential: { type: "oauth", access: "a", refresh: "r", expires: 123 } }] } })],
    ["token login of a provider that takes none", JSON.stringify({ profile: "Work", credentials: {}, externalLogins: { chatgpt: [{ access: "token" }] } })],
    ["token login of an uninstalled provider", JSON.stringify({ profile: "Work", credentials: {}, externalLogins: { no_such_provider: [{ access: "token" }] } })],
    ["empty token login", JSON.stringify({ profile: "Work", credentials: {}, externalLogins: { claude_agent_sdk: [{ access: "" }] } })],
    ["token login without a token", JSON.stringify({ profile: "Work", credentials: {}, externalLogins: { claude_agent_sdk: [] } })],
    // A snapshot that an older binary wrote holds one token login object. It is a one-use transient file, so the
    // reader refuses it with no conversion, and the remedy is a new export.
    ["token login of one object", JSON.stringify({ profile: "Work", credentials: {}, externalLogins: { claude_agent_sdk: { access: "token" } } })],
  ])("rejects and consumes %s content", (_name, content) => {
    const { directory, path } = fixture(content)
    try {
      expect(() => readHeadlessAuthSnapshot(path, PROVIDERS)).toThrow()
      expect(existsSync(path)).toBe(false)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  test.each([
    ["empty identity", { id: "one", identity: "", lineageId: crypto.randomUUID(), credential: { type: "oauth", access: "a", expires: 1 } }],
    ["oversized identity", { id: "one", identity: "x".repeat(1025), lineageId: crypto.randomUUID(), credential: { type: "oauth", access: "a", expires: 1 } }],
    ["missing lineage", { id: "one", identity: "one@example.com", credential: { type: "oauth", access: "a", expires: 1 } }],
    ["wrong credential type", { id: "one", identity: "one@example.com", lineageId: crypto.randomUUID(), credential: { type: "api_key", key: "a" } }],
  ])("rejects and consumes a subscription instance with %s", (_name, instance) => {
    const { directory, path } = fixture(JSON.stringify({ profile: "Work", credentials: { github_copilot: [instance] } }))
    try {
      expect(() => readHeadlessAuthSnapshot(path, PROVIDERS)).toThrow()
      expect(existsSync(path)).toBe(false)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  test.each([
    ["an OAuth scalar in an API-key provider slot", { openai_api: { type: "oauth", access: "oauth", expires: 1, lineageId: crypto.randomUUID() } }],
    // A snapshot that an older binary wrote carries no singleton lineage. It is a one-use transient file, so the
    // reader refuses it with no conversion, and the remedy is a new export.
    ["a singleton credential without its lineage", { deepseek: { type: "api_key", key: "deepseek-key" } }],
  ])("rejects and consumes %s, naming the export that replaces the snapshot", (_name, credentials) => {
    const { directory, path } = fixture(JSON.stringify({ profile: "Work", credentials }))
    try {
      expect(() => readHeadlessAuthSnapshot(path, PROVIDERS)).toThrow("Headless auth snapshot content is invalid. Export a new one with `flywheel headless snapshot-auth`")
      expect(existsSync(path)).toBe(false)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  test.each([
    ["duplicate ID", [
      { id: "same", identity: "one@example.com", lineageId: crypto.randomUUID(), credential: { type: "oauth", access: "a", expires: 1 } },
      { id: "same", identity: "two@example.com", lineageId: crypto.randomUUID(), credential: { type: "oauth", access: "b", expires: 1 } },
    ]],
    ["duplicate identity", [
      { id: "one", identity: "same@example.com", lineageId: crypto.randomUUID(), credential: { type: "oauth", access: "a", expires: 1 } },
      { id: "two", identity: "same@example.com", lineageId: crypto.randomUUID(), credential: { type: "oauth", access: "b", expires: 1 } },
    ]],
  ])("rejects and consumes a collection with %s", (_name, instances) => {
    const { directory, path } = fixture(JSON.stringify({ profile: "Work", credentials: { github_copilot: instances } }))
    try {
      expect(() => readHeadlessAuthSnapshot(path, PROVIDERS)).toThrow()
      expect(existsSync(path)).toBe(false)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  test("refuses to consume an unrelated private file", () => {
    const directory = mkdtempSync(join(tmpdir(), "flywheel-unrelated-private-"))
    const path = join(directory, "auth.json")
    writeFileSync(path, JSON.stringify({ profile: "Work", credentials: {} }), { mode: 0o600 })
    try {
      expect(() => readHeadlessAuthSnapshot(path, PROVIDERS)).toThrow("dedicated stage")
      expect(existsSync(path)).toBe(true)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  // A file mode is the POSIX statement of privacy. Windows holds file privacy
  // through the containing stage's ACL instead, so a group-readable mode is not
  // a rejection ground there and this case has nothing to assert.
  test.skipIf(process.platform === "win32")("rejects and consumes a non-private file", () => {
    const { directory, path } = fixture(JSON.stringify({ profile: "Work", credentials: { github_copilot: { type: "oauth", access: "a", refresh: "r", expires: 1 } } }), 0o644)
    try {
      expect(() => readHeadlessAuthSnapshot(path, PROVIDERS)).toThrow("private, owner-controlled")
      expect(existsSync(path)).toBe(false)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  test("rejects and consumes a multiply-linked file name", () => {
    const { directory, path } = fixture(JSON.stringify({ profile: "Work", credentials: { github_copilot: { type: "oauth", access: "a", refresh: "r", expires: 1 } } }))
    const other = join(directory, "other.json")
    linkSync(path, other)
    try {
      expect(() => readHeadlessAuthSnapshot(path, PROVIDERS)).toThrow("private, owner-controlled")
      expect(existsSync(path)).toBe(false)
      expect(existsSync(other)).toBe(true)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  test("refuses a symlink without deleting its target", () => {
    const { directory, path: target } = fixture(JSON.stringify({ profile: "Work", credentials: { github_copilot: { type: "oauth", access: "a", refresh: "r", expires: 1 } } }))
    const link = join(directory, "link.json")
    symlinkSync(target, link)
    try {
      expect(() => readHeadlessAuthSnapshot(link, PROVIDERS)).toThrow()
      expect(existsSync(target)).toBe(true)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  test("a run in an empty account home creates the snapshot's own profile and serves its credentials, and only with a snapshot", async () => {
    const root = mkdtempSync(join(tmpdir(), "flywheel-headless-auth-fresh-home-"))
    const userDataRoot = join(root, "fresh-home", ".flywheel")
    const { directory, path } = fixture(JSON.stringify({ profile: "benchmark", credentials: { openai_api: { type: "api_key", key: "transferred-key", lineageId: crypto.randomUUID() } } }))
    try {
      await expect(resolveHeadlessAuth({ userDataRoot, projectRoot: root }, { profile: "benchmark" }, PROVIDERS)).rejects.toThrow("auth profile does not exist: benchmark")
      const resolved = await resolveHeadlessAuth({ userDataRoot, projectRoot: root }, { profile: "benchmark", snapshotPath: path }, PROVIDERS)
      expect(resolved.profile.id).toBe("benchmark")
      expect(existsSync(resolved.profile.directory)).toBe(true)
      const key = resolved.snapshot === undefined ? undefined : apiKey(resolved.snapshot.connection.auth, "openai_api")
      expect(key === undefined ? undefined : Redacted.value(key)).toBe("transferred-key")
      expect(existsSync(path)).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
      rmSync(directory, { recursive: true, force: true })
    }
  })

  test("refuses a run that selects another profile than its snapshot names, after consuming the snapshot, and creates no profile", async () => {
    const root = mkdtempSync(join(tmpdir(), "flywheel-headless-auth-other-profile-"))
    const userDataRoot = join(root, "fresh-home", ".flywheel")
    const { directory, path } = fixture(JSON.stringify({ profile: "benchmark", credentials: {} }))
    try {
      await expect(resolveHeadlessAuth({ userDataRoot, projectRoot: root }, { profile: "typo", snapshotPath: path }, PROVIDERS)).rejects.toThrow("The headless auth snapshot is for profile benchmark, but this run selects profile typo. Run with --auth-profile benchmark.")
      expect(existsSync(path)).toBe(false)
      for (const id of ["typo", "benchmark"]) {
        await expect(resolveHeadlessAuth({ userDataRoot, projectRoot: root }, { profile: id }, PROVIDERS)).rejects.toThrow(`auth profile does not exist: ${id}`)
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
      rmSync(directory, { recursive: true, force: true })
    }
  })

  test("a snapshot run without a selector serves the snapshot's profile for every session, also an attached session that recorded another profile", async () => {
    const root = mkdtempSync(join(tmpdir(), "flywheel-headless-auth-bound-"))
    const userDataRoot = join(root, "home", ".flywheel")
    const other = await new AuthProfileStore(userDataRoot).create("other", "other")
    other.close()
    const { directory, path } = fixture(JSON.stringify({ profile: "benchmark", credentials: { openai_api: { type: "api_key", key: "transferred-key", lineageId: crypto.randomUUID() } } }))
    try {
      const resolved = await resolveHeadlessAuth({ userDataRoot, projectRoot: root, env: {} }, { snapshotPath: path }, PROVIDERS)
      expect(resolved.profile.id).toBe("benchmark")
      expect(resolveSessionAuthProfile({ authProfileId: "other" }, resolved.profiles.inspect()).effectiveId).toBe("benchmark")
      expect(resolveSessionAuthProfile({}, resolved.profiles.inspect()).effectiveId).toBe("benchmark")
    } finally {
      rmSync(root, { recursive: true, force: true })
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
