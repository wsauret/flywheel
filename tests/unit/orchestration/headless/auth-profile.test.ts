import { describe, expect, spyOn, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises"
import { applyWindowsPrivateDirectoryAcl } from "../../../../src/infra/windows-private-directory-acl.js"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { Redacted } from "effect"
import { runHeadlessTask } from "../../../../src/orchestration/headless/run-headless-task.js"
import { readHeadlessAuthSnapshot } from "../../../../src/orchestration/headless/benchmark-auth-file.js"
import { AuthProfileStore } from "../../../../src/infra/auth/auth-profile-store.js"
import { AuthProfileManager } from "../../../../src/orchestration/auth/auth-profile-manager.js"
import { authDir } from "../../../../src/infra/paths.js"
import { prepareWorkflowDeps as prepareDeps } from "../../../../src/orchestration/workflow-host/deps.js"
import { testDirectories } from "../../../helpers/directories.js"
import { composeFirstPartyModules } from "../../../../src/orchestration/modules.js"
import { testProviderEligibility } from "../../../helpers/provider-authority.js"
import { fakeModelsClient } from "../../../helpers/model-tier-fixtures.js"
import type { AccessProviderCandidate } from "../../../../src/infra/llm/access-provider.js"

import { accessProviderRegistry } from "../../../../src/orchestration/agent-runtime/llm/access-provider-registry.js"
const PROVIDERS = accessProviderRegistry(composeFirstPartyModules()).selection.definitions
/** A stage the snapshot reader admits: private to this account. POSIX states
 *  that with the directory mode; Windows keeps no mode bits, so the owner-only
 *  ACL is what an operator applies and what the reader verifies there. */
async function privateStage(parent: string): Promise<string> {
  const stage = await mkdtemp(join(parent, "flywheel-auth-bundle-"))
  if (process.platform === "win32") applyWindowsPrivateDirectoryAcl(stage)
  else await chmod(stage, 0o700)
  return stage
}

describe("headless auth profile", () => {
  test("resolves the environment-selected profile once before preparing authentication", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "flywheel-headless-auth-profile-"))
    const directories = testDirectories(projectRoot)
    const previous = process.env.FLYWHEEL_AUTH_PROFILE
    const manager = new AuthProfileManager({ ...directories, env: {} })
    await manager.create("automation")
    process.env.FLYWHEEL_AUTH_PROFILE = "automation"
    let authDirectory: (() => string) | undefined

    try {
      const result = await runHeadlessTask("test", {
        modelsClient: fakeModelsClient,
        directories,
        launcher: { spawnOwned: async () => { throw new Error("unused") }, adoptOwned: async () => { throw new Error("unused") }, open() { return this }, close: async () => ({ settled: true as const }) },
        printErrorsToStderr: false,
        prepareWorkflowDeps: async (input) => {
          authDirectory = input.authDirectory
          process.env.FLYWHEEL_AUTH_PROFILE = "changed-after-resolution"
          throw new Error("stop after auth resolution")
        },
      })

      expect(result.error).toBe("stop after auth resolution")
      expect(authDirectory?.()).toBe(authDir(directories.userDataRoot, "automation"))
    } finally {
      if (previous === undefined) Reflect.deleteProperty(process.env, "FLYWHEEL_AUTH_PROFILE")
      else process.env.FLYWHEEL_AUTH_PROFILE = previous
      await rm(projectRoot, { recursive: true, force: true })
    }
  })

  test("uses the selected profile snapshot and scrubs its transport path", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "flywheel-headless-profile-snapshot-"))
    const directories = testDirectories(projectRoot)
    const authFile = join(await privateStage(projectRoot), "auth.json")
    const access = await new AuthProfileStore(directories.userDataRoot).create("Work")
    // The profile's own directory: a case-sensitive file system, as on Linux,
    // holds it under the exact case of the profile id.
    const profileDirectory = access.authDirectory
    access.close()
    const lineageId = "00000000-0000-4000-8000-000000000001"
    await writeFile(authFile, JSON.stringify({ profile: "Work", credentials: { github_copilot: [{ id: "copilot-work", identity: "work@example.com", lineageId, credential: { type: "oauth", access: "copilot-secret", refresh: "github-secret", expires: 1 } }] } }), { mode: 0o600 })
    const preferencePath = join(profileDirectory, "model-preferences.json")
    const preferenceBytes = '{"version":1,"providers":{"github_copilot":{"disabled":["gpt-5"]}}}'
    await writeFile(preferencePath, preferenceBytes)
    const previous = { profile: process.env.FLYWHEEL_AUTH_PROFILE, file: process.env.FLYWHEEL_BENCHMARK_AUTH_FILE }
    process.env.FLYWHEEL_AUTH_PROFILE = "Work"
    let copilotInstanceId: string | undefined
    try {
      const result = await runHeadlessTask("test", {
        modelsClient: fakeModelsClient,
        directories,
        authProfile: "Work",
        authSnapshot: authFile,
        launcher: { spawnOwned: async () => { throw new Error("unused") }, adoptOwned: async () => { throw new Error("unused") }, open() { return this }, close: async () => ({ settled: true as const }) },
        printErrorsToStderr: false,
        prepareWorkflowDeps: async (input) => {
          copilotInstanceId = input.overrides?.connection?.subscriptionCredentials.get("github_copilot")?.[0]?.instanceId
          throw new Error("stop after auth capture")
        },
      })
      expect(result.error).toBe("stop after auth capture")
      expect(copilotInstanceId).toBe("copilot-work")
      expect(existsSync(authFile)).toBe(false)
      expect(readFileSync(preferencePath, "utf8")).toBe(preferenceBytes)
    } finally {
      for (const [name, value] of [["FLYWHEEL_AUTH_PROFILE", previous.profile], ["FLYWHEEL_BENCHMARK_AUTH_FILE", previous.file]] as const) {
        if (value === undefined) Reflect.deleteProperty(process.env, name)
        else process.env[name] = value
      }
      await rm(projectRoot, { recursive: true, force: true })
    }
  })

  test("keeps every eligible profile provider in benchmark auto-routing order", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "flywheel-headless-provider-route-"))
    const directories = testDirectories(projectRoot)
    const authFile = join(await privateStage(projectRoot), "auth.json")
    const access = await new AuthProfileStore(directories.userDataRoot).create("RouteWork")
    access.close()
    await writeFile(authFile, JSON.stringify({
      profile: "RouteWork",
      credentials: {
        chatgpt: [{ id: "chatgpt-primary", identity: "chatgpt@example.com", lineageId: "00000000-0000-4000-8000-000000000002", credential: { type: "oauth", access: "chatgpt-secret", expires: Date.now() + 60_000 } }],
        github_copilot: [{ id: "copilot-primary", identity: "copilot@example.com", lineageId: "00000000-0000-4000-8000-000000000003", credential: { type: "oauth", access: "copilot-secret", refresh: "github-secret", expires: Date.now() + 60_000 } }],
        openai_api: { type: "api_key", key: "openai-secret" },
      },
    }), { mode: 0o600 })
    const previous = { profile: process.env.FLYWHEEL_AUTH_PROFILE, file: process.env.FLYWHEEL_BENCHMARK_AUTH_FILE }
    process.env.FLYWHEEL_AUTH_PROFILE = "RouteWork"
    // The transferred OpenAI key makes access-only preparation list that
    // provider's models live. The provider API is unavailable to this test.
    const originalFetch = globalThis.fetch
    globalThis.fetch = Object.assign(async () => new Response("unavailable", { status: 503 }), { preconnect: originalFetch.preconnect })
    let candidates: readonly AccessProviderCandidate[] | undefined
    try {
      const result = await runHeadlessTask("test", {
        modelsClient: fakeModelsClient,
        directories,
        authProfile: "RouteWork",
        authSnapshot: authFile,
        launcher: { spawnOwned: async () => { throw new Error("unused") }, adoptOwned: async () => { throw new Error("unused") }, open() { return this }, close: async () => ({ settled: true as const }) },
        printErrorsToStderr: false,
        prepareWorkflowDeps: async (input) => {
          const deps = await prepareDeps(input)
          const capture = await deps.captureProviderConnection()
          const plan = capture.providers.selection.plan("gpt-6-luna", capture.connection, testProviderEligibility())
          candidates = plan.kind === "admitted" ? plan.candidates : []
          throw new Error("captured provider route")
        },
      })
      expect(result.error).toBe("captured provider route")
      expect(candidates).toEqual([
        { kind: "subscription", providerId: "chatgpt", instanceId: "chatgpt-primary", spendMode: "included" },
        { kind: "subscription", providerId: "github_copilot", instanceId: "copilot-primary", spendMode: "included" },
        { kind: "subscription", providerId: "chatgpt", instanceId: "chatgpt-primary", spendMode: "prepaid" },
        { kind: "subscription", providerId: "chatgpt", instanceId: "chatgpt-primary", spendMode: "automatic" },
        { kind: "subscription", providerId: "github_copilot", instanceId: "copilot-primary", spendMode: "automatic" },
        { kind: "singleton", providerId: "openai_api", spendMode: "direct_api" },
      ])
    } finally {
      globalThis.fetch = originalFetch
      for (const [name, value] of [["FLYWHEEL_AUTH_PROFILE", previous.profile], ["FLYWHEEL_BENCHMARK_AUTH_FILE", previous.file]] as const) {
        if (value === undefined) Reflect.deleteProperty(process.env, name)
        else process.env[name] = value
      }
      await rm(projectRoot, { recursive: true, force: true })
    }
  })

  test("carries Copilot OAuth only in the benchmark snapshot", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "flywheel-headless-copilot-snapshot-"))
    const directories = testDirectories(projectRoot)
    const authFile = join(await privateStage(projectRoot), "auth.json")
    const access = await new AuthProfileStore(directories.userDataRoot).create("CopilotWork")
    access.close()
    await writeFile(authFile, JSON.stringify({ profile: "CopilotWork", credentials: { github_copilot: [{ id: "copilot-primary", identity: "copilot@example.com", lineageId: "00000000-0000-4000-8000-000000000004", credential: { type: "oauth", access: "copilot-secret", refresh: "github-secret", expires: 1 } }] } }), { mode: 0o600 })
    const previous = { profile: process.env.FLYWHEEL_AUTH_PROFILE, file: process.env.FLYWHEEL_BENCHMARK_AUTH_FILE }
    process.env.FLYWHEEL_AUTH_PROFILE = "CopilotWork"
    try {
      const result = await runHeadlessTask("test", {
        modelsClient: fakeModelsClient,
        directories,
        authProfile: "CopilotWork",
        authSnapshot: authFile,
        launcher: { spawnOwned: async () => { throw new Error("unused") }, adoptOwned: async () => { throw new Error("unused") }, open() { return this }, close: async () => ({ settled: true as const }) },
        printErrorsToStderr: false,
        prepareWorkflowDeps: async (input) => {
          const credentials = input.overrides?.connection?.subscriptionCredentials.get("github_copilot")
          expect(credentials?.map(({ instanceId, credential }) => ({ instanceId, type: credential.type, expires: credential.type === "oauth" ? credential.expires : undefined }))).toEqual([
            { instanceId: "copilot-primary", type: "oauth", expires: 1 },
          ])
          const credential = credentials?.[0]?.credential
          expect(credential?.type === "oauth" ? Redacted.value(credential.access) : undefined).toBe("copilot-secret")
          expect(credential?.type === "oauth" && credential.refresh !== undefined ? Redacted.value(credential.refresh) : undefined).toBe("github-secret")
          expect(input.overrides?.connection?.oauthPersistence).toBe("access-only")
          expect(existsSync(join(input.authDirectory?.() ?? "", "auth.json"))).toBe(false)
          expect(process.env.github_copilot).toBeUndefined()
          throw new Error("captured Copilot connection")
        },
      })
      expect(result.error).toBe("captured Copilot connection")
      expect(existsSync(authFile)).toBe(false)
    } finally {
      for (const [name, value] of [["FLYWHEEL_AUTH_PROFILE", previous.profile], ["FLYWHEEL_BENCHMARK_AUTH_FILE", previous.file]] as const) {
        if (value === undefined) Reflect.deleteProperty(process.env, name)
        else process.env[name] = value
      }
      await rm(projectRoot, { recursive: true, force: true })
    }
  })

  test("a profile with no model provider ends the task with the same /auth remedy the transcript records", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "flywheel-headless-no-provider-"))
    let stderr = ""
    const write = spyOn(process.stderr, "write").mockImplementation((chunk) => { stderr += chunk.toString(); return true })
    try {
      const result = await runHeadlessTask("hello", {
        modelsClient: fakeModelsClient,
        directories: testDirectories(projectRoot),
        launcher: { spawnOwned: async () => { throw new Error("unused") }, adoptOwned: async () => { throw new Error("unused") }, open() { return this }, close: async () => ({ settled: true as const }) },
      })
      expect(result.termination.terminal).toMatchObject({ kind: "model_unavailable", missing: "provider" })
      expect(stderr).toContain("Headless task did not complete: No model provider. No model provider is set up, so no model can answer. Set one up with /auth, then send the message again.")
    } finally {
      write.mockRestore()
      await rm(projectRoot, { recursive: true, force: true })
    }
  })

  test("rejects excess snapshot fields without exposing their values", async () => {
    const root = await mkdtemp(join(tmpdir(), "flywheel-headless-auth-sentinel-"))
    const authFile = join(await privateStage(root), "auth.json")
    const sentinel = "sentinel-secret-value"
    await writeFile(authFile, JSON.stringify({ profile: "Work", credentials: {}, excess: sentinel }), { mode: 0o600 })
    try {
      let message = ""
      try {
        readHeadlessAuthSnapshot(authFile, PROVIDERS)
      } catch (error) {
        message = String(error)
      }
      expect(message).toContain("Headless auth snapshot content is invalid")
      expect(message).not.toContain(sentinel)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
