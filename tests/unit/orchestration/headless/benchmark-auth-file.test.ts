import { describe, expect, spyOn, test } from "bun:test"
import { Redacted } from "effect"
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { AuthProfileStore } from "../../../../src/infra/auth/auth-profile-store.js"
import { captureHeadlessSnapshotConnection, type HeadlessAuthSnapshot, readHeadlessAuthSnapshot, writeHeadlessAuthSnapshot } from "../../../../src/orchestration/headless/benchmark-auth-file.js"
import { applyWindowsPrivateDirectoryAcl } from "../../../../src/infra/windows-private-directory-acl.js"
import { testDirectories } from "../../../helpers/directories.js"
import { composeFirstPartyModules } from "../../../../src/orchestration/modules.js"

import { accessProviderRegistry } from "../../../../src/orchestration/agent-runtime/llm/access-provider-registry.js"
import { credentialIdOf, type AccessProviderDefinition } from "../../../../src/infra/llm/access-provider.js"
import { apiKey, type RuntimeOAuthCredential } from "../../../../src/infra/auth/auth-context.js"
import { AuthProfileManager } from "../../../../src/orchestration/auth/auth-profile-manager.js"
import { resolveHeadlessAuth } from "../../../../src/orchestration/headless/headless-profile-runtime.js"
import { createClaudeAgentSdkModule } from "../../../../src/orchestration/modules/provider-claude-agent-sdk/module.js"
import { readSavedProviderModels, recordProviderModelAccess, writeProviderModelCandidates } from "../../../../src/infra/auth/provider-model-catalog-store.js"
import { DEFAULT_DYNAMIC_CATALOG_LIMITS } from "../../../../src/infra/llm/model-catalog-resolution.js"
import { catalogProfile } from "../../../helpers/catalog-profile.js"
import { credentialSlotClassifier } from "../../../../src/orchestration/auth/credential-slot-classifier.js"
import { LOGIN_ACCOUNTS_DIRECTORY } from "../../../../src/orchestration/modules/provider-claude-agent-sdk/names.js"
/** A stage prepared the way the snapshot reader demands: private to this
 *  account. POSIX states that with the directory mode; Windows keeps no mode
 *  bits, so the owner-only ACL is what an operator applies and what the reader
 *  verifies there. */
function privateStage(parent: string): string {
  const stage = mkdtempSync(join(parent, "flywheel-auth-bundle-"))
  if (process.platform === "win32") applyWindowsPrivateDirectoryAcl(stage)
  else chmodSync(stage, 0o700)
  return stage
}

function fixture(content: string, mode = 0o600) {
  const directory = privateStage(tmpdir())
  const path = join(directory, "auth.json")
  writeFileSync(path, content)
  chmodSync(path, mode)
  return { directory, path }
}

const PROVIDERS = accessProviderRegistry(composeFirstPartyModules()).selection.definitions

/** The installed providers, with ChatGPT's host rotation replaced so that a test decides what the provider answers. */
function withChatGptRefresh(refresh: (credential: RuntimeOAuthCredential) => Promise<RuntimeOAuthCredential>): readonly AccessProviderDefinition[] {
  return PROVIDERS.map((provider) => provider.id === "chatgpt" && provider.auth.kind === "oauth" ? { ...provider, auth: { ...provider.auth, refresh } } : provider)
}

describe("headless auth snapshot", () => {
  test("consumes one private selected-profile snapshot", () => {
    const bundle: HeadlessAuthSnapshot = {
      profile: "Work",
      credentials: {
        openai_api: { type: "api_key", key: "openai-key" },
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
    ["unknown provider", JSON.stringify({ profile: "Work", credentials: { unknown_provider: { type: "api_key", key: "secret" } } })],
    ["credential command", JSON.stringify({ profile: "Work", credentials: { openai_api: { type: "api_key", key: "!echo not-allowed" } } })],
    ["stale provider membership", JSON.stringify({ profile: "Work", credentials: {}, providerCatalogs: { chatgpt: ["gpt-test"] } })],
    ["unknown access outcome", JSON.stringify({ profile: "Work", credentials: { google_vertex: { type: "api_key", key: "AQ.test" } }, modelAccess: [{ account: { kind: "singleton", providerId: "google_vertex" }, lineage: crypto.randomUUID(), outcomes: { model: "unknown" } }] })],
    ["access account without its credential", JSON.stringify({ profile: "Work", credentials: {}, modelAccess: [{ account: { kind: "singleton", providerId: "google_vertex" }, lineage: crypto.randomUUID(), outcomes: { model: "completed" } }] })],
    ["access result for another credential generation", JSON.stringify({ profile: "Work", credentials: { supergrok: [{ id: "one", identity: "person", lineageId: crypto.randomUUID(), credential: { type: "oauth", access: "a", expires: 123 } }] }, modelAccess: [{ account: { kind: "subscription", providerId: "supergrok", instanceId: "one" }, lineage: crypto.randomUUID(), outcomes: { model: "completed" } }] })],
    // An access-only run never rotates, so a snapshot (also one an older binary wrote) carries no rotating refresh token.
    ["ChatGPT refresh token", JSON.stringify({ profile: "Work", credentials: { chatgpt: [{ id: "one", identity: "person", lineageId: crypto.randomUUID(), credential: { type: "oauth", access: "a", refresh: "r", expires: 123 } }] } })],
    ["SuperGrok refresh token", JSON.stringify({ profile: "Work", credentials: { supergrok: [{ id: "one", identity: "person", lineageId: crypto.randomUUID(), credential: { type: "oauth", access: "a", refresh: "r", expires: 123 } }] } })],
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

  test("rejects and consumes an OAuth scalar in an API-key provider slot", () => {
    const { directory, path } = fixture(JSON.stringify({
      profile: "Work",
      credentials: { openai_api: { type: "oauth", access: "oauth", expires: 1 } },
    }))
    try {
      expect(() => readHeadlessAuthSnapshot(path, PROVIDERS)).toThrow("content is invalid")
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
})

  test("exports a display-name-selected profile with resolved credentials only", async () => {
    const root = mkdtempSync(join(tmpdir(), "flywheel-headless-auth-writer-"))
    const directories = testDirectories(root)
    const access = await new AuthProfileStore(directories.userDataRoot).create("canonical", "Work Profile")
    const vertexLineage = crypto.randomUUID()
    const grokLineage = crypto.randomUUID()
    access.writeFile("auth.json", JSON.stringify({
      anthropic_api: { type: "api_key", key: "!direct-host-key" },
      openai_api: { lineageId: crypto.randomUUID(), credential: { type: "api_key", key: "!nested-host-key" } },
      github_copilot: [
        { id: "account-a", identity: "alice@example.com", label: "Personal", lineageId: crypto.randomUUID(), credential: { type: "oauth", access: "oauth-a", refresh: "refresh-a", expires: 123 } },
      ],
      google_vertex: { lineageId: vertexLineage, credential: { type: "api_key", key: "AQ.vertex-key" } },
      supergrok: [{ id: "grok-primary", identity: "person", lineageId: grokLineage, credential: { type: "oauth", access: "grok-token", refresh: "grok-refresh", expires: 123 } }],
      chatgpt: [{ id: "chatgpt-primary", identity: "chatgpt@example.com", lineageId: crypto.randomUUID(), credential: { type: "oauth", access: "chatgpt-token", refresh: "chatgpt-refresh", expires: 123, accountId: "account-id" } }],
    }))
    const accounts = [
      { account: { kind: "singleton", providerId: "google_vertex" } as const, lineage: vertexLineage },
      { account: { kind: "subscription", providerId: "supergrok", instanceId: "grok-primary" } as const, lineage: grokLineage },
    ]
    const profileStore = catalogProfile(access, PROVIDERS, credentialSlotClassifier(composeFirstPartyModules()))
    for (const { account, lineage } of accounts) {
      const rows = ["allowed", "denied"].map((modelId) => ({ modelId, offerings: [{ wireModelId: modelId, metadata: null, dataUse: "standard" as const }] }))
      expect(await writeProviderModelCandidates(profileStore, account, lineage, rows, ["allowed", "denied"], DEFAULT_DYNAMIC_CATALOG_LIMITS)).toBe(true)
      const generation = readSavedProviderModels(access, account, lineage, DEFAULT_DYNAMIC_CATALOG_LIMITS)?.audit?.generation
      if (generation === undefined) throw new Error("Missing fixture audit")
      expect(await recordProviderModelAccess(profileStore, account, lineage, generation, "allowed", "completed", DEFAULT_DYNAMIC_CATALOG_LIMITS)).toBe(true)
      expect(await recordProviderModelAccess(profileStore, account, lineage, generation, "denied", "refused", DEFAULT_DYNAMIC_CATALOG_LIMITS)).toBe(true)
    }
    access.close()
    const stage = privateStage(root)
    const output = join(stage, "auth.json")
    try {
      const profile = await writeHeadlessAuthSnapshot({
        userDataRoot: directories.userDataRoot,
        projectRoot: directories.projectRoot,
        selector: "work profile",
        output,
        resolveKey: async () => Redacted.make("resolved-secret"),
        providers: PROVIDERS,
      })
      expect(profile).toBe("canonical")
      // Windows reports a fixed mode whatever a write requests, so only POSIX
      // can prove the snapshot was written owner-only.
      if (process.platform !== "win32") expect(statSync(output).mode & 0o777).toBe(0o600)
      const snapshot = JSON.parse(readFileSync(output, "utf8"))
      expect(snapshot.credentials.openai_api.key).toBe("resolved-secret")
      expect(snapshot.credentials.openai_api.key).not.toContain("host-key")
      expect(snapshot.credentials.anthropic_api.key).toBe("resolved-secret")
      // Copilot's run mints its access tokens from the GitHub token, so that one stays; the rotating refresh
      // tokens of ChatGPT and SuperGrok never leave the host.
      expect(snapshot.credentials.github_copilot).toEqual([
        expect.objectContaining({ id: "account-a", identity: "alice@example.com", label: "Personal", lineageId: expect.any(String), credential: { type: "oauth", access: "oauth-a", refresh: "refresh-a", expires: 123 } }),
      ])
      expect(snapshot.credentials.supergrok.map(({ credential }: { credential: unknown }) => credential)).toEqual([{ type: "oauth", access: "grok-token", expires: 123 }])
      expect(snapshot.credentials.chatgpt.map(({ credential }: { credential: unknown }) => credential)).toEqual([{ type: "oauth", access: "chatgpt-token", expires: 123, accountId: "account-id" }])
      expect(readFileSync(output, "utf8")).not.toContain("grok-refresh")
      expect(readFileSync(output, "utf8")).not.toContain("chatgpt-refresh")
      expect(readFileSync(output, "utf8")).toContain("lineageId")
      expect(readFileSync(output, "utf8")).toContain("alice@example.com")
      expect(readFileSync(output, "utf8")).toContain("Personal")
      expect(snapshot.providerCatalogs).toBeUndefined()
      expect(snapshot.modelAccess).toEqual(accounts.map(({ account, lineage }) => ({
        account, lineage, outcomes: { allowed: "completed", denied: "refused" },
      })))
      const captured = await captureHeadlessSnapshotConnection(readHeadlessAuthSnapshot(output, PROVIDERS), stage, PROVIDERS)
      expect(captured?.connection.modelAccess).toEqual(snapshot.modelAccess)
      expect(captured?.connection.auth.credentialLineages.google_vertex).toBe(vertexLineage)
      await writeHeadlessAuthSnapshot({ userDataRoot: directories.userDataRoot, projectRoot: directories.projectRoot, selector: "canonical", output, resolveKey: async () => Redacted.make("unused"), providers: PROVIDERS })
      await expect(writeHeadlessAuthSnapshot({ userDataRoot: directories.userDataRoot, projectRoot: directories.projectRoot, selector: "canonical", output, resolveKey: async () => Redacted.make("unused"), providers: PROVIDERS })).rejects.toThrow("export failed")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("a provider filter exports only the named providers, their model access, and their lifetimes, and a reader of only those providers accepts it", async () => {
    const root = mkdtempSync(join(tmpdir(), "flywheel-headless-auth-filter-"))
    const directories = testDirectories(root)
    const access = await new AuthProfileStore(directories.userDataRoot).create("filtered", "Filtered")
    const vertexLineage = crypto.randomUUID()
    const grokLineage = crypto.randomUUID()
    access.writeFile("auth.json", JSON.stringify({
      openai_api: { type: "api_key", key: "!excluded-helper" },
      github_copilot: [{ id: "copilot", identity: "copilot@example.com", lineageId: crypto.randomUUID(), credential: { type: "oauth", access: "copilot-token", refresh: "copilot-refresh", expires: Date.now() + 10 * 3600_000 } }],
      google_vertex: { lineageId: vertexLineage, credential: { type: "api_key", key: "AQ.vertex-key" } },
      // Short-lived and without a refresh that the test allows: a filter that kept SuperGrok would refuse the export.
      supergrok: [{ id: "grok-primary", identity: "person", lineageId: grokLineage, credential: { type: "oauth", access: "grok-token", refresh: "grok-refresh", expires: Date.now() + 60_000 } }],
      chatgpt: [{ id: "chatgpt-primary", identity: "chatgpt@example.com", lineageId: crypto.randomUUID(), credential: { type: "oauth", access: "chatgpt-token", refresh: "chatgpt-refresh", expires: Date.now() + 10 * 3600_000, accountId: "account-id" } }],
    }))
    const accounts = [
      { account: { kind: "singleton", providerId: "google_vertex" } as const, lineage: vertexLineage },
      { account: { kind: "subscription", providerId: "supergrok", instanceId: "grok-primary" } as const, lineage: grokLineage },
    ]
    const profileStore = catalogProfile(access, PROVIDERS, credentialSlotClassifier(composeFirstPartyModules()))
    for (const { account, lineage } of accounts) {
      const rows = [{ modelId: "allowed", offerings: [{ wireModelId: "allowed", metadata: null, dataUse: "standard" as const }] }]
      expect(await writeProviderModelCandidates(profileStore, account, lineage, rows, ["allowed"], DEFAULT_DYNAMIC_CATALOG_LIMITS)).toBe(true)
      const generation = readSavedProviderModels(access, account, lineage, DEFAULT_DYNAMIC_CATALOG_LIMITS)?.audit?.generation
      if (generation === undefined) throw new Error("Missing fixture audit")
      expect(await recordProviderModelAccess(profileStore, account, lineage, generation, "allowed", "completed", DEFAULT_DYNAMIC_CATALOG_LIMITS)).toBe(true)
    }
    access.close()
    const resolved: string[] = []
    const stage = privateStage(root)
    const output = join(stage, "auth.json")
    try {
      await writeHeadlessAuthSnapshot({
        userDataRoot: directories.userDataRoot, projectRoot: directories.projectRoot, selector: "filtered", output, providers: PROVIDERS, minValidSeconds: 3600, providerIds: ["chatgpt", "google_vertex"],
        resolveKey: async (key) => {
          resolved.push(key)
          return Redacted.make("resolved-secret")
        },
      })
      expect(resolved).toEqual(["AQ.vertex-key"])
      const snapshot = JSON.parse(readFileSync(output, "utf8"))
      expect(Object.keys(snapshot.credentials).sort()).toEqual(["chatgpt", "google_vertex"])
      expect(snapshot.modelAccess).toEqual([{ account: accounts[0]?.account, lineage: vertexLineage, outcomes: { allowed: "completed" } }])
      // The failure this filter removes: a reader whose config enables only the named providers refused the snapshot.
      const enabled = PROVIDERS.filter((provider) => ["chatgpt", "google_vertex"].includes(credentialIdOf(provider)))
      const captured = await captureHeadlessSnapshotConnection(readHeadlessAuthSnapshot(output, enabled), stage, enabled)
      expect(captured.connection.auth.credentialLineages.google_vertex).toBe(vertexLineage)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test.each([
    ["an id that no installed provider declares", "no-such-provider", "no installed provider declares the credential provider id no-such-provider"],
    ["an id that the profile holds no credential for", "deepseek", "the selected profile holds no deepseek credential"],
  ])("refuses a provider filter with %s, naming the id and no secret", async (_name, providerId, refusal) => {
    const root = mkdtempSync(join(tmpdir(), "flywheel-headless-auth-filter-refusal-"))
    const directories = testDirectories(root)
    const access = await new AuthProfileStore(directories.userDataRoot).create(`filter-refusal-${providerId}`, `filter-refusal-${providerId}`)
    access.writeFile("auth.json", JSON.stringify({
      openai_api: { type: "api_key", key: "plain-host-key" },
      chatgpt: [{ id: "one", identity: "one@example.com", lineageId: crypto.randomUUID(), credential: { type: "oauth", access: "chatgpt-token", refresh: "chatgpt-refresh", expires: Date.now() + 10 * 3600_000, accountId: "account-id" } }],
    }))
    access.close()
    const output = join(privateStage(root), "auth.json")
    try {
      const error = await writeHeadlessAuthSnapshot({ userDataRoot: directories.userDataRoot, projectRoot: directories.projectRoot, selector: `filter-refusal-${providerId}`, output, resolveKey: async () => Redacted.make("resolved-secret"), providers: PROVIDERS, providerIds: ["chatgpt", providerId] }).then(() => undefined, (failure: unknown) => failure)
      const message = error instanceof Error ? error.message : ""
      expect(message).toContain(refusal)
      for (const secret of ["plain-host-key", "chatgpt-token", "chatgpt-refresh", "resolved-secret"]) expect(message).not.toContain(secret)
      expect(existsSync(output)).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("refuses to export a profile with two accounts of one subscription provider", async () => {
    const root = mkdtempSync(join(tmpdir(), "flywheel-headless-auth-two-accounts-"))
    const directories = testDirectories(root)
    const access = await new AuthProfileStore(directories.userDataRoot).create("two-accounts", "Two Accounts")
    const account = (id: string) => ({ id, identity: `${id}@example.com`, lineageId: crypto.randomUUID(), credential: { type: "oauth", access: `${id}-access`, refresh: `${id}-refresh`, expires: 1 } })
    access.writeFile("auth.json", JSON.stringify({ chatgpt: [account("one"), account("two")] }))
    access.close()
    const output = join(privateStage(root), "auth.json")
    try {
      await expect(writeHeadlessAuthSnapshot({ userDataRoot: directories.userDataRoot, projectRoot: directories.projectRoot, selector: "two-accounts", output, resolveKey: async () => Redacted.make("unused"), providers: PROVIDERS })).rejects.toThrow("this profile has 2 chatgpt accounts")
      expect(existsSync(output)).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("refreshes on the host a token that would expire before the requested lifetime, saves the rotation, and names the requested profile", async () => {
    const root = mkdtempSync(join(tmpdir(), "flywheel-headless-auth-lifetime-"))
    const directories = testDirectories(root)
    const access = await new AuthProfileStore(directories.userDataRoot).create("lifetime", "Lifetime")
    const authFile = join(access.authDirectory, "auth.json")
    access.writeFile("auth.json", JSON.stringify({ chatgpt: [{ id: "one", identity: "one@example.com", lineageId: crypto.randomUUID(), credential: { type: "oauth", access: "short-access", refresh: "host-refresh-1", expires: Date.now() + 60_000, accountId: "account-id" } }] }))
    access.close()
    const refreshed: string[] = []
    const providers = withChatGptRefresh(async (credential) => {
      refreshed.push(credential.refresh === undefined ? "none" : Redacted.value(credential.refresh))
      return { type: "oauth", access: Redacted.make("rotated-access"), refresh: Redacted.make("host-refresh-2"), expires: Date.now() + 10 * 3600_000, accountId: "account-id" }
    })
    const stage = privateStage(root)
    const output = join(stage, "auth.json")
    try {
      expect(await writeHeadlessAuthSnapshot({ userDataRoot: directories.userDataRoot, projectRoot: directories.projectRoot, selector: "lifetime", output, resolveKey: async () => Redacted.make("unused"), providers, minValidSeconds: 3600, asProfile: "benchmark" })).toBe("benchmark")
      expect(refreshed).toEqual(["host-refresh-1"])
      const snapshot = JSON.parse(readFileSync(output, "utf8"))
      expect(snapshot.profile).toBe("benchmark")
      expect(snapshot.credentials.chatgpt.map(({ credential }: { credential: { access: string; refresh?: string } }) => [credential.access, credential.refresh])).toEqual([["rotated-access", undefined]])
      // The host keeps the rotated refresh token, so its next use of the account does not fail on a spent one.
      expect(JSON.parse(readFileSync(authFile, "utf8")).chatgpt[0].credential).toMatchObject({ access: "rotated-access", refresh: "host-refresh-2" })
      const captured = await captureHeadlessSnapshotConnection(readHeadlessAuthSnapshot(output, providers), stage, providers)
      expect(captured?.profileId).toBe("benchmark")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("judges the requested lifetime after a slow key helper, so a token that ran short meanwhile is refreshed before export", async () => {
    const root = mkdtempSync(join(tmpdir(), "flywheel-headless-auth-slow-helper-"))
    const directories = testDirectories(root)
    const access = await new AuthProfileStore(directories.userDataRoot).create("slow-helper", "Slow Helper")
    access.writeFile("auth.json", JSON.stringify({
      openai_api: { type: "api_key", key: "!slow-helper" },
      chatgpt: [{ id: "one", identity: "one@example.com", lineageId: crypto.randomUUID(), credential: { type: "oauth", access: "first-access", refresh: "host-refresh-1", expires: Date.now() + 2 * 3600_000, accountId: "account-id" } }],
    }))
    access.close()
    const realNow = Date.now.bind(Date)
    let elapsed = 0
    const clock = spyOn(Date, "now").mockImplementation(() => realNow() + elapsed)
    const providers = withChatGptRefresh(async () => ({ type: "oauth", access: Redacted.make("rotated-access"), refresh: Redacted.make("host-refresh-2"), expires: Date.now() + 10 * 3600_000, accountId: "account-id" }))
    const output = join(privateStage(root), "auth.json")
    try {
      await writeHeadlessAuthSnapshot({
        userDataRoot: directories.userDataRoot, projectRoot: directories.projectRoot, selector: "slow-helper", output, providers, minValidSeconds: 3600,
        // The helper runs past the token's margin above the requested lifetime.
        resolveKey: async () => {
          elapsed += 1.5 * 3600_000
          return Redacted.make("helper-key")
        },
      })
      const snapshot = JSON.parse(readFileSync(output, "utf8"))
      expect(snapshot.credentials.chatgpt[0].credential.access).toBe("rotated-access")
      expect(snapshot.credentials.openai_api.key).toBe("helper-key")
    } finally {
      clock.mockRestore()
      rmSync(root, { recursive: true, force: true })
    }
  })

  test.each([
    ["the refresh is still too short", "chatgpt", async () => ({ type: "oauth" as const, access: Redacted.make("rotated-access"), refresh: Redacted.make("host-refresh-2"), expires: Date.now() + 600_000, accountId: "account-id" }), "a refresh on this host did not extend it that far"],
    ["the refresh fails", "chatgpt", async () => { throw new Error("provider said host-refresh-1 is spent") }, "its refresh on this host failed"],
    ["the provider declares no refresh", "github_copilot", undefined, "Flywheel cannot refresh it"],
  ] as const)("refuses an export whose token cannot reach the requested lifetime when %s, naming the provider and both lifetimes", async (_name, providerId, refresh, reason) => {
    const root = mkdtempSync(join(tmpdir(), "flywheel-headless-auth-refusal-"))
    const directories = testDirectories(root)
    const profileId = `refusal-${_name.replaceAll(" ", "-")}`
    const access = await new AuthProfileStore(directories.userDataRoot).create(profileId, profileId)
    access.writeFile("auth.json", JSON.stringify({ [providerId]: [{ id: "one", identity: "one@example.com", lineageId: crypto.randomUUID(), credential: { type: "oauth", access: "short-access", refresh: "host-refresh-1", expires: Date.now() + 60_000, accountId: "account-id" } }] }))
    access.close()
    const output = join(privateStage(root), "auth.json")
    try {
      const error = await writeHeadlessAuthSnapshot({ userDataRoot: directories.userDataRoot, projectRoot: directories.projectRoot, selector: profileId, output, resolveKey: async () => Redacted.make("unused"), providers: refresh === undefined ? PROVIDERS : withChatGptRefresh(refresh), minValidSeconds: 3600 }).then(() => undefined, (failure: unknown) => failure)
      expect(error).toBeInstanceOf(Error)
      const message = error instanceof Error ? error.message : ""
      expect(message).toMatch(new RegExp(`the ${providerId} access token is valid for \\d+ more seconds, but 3600 seconds were requested, and ${reason}\\.`))
      for (const secret of ["short-access", "host-refresh-1", "host-refresh-2", "rotated-access"]) expect(message).not.toContain(secret)
      expect(existsSync(output)).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("a run in an empty account home creates the snapshot's own profile and serves its credentials, and only with a snapshot", async () => {
    const root = mkdtempSync(join(tmpdir(), "flywheel-headless-auth-fresh-home-"))
    const userDataRoot = join(root, "fresh-home", ".flywheel")
    const profiles = (selector: string) => new AuthProfileManager({ userDataRoot, projectRoot: root, env: { FLYWHEEL_AUTH_PROFILE: selector } })
    const { directory, path } = fixture(JSON.stringify({ profile: "benchmark", credentials: { openai_api: { type: "api_key", key: "transferred-key" } } }))
    try {
      await expect(resolveHeadlessAuth(profiles("benchmark"), undefined, PROVIDERS)).rejects.toThrow("auth profile does not exist: benchmark")
      const resolved = await resolveHeadlessAuth(profiles("benchmark"), path, PROVIDERS)
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
      await expect(resolveHeadlessAuth(new AuthProfileManager({ userDataRoot, projectRoot: root, env: { FLYWHEEL_AUTH_PROFILE: "typo" } }), path, PROVIDERS)).rejects.toThrow("The headless auth snapshot is for profile benchmark, but this run selects profile typo. Run with --auth-profile benchmark.")
      expect(existsSync(path)).toBe(false)
      for (const id of ["typo", "benchmark"]) {
        await expect(resolveHeadlessAuth(new AuthProfileManager({ userDataRoot, projectRoot: root, env: { FLYWHEEL_AUTH_PROFILE: id } }), undefined, PROVIDERS)).rejects.toThrow(`auth profile does not exist: ${id}`)
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
      rmSync(directory, { recursive: true, force: true })
    }
  })

  test("rejects a scalar subscription credential during export", async () => {
    const root = mkdtempSync(join(tmpdir(), "flywheel-headless-auth-scalar-"))
    const directories = testDirectories(root)
    const access = await new AuthProfileStore(directories.userDataRoot).create("scalar-work", "Scalar Work")
    access.writeFile("auth.json", JSON.stringify({
      github_copilot: { type: "oauth", access: "oauth", refresh: "refresh", expires: 123 },
    }))
    access.close()
    const stage = privateStage(root)
    const output = join(stage, "auth.json")
    try {
      await expect(writeHeadlessAuthSnapshot({
        userDataRoot: directories.userDataRoot,
        projectRoot: directories.projectRoot,
        selector: "Scalar Work",
        output,
        resolveKey: async () => Redacted.make("unused"),
        providers: PROVIDERS,
      })).rejects.toThrow("export failed")
      expect(existsSync(output)).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test.each([
    ["scalar credential", "strict-scalar", { openai_api: { type: "api_key", key: "key", unexpected: true } }],
    ["subscription instance", "strict-subscription", { github_copilot: [{ id: "account", identity: "account", credential: { type: "oauth", access: "oauth", expires: 123 }, unexpected: true }] }],
  ])("rejects excess properties in a %s during export", async (_name, profileId, auth) => {
    const root = mkdtempSync(join(tmpdir(), "flywheel-headless-auth-excess-"))
    const directories = testDirectories(root)
    const access = await new AuthProfileStore(directories.userDataRoot).create(profileId, "Strict Work")
    access.writeFile("auth.json", JSON.stringify(auth))
    access.close()
    const stage = privateStage(root)
    const output = join(stage, "auth.json")
    try {
      await expect(writeHeadlessAuthSnapshot({
        userDataRoot: directories.userDataRoot,
        projectRoot: directories.projectRoot,
        selector: "Strict Work",
        output,
        resolveKey: async () => Redacted.make("unused"),
        providers: PROVIDERS,
      })).rejects.toThrow("export failed")
      expect(existsSync(output)).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test.each([
    ["legacy scalar", { github_copilot: { type: "api_key", key: "!credential-helper" } }],
    ["collection entry", { github_copilot: [{ id: "account", identity: "account", credential: { type: "api_key", key: "!credential-helper" } }] }],
  ])("rejects an API key in an OAuth-only %s without resolving it", async (_name, auth) => {
    const root = mkdtempSync(join(tmpdir(), "flywheel-headless-auth-kind-"))
    const directories = testDirectories(root)
    const profileId = `kind-${_name.replace(" ", "-")}`
    const access = await new AuthProfileStore(directories.userDataRoot).create(profileId, "Kind Work")
    access.writeFile("auth.json", JSON.stringify(auth))
    access.close()
    const stage = privateStage(root)
    const output = join(stage, "auth.json")
    let resolutions = 0
    try {
      await expect(writeHeadlessAuthSnapshot({
        userDataRoot: directories.userDataRoot,
        projectRoot: directories.projectRoot,
        selector: profileId,
        output,
        resolveKey: async () => {
          resolutions++
          return Redacted.make("must-not-resolve")
        },
        providers: PROVIDERS,
      })).rejects.toThrow("export failed")
      expect(resolutions).toBe(0)
      expect(existsSync(output)).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("rejects OAuth in an API-key provider", async () => {
    const root = mkdtempSync(join(tmpdir(), "flywheel-headless-auth-oauth-kind-"))
    const directories = testDirectories(root)
    const access = await new AuthProfileStore(directories.userDataRoot).create("oauth-kind", "OAuth Kind")
    access.writeFile("auth.json", JSON.stringify({ openai_api: { type: "oauth", access: "oauth", expires: 123 } }))
    access.close()
    const stage = privateStage(root)
    const output = join(stage, "auth.json")
    try {
      await expect(writeHeadlessAuthSnapshot({
        userDataRoot: directories.userDataRoot,
        projectRoot: directories.projectRoot,
        selector: "OAuth Kind",
        output,
        resolveKey: async () => Redacted.make("unused"),
        providers: PROVIDERS,
      })).rejects.toThrow("export failed")
      expect(existsSync(output)).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("rejects a scalar credential for an API-key subscription provider", async () => {
    const root = mkdtempSync(join(tmpdir(), "flywheel-headless-auth-api-subscription-"))
    const directories = testDirectories(root)
    const access = await new AuthProfileStore(directories.userDataRoot).create("api-subscription", "API Subscription")
    access.writeFile("auth.json", JSON.stringify({ opencode_go: { type: "api_key", key: "!credential-helper" } }))
    access.close()
    const stage = privateStage(root)
    const output = join(stage, "auth.json")
    let resolutions = 0
    try {
      await expect(writeHeadlessAuthSnapshot({
        userDataRoot: directories.userDataRoot,
        projectRoot: directories.projectRoot,
        selector: "API Subscription",
        output,
        resolveKey: async () => {
          resolutions++
          return Redacted.make("must-not-resolve")
        },
        providers: PROVIDERS,
      })).rejects.toThrow("export failed")
      expect(resolutions).toBe(0)
      expect(existsSync(output)).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("rejects a missing selected profile without writing a snapshot", async () => {
    const root = mkdtempSync(join(tmpdir(), "flywheel-headless-auth-missing-"))
    const directories = testDirectories(root)
    const stage = privateStage(root)
    const output = join(stage, "auth.json")
    try {
      await expect(writeHeadlessAuthSnapshot({
        userDataRoot: directories.userDataRoot,
        projectRoot: directories.projectRoot,
        selector: "missing",
        output,
        resolveKey: async () => Redacted.make("unused"),
        providers: PROVIDERS,
      })).rejects.toThrow("export failed")
      expect(existsSync(output)).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("carries no Claude login, and the run serves only the Claude login of its own profile, never another profile's or the account home's", async () => {
    const root = mkdtempSync(join(tmpdir(), "flywheel-headless-auth-external-"))
    const directories = testDirectories(root)
    const home = join(root, "os-home")
    mkdirSync(home)
    const writeLogin = (configDir: string, accountUuid: string) => {
      mkdirSync(configDir, { recursive: true })
      writeFileSync(join(configDir, ".claude.json"), JSON.stringify({ oauthAccount: { accountUuid, emailAddress: `${accountUuid}@example.com` } }))
    }
    // The account home has its own Claude login, and so does another profile.
    writeFileSync(join(home, ".claude.json"), JSON.stringify({ oauthAccount: { accountUuid: "uuid-account-home", emailAddress: "uuid-account-home@example.com" } }))
    const sdk = createClaudeAgentSdkModule({ account: () => ({ home, user: "tester" }), enginePath: "/scratch/bin/claude" }).contributions[0].value.definition
    const providers = [...PROVIDERS.filter(({ id }) => id !== sdk.id), sdk]
    const store = new AuthProfileStore(directories.userDataRoot)
    const access = await store.create("claude-only")
    const authDirectory = access.authDirectory
    access.close()
    const other = await store.create("other")
    writeLogin(join(other.authDirectory, LOGIN_ACCOUNTS_DIRECTORY, "a"), "uuid-other")
    other.close()
    const configDir = join(authDirectory, LOGIN_ACCOUNTS_DIRECTORY, "a")
    writeLogin(configDir, "uuid-claude")
    const output = join(privateStage(root), "auth.json")
    try {
      await writeHeadlessAuthSnapshot({ userDataRoot: directories.userDataRoot, projectRoot: directories.projectRoot, selector: "claude-only", output, resolveKey: async () => Redacted.make("unused"), providers })
      // The CLI keeps the token, so no snapshot can carry it, not even the account's name.
      expect(JSON.parse(readFileSync(output, "utf8")).credentials).toEqual({})
      expect(readFileSync(output, "utf8")).not.toContain("uuid-claude")

      const snapshot = await captureHeadlessSnapshotConnection(readHeadlessAuthSnapshot(output, providers), authDirectory, providers)
      expect(snapshot?.connection.subscriptionCredentials.get(credentialIdOf(sdk))?.map(({ instanceId, identity, credential }) => ({ instanceId, identity, credential }))).toEqual([
        { instanceId: "uuid-claude", identity: "uuid-claude@example.com", credential: { type: "external", configDir } },
      ])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("rejects output outside a dedicated private stage", async () => {
    const root = mkdtempSync(join(tmpdir(), "flywheel-headless-auth-path-"))
    const directories = testDirectories(root)
    const output = join(root, "snapshot.json")
    try {
      await expect(writeHeadlessAuthSnapshot({
        userDataRoot: directories.userDataRoot,
        projectRoot: directories.projectRoot,
        selector: "missing",
        output,
        resolveKey: async () => Redacted.make("unused"),
        providers: PROVIDERS,
      })).rejects.toThrow("dedicated stage")
      expect(existsSync(output)).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
