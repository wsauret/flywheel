import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { POSIX_FILE_MODES } from "../../../helpers/posix-modes.js";
import { Redacted } from "effect";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileTemporaryDirectory } from "../../../helpers/directories.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TEST_DIR = fileTemporaryDirectory("flywheel-test-auth-");

function createTestJwt(payload: { [key: string]: unknown }): string {
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = Buffer.from("fake-signature").toString("base64url");
  return `${header}.${body}.${signature}`;
}

function ensureCleanDir(dir: string): void {
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true });
  fs.mkdirSync(dir, { recursive: true });
}

// ---------------------------------------------------------------------------
// Account ID extraction (exercises JWT parsing indirectly)
// ---------------------------------------------------------------------------

describe("extractAccountId", () => {
  let extractAccountId: typeof import("../../../../src/infra/auth/openai-jwt.js").extractAccountId;

  beforeEach(async () => {
    const mod = await import("../../../../src/infra/auth/openai-jwt.js");
    extractAccountId = mod.extractAccountId;
  });

  /** A token response as the token endpoint returns it, with `idToken` as its ID token when given. */
  const tokens = (idToken?: string): Parameters<typeof extractAccountId>[0] => ({
    access_token: "access", expires_in: 3600, token_type: "Bearer", ...(idToken === undefined ? {} : { id_token: idToken }),
  });

  it("extracts from nested auth claim", () => {
    const idToken = createTestJwt({
      "https://api.openai.com/auth": { chatgpt_account_id: "acct-nested" },
    });
    const result = extractAccountId(tokens(idToken));
    expect(result).toBe("acct-nested");
  });

  it("extracts from organizations fallback", () => {
    const idToken = createTestJwt({
      "https://api.openai.com/auth": {
        organizations: [{ id: "org-fallback" }],
      },
    });
    const result = extractAccountId(tokens(idToken));
    expect(result).toBe("org-fallback");
  });

  it("prefers root claim over nested claim", () => {
    const idToken = createTestJwt({
      chatgpt_account_id: "acct-root",
      "https://api.openai.com/auth": { chatgpt_account_id: "acct-nested" },
    });
    const result = extractAccountId(tokens(idToken));
    expect(result).toBe("acct-root");
  });

  it("returns undefined when no id_token is present", () => {
    const result = extractAccountId(tokens());
    expect(result).toBeUndefined();
  });

  it("rejects a misshapen claim instead of leaking a non-string id", () => {
    // The Schema decode (not a bare `as` cast) now rejects a non-string
    // organization id, so the malformed value never reaches the caller.
    const idToken = createTestJwt({
      "https://api.openai.com/auth": { organizations: [{ id: 123 }] },
    });
    const result = extractAccountId(tokens(idToken));
    expect(result).toBeUndefined();
  });

  it("tolerates a corrupt payload as absent, never throwing", () => {
    // decodeUnknownOption returns None for an undecodable payload, so a malformed
    // token degrades to "no accountId" (the optional-billing-identity contract)
    // rather than throwing. This pins the tolerance in the type, not a catch.
    const idToken = `${Buffer.from("{}").toString("base64url")}.not-valid-json.${Buffer.from("sig").toString("base64url")}`;
    const result = extractAccountId(tokens(idToken));
    expect(result).toBeUndefined();
  });
});

describe("extractDisplayIdentity", () => {
  it("prefers email and falls back to account id from OpenAI-compatible claims", async () => {
    const { extractDisplayIdentityFromJwt } = await import("../../../../src/infra/auth/openai-jwt.js");
    expect(extractDisplayIdentityFromJwt(createTestJwt({ email: "person@example.com", chatgpt_account_id: "acct-1" }))).toBe("person@example.com");
    expect(extractDisplayIdentityFromJwt(createTestJwt({ chatgpt_account_id: "acct-1" }))).toBe("acct-1");
  });
});

// ---------------------------------------------------------------------------
// PKCE
// ---------------------------------------------------------------------------

describe("PKCE", () => {
  let generatePKCE: typeof import("../../../../src/infra/auth/openai-pkce.js").generatePKCE;
  let generateState: typeof import("../../../../src/infra/auth/openai-pkce.js").generateState;

  beforeEach(async () => {
    const mod = await import("../../../../src/infra/auth/openai-pkce.js");
    generatePKCE = mod.generatePKCE;
    generateState = mod.generateState;
  });

  it("verifier has length 43", async () => {
    const { verifier } = await generatePKCE();
    expect(verifier.length).toBe(43);
  });

  it("challenge is valid base64url (no +, /, or =)", async () => {
    const { challenge } = await generatePKCE();
    expect(challenge).not.toMatch(/[+/=]/);
    expect(challenge.length).toBeGreaterThan(0);
  });

  it("different calls yield different verifier/challenge pairs", async () => {
    const a = await generatePKCE();
    const b = await generatePKCE();
    expect(a.verifier).not.toBe(b.verifier);
    expect(a.challenge).not.toBe(b.challenge);
  });

  it("generateState returns different values on each call", () => {
    const a = generateState();
    const b = generateState();
    expect(a).not.toBe(b);
  });
});

// ---------------------------------------------------------------------------
// Types — StoredTokens credential DTO round-trip
// ---------------------------------------------------------------------------

describe("StoredTokens credential conversion", () => {
  let types: typeof import("../../../../src/infra/auth/openai-auth-types.js");

  beforeEach(async () => {
    types = await import("../../../../src/infra/auth/openai-auth-types.js");
  });

  it("wraps tokens on read and round-trips through the plain credential DTO", () => {
    const cred = { type: "oauth", access: "access-abc", refresh: "refresh-def", expires: 123456, accountId: "acct-123" } as const;
    const tokens = types.credentialToStoredTokens(cred);
    expect(Redacted.value(tokens.accessToken)).toBe("access-abc");
    expect(tokens.refreshToken && Redacted.value(tokens.refreshToken)).toBe("refresh-def");
    expect(tokens.expiresAtMs).toBe(123456);
    expect(tokens.accountId).toBe("acct-123");
    expect(types.storedTokensToCredential(tokens)).toEqual(cred);
  });

  it("represents a missing refresh token as absent, never an empty string", () => {
    const tokens = types.credentialToStoredTokens({ type: "oauth", access: "access-abc", expires: 1 });
    expect(tokens.refreshToken).toBeUndefined();
    const cred = types.storedTokensToCredential(tokens);
    expect("refresh" in cred).toBe(false);
  });

  it("does not leak token values through string conversion", () => {
    const tokens = types.credentialToStoredTokens({ type: "oauth", access: "access-abc", refresh: "refresh-def", expires: 1 });
    expect(String(tokens.accessToken)).not.toContain("access-abc");
    expect(JSON.stringify(tokens)).not.toContain("refresh-def");
  });
});

// ---------------------------------------------------------------------------
// writeFileAtomic — mode parameter
// ---------------------------------------------------------------------------

describe("writeFileAtomic — mode option", () => {
  let writeFileAtomic: typeof import("../../../../src/infra/atomic-write.js").writeFileAtomic;

  beforeEach(async () => {
    ensureCleanDir(TEST_DIR);
    const mod = await import("../../../../src/infra/atomic-write.js");
    writeFileAtomic = mod.writeFileAtomic;
  });

  afterEach(() => {
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  });

  it("applies mode 0o600 when specified", () => {
    const filePath = path.join(TEST_DIR, "secret.json");
    writeFileAtomic(filePath, '{"secret": true}', { mode: 0o600 });
    const stat = fs.statSync(filePath);
    const mode = stat.mode & 0o777;
    if (POSIX_FILE_MODES) expect(mode).toBe(0o600);
  });

  it("existing callers unaffected (no options)", () => {
    const filePath = path.join(TEST_DIR, "normal.json");
    writeFileAtomic(filePath, '{"data": true}');
    expect(fs.existsSync(filePath)).toBe(true);
    expect(fs.readFileSync(filePath, "utf-8")).toBe('{"data": true}');
  });
});
