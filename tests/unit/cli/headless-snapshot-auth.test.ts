import { afterEach, describe, expect, spyOn, test } from "bun:test"
import { Redacted } from "effect"
import { chmodSync, existsSync, mkdtempSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { runHeadlessSnapshotAuth } from "../../../src/cli/headless-snapshot-auth.js"
import { AuthProfileStore } from "../../../src/infra/auth/auth-profile-store.js"
import { accessProviderRegistry } from "../../../src/orchestration/agent-runtime/llm/access-provider-registry.js"
import { composeFirstPartyModules } from "../../../src/orchestration/modules.js"
import { applyWindowsPrivateDirectoryAcl } from "../../../src/infra/windows-private-directory-acl.js"
import { temporaryDirectories, testDirectories } from "../../helpers/directories.js"

const PROVIDERS = accessProviderRegistry(composeFirstPartyModules()).selection.definitions
const temporary = temporaryDirectories()

function privateOutput(root: string): string {
  const stage = mkdtempSync(join(root, "flywheel-auth-bundle-"))
  if (process.platform === "win32") applyWindowsPrivateDirectoryAcl(stage)
  else chmodSync(stage, 0o700)
  return join(stage, "auth.json")
}

afterEach(() => {
  process.exitCode = 0
})

describe("flywheel headless snapshot-auth", () => {
  test.each([
    ["no output", (_output: string) => ["--auth-profile", "work"]],
    ["an unknown flag", (output: string) => ["--auth-profile", "work", "--output", output, "--ttl", "60"]],
    ["a repeated flag", (output: string) => ["--auth-profile", "work", "--output", output, "--auth-profile", "other"]],
    ["a zero lifetime", (output: string) => ["--auth-profile", "work", "--output", output, "--min-valid-seconds", "0"]],
    ["a fractional lifetime", (output: string) => ["--auth-profile", "work", "--output", output, "--min-valid-seconds", "1.5"]],
    ["a lifetime that is not a number", (output: string) => ["--auth-profile", "work", "--output", output, "--min-valid-seconds", "soon"]],
    ["a profile name that is not a profile id", (output: string) => ["--auth-profile", "work", "--output", output, "--as-profile", "a/b"]],
  ])("prints the usage and exits 2 for %s", async (_name, args) => {
    const root = temporary("flywheel-snapshot-cli-usage-")
    const output = privateOutput(root)
    const errors = spyOn(console, "error").mockImplementation(() => {})
    try {
      await runHeadlessSnapshotAuth(args(output), testDirectories(root), async () => Redacted.make("unused"), PROVIDERS)
      expect(process.exitCode).toBe(2)
      expect(String(errors.mock.calls[0]?.[0])).toContain("--min-valid-seconds")
      expect(existsSync(output)).toBe(false)
    } finally {
      errors.mockRestore()
    }
  })

  test("writes the snapshot under the profile id that --as-profile names and prints that id", async () => {
    const root = temporary("flywheel-snapshot-cli-as-profile-")
    // A user data root of its own: the account home of the test process is shared with other files, which count its profiles.
    const directories = { ...testDirectories(root), userDataRoot: join(root, "user-data") }
    const access = await new AuthProfileStore(directories.userDataRoot).create("cli-real-profile", "CLI Real Profile")
    access.writeFile("auth.json", JSON.stringify({ openai_api: { type: "api_key", key: "host-key", lineageId: crypto.randomUUID() } }))
    access.close()
    const output = privateOutput(root)
    const printed = spyOn(process.stdout, "write").mockImplementation(() => true)
    try {
      await runHeadlessSnapshotAuth(["--auth-profile", "CLI Real Profile", "--output", output, "--as-profile", "benchmark", "--min-valid-seconds", "3600"], directories, async () => Redacted.make("resolved-key"), PROVIDERS)
      expect(printed.mock.calls.map(([text]) => String(text))).toEqual(["benchmark\n"])
    } finally {
      printed.mockRestore()
    }
    expect(process.exitCode).not.toBe(2)
    expect(JSON.parse(readFileSync(output, "utf8")).profile).toBe("benchmark")
  })

  test("keeps only the providers that repeated --provider flags name", async () => {
    const root = temporary("flywheel-snapshot-cli-provider-")
    const directories = { ...testDirectories(root), userDataRoot: join(root, "user-data") }
    const access = await new AuthProfileStore(directories.userDataRoot).create("cli-filter-profile", "CLI Filter Profile")
    const lineages = { openai_api: crypto.randomUUID(), anthropic_api: crypto.randomUUID(), deepseek: crypto.randomUUID() }
    access.writeFile("auth.json", JSON.stringify(Object.fromEntries(Object.entries(lineages).map(([providerId, lineageId]) => [providerId, { type: "api_key", key: `${providerId}-key`, lineageId }]))))
    access.close()
    const output = privateOutput(root)
    const printed = spyOn(process.stdout, "write").mockImplementation(() => true)
    try {
      await runHeadlessSnapshotAuth(["--auth-profile", "cli-filter-profile", "--provider", "openai_api", "--output", output, "--provider", "deepseek"], directories, async (key) => Redacted.make(`resolved-${key}`), PROVIDERS)
    } finally {
      printed.mockRestore()
    }
    expect(process.exitCode).not.toBe(2)
    expect(JSON.parse(readFileSync(output, "utf8")).credentials).toEqual({
      openai_api: { type: "api_key", key: "resolved-openai_api-key", lineageId: lineages.openai_api },
      deepseek: { type: "api_key", key: "resolved-deepseek-key", lineageId: lineages.deepseek },
    })
  })
})
