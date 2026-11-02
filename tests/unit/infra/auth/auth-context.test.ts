import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Redacted } from "effect";
import * as fs from "node:fs";
import { apiKey, resolveAuthContext as resolveAuthContextWithSlots } from "../../../../src/infra/auth/auth-context.js";
import { plainApiKey } from "../../../helpers/auth-context.js";
import { createKeyResolver, type CredentialCommandRunner } from "../../../../src/infra/auth/resolve-key.js";
import { setCredential } from "../../../../src/infra/auth/auth-store-mutations.js";
import { fileTemporaryDirectory } from "../../../helpers/directories.js";

/** The account layout the auth store is written for: an account home holding a
 *  data directory, and `auth` inside it. The store walks those components without
 *  following a link, so a fixture that hands it a bare directory whose parent is
 *  a symlink (`/tmp` on darwin) is refused, as it should be. */
const ACCOUNT_HOME = fileTemporaryDirectory("flywheel-test-auth-context-");
const TEST_DIR = `${ACCOUNT_HOME}/.flywheel/auth`;

function resolveAuthContext(options: Omit<Parameters<typeof resolveAuthContextWithSlots>[0], "credentialSlotClassifier">) {
  return resolveAuthContextWithSlots({ ...options, credentialSlotClassifier: () => "metered" });
}

function ensureCleanDir(dir: string): void {
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true });
  fs.mkdirSync(dir, { recursive: true });
}

describe("resolveAuthContext", () => {
  beforeEach(() => {
    ensureCleanDir(ACCOUNT_HOME);
    fs.mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    if (fs.existsSync(ACCOUNT_HOME)) fs.rmSync(ACCOUNT_HOME, { recursive: true });
  });

  /** Resolution holds no launch capability of its own, so every snapshot is
   *  read with an injected resolver. This one answers one helper and refuses
   *  every other, which is also how a test proves nothing else was run. */
  function keyResolver(answers: { [key: string]: string } = {}) {
    const commands: string[] = [];
    const run: CredentialCommandRunner = (command) => {
      commands.push(command);
      const value = answers[command];
      return Promise.resolve(value === undefined
        ? { tag: "failed", failure: { exitCode: 1, timedOut: false } }
        : { tag: "captured", value: Redacted.make(value) });
    };
    return { resolveKey: createKeyResolver(run), commands };
  }

  it("ignores environment API keys entirely; the profile store is the only source", async () => {
    const saved: { [name: string]: string | undefined } = {};
    const names = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "OPENROUTER_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY", "EXA_API_KEY"];
    for (const name of names) { saved[name] = process.env[name]; process.env[name] = "env-key-must-not-leak"; }
    try {
      const auth = await resolveAuthContext({ authDir: TEST_DIR, resolveKey: keyResolver().resolveKey });
      expect(apiKey(auth, "anthropic_api")).toBeUndefined();
      expect(apiKey(auth, "openai_api")).toBeUndefined();
      expect(apiKey(auth, "openrouter")).toBeUndefined();
      expect(apiKey(auth, "google_api")).toBeUndefined();
      expect(apiKey(auth, "exa")).toBeUndefined();
    } finally {
      for (const name of names) {
        if (saved[name] === undefined) Reflect.deleteProperty(process.env, name);
        else process.env[name] = saved[name];
      }
    }
  });

  it("picks up API key from the unified store", async () => {
    await setCredential("anthropic_api", { type: "api_key", key: "stored-key" }, TEST_DIR);
    const auth = await resolveAuthContext({ authDir: TEST_DIR, resolveKey: keyResolver().resolveKey });
    expect(plainApiKey(auth, "anthropic_api")).toBe("stored-key");
  });

  it("carries the persisted opaque lineage without deriving it from the secret", async () => {
    await setCredential("anthropic_api", { type: "api_key", key: "stored-key" }, TEST_DIR);
    const first = await resolveAuthContext({ authDir: TEST_DIR, resolveKey: keyResolver().resolveKey });
    const second = await resolveAuthContext({ authDir: TEST_DIR, resolveKey: keyResolver().resolveKey });

    expect(first.credentialLineages.anthropic_api).toMatch(/^[0-9a-f-]{36}$/);
    expect(second.credentialLineages.anthropic_api).toBe(first.credentialLineages.anthropic_api);
    expect(first.credentialLineages.anthropic_api).not.toContain("stored-key");
  });

  it("resolves a !command API key from the store through the injected resolver", async () => {
    await setCredential("openai_api", { type: "api_key", key: "!print-my-key" }, TEST_DIR);
    const resolver = keyResolver({ "print-my-key": "test-key-from-cmd" });
    const auth = await resolveAuthContext({ authDir: TEST_DIR, resolveKey: resolver.resolveKey });
    expect(plainApiKey(auth, "openai_api")).toBe("test-key-from-cmd");
    expect(resolver.commands).toEqual(["print-my-key"]);
  });

  it("detects chatgpt configured from oauth credential in store", async () => {
    await setCredential("chatgpt", {
      type: "oauth",
      access: "access-token",
      refresh: "refresh-token",
      expires: Date.now() + 3_600_000,
    }, TEST_DIR);
    const auth = await resolveAuthContext({ authDir: TEST_DIR, resolveKey: keyResolver().resolveKey });
    expect((auth.providers.get("chatgpt")?.kind === "oauth")).toBe(true);
  });

  it("ignores an uninstalled provider and resolves a healthy installed credential", async () => {
    await setCredential("removed_provider", { type: "api_key", key: "stale-key" }, TEST_DIR);
    await setCredential("anthropic_api", { type: "api_key", key: "healthy-key" }, TEST_DIR);
    const auth = await resolveAuthContext({
      authDir: TEST_DIR,
      resolveKey: keyResolver().resolveKey,
      credentialProviderIds: ["anthropic_api"],
    });
    expect(plainApiKey(auth, "anthropic_api")).toBe("healthy-key");
    expect(auth.conditions).toBeUndefined();
  });

  it("carries provider-scoped malformed evidence without credential values", async () => {
    fs.writeFileSync(`${TEST_DIR}/auth.json`, JSON.stringify({
      anthropic_api: { type: "api_key" },
      openai_api: { lineageId: crypto.randomUUID(), credential: { type: "api_key", key: "healthy-key" } },
    }));
    const auth = await resolveAuthContext({
      authDir: TEST_DIR,
      resolveKey: keyResolver().resolveKey,
      credentialProviderIds: ["anthropic_api", "openai_api"],
    });
    expect(auth.conditions).toEqual([{
      kind: "malformed",
      scope: "provider",
      providerId: "anthropic_api",
      authDirectory: TEST_DIR,
      revision: expect.stringMatching(/^[a-f0-9]{64}$/),
    }]);
    expect(JSON.stringify(auth.conditions)).not.toContain("healthy-key");
  });

  it("rejects a credential collection in a metered provider slot", async () => {
    fs.writeFileSync(`${TEST_DIR}/auth.json`, JSON.stringify({
      anthropic_api: [{
        id: crypto.randomUUID(),
        identity: "edited account",
        lineageId: crypto.randomUUID(),
        credential: { type: "oauth", access: "edited-token", expires: Date.now() + 3_600_000 },
      }],
    }));

    const auth = await resolveAuthContext({
      authDir: TEST_DIR,
      resolveKey: keyResolver().resolveKey,
      credentialProviderIds: ["anthropic_api"],
    });

    expect(auth.providers.has("anthropic_api")).toBe(false);
    expect(auth.droppedCredentials).toEqual(["anthropic_api"]);
  });

  it("calling resolveAuthContext() again after setCredential() returns updated snapshot", async () => {
    const before = await resolveAuthContext({ authDir: TEST_DIR, resolveKey: keyResolver().resolveKey });
    expect(apiKey(before, "anthropic_api")).toBeUndefined();

    await setCredential("anthropic_api", { type: "api_key", key: "new-key" }, TEST_DIR);
    const after = await resolveAuthContext({ authDir: TEST_DIR, resolveKey: keyResolver().resolveKey });
    expect(plainApiKey(after, "anthropic_api")).toBe("new-key");
  });



});
