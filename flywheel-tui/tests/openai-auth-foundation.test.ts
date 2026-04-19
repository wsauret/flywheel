import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TEST_DIR = "/tmp/flywheel-test-auth";

function createTestJwt(payload: Record<string, unknown>): string {
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
// JWT parsing
// ---------------------------------------------------------------------------

describe("parseJwtClaims", () => {
  // Lazy import to allow test file to exist before implementation
  let parseJwtClaims: typeof import("../src/infra/auth/openai-jwt.js").parseJwtClaims;

  beforeEach(async () => {
    const mod = await import("../src/infra/auth/openai-jwt.js");
    parseJwtClaims = mod.parseJwtClaims;
  });

  it("parses a valid JWT payload", () => {
    const token = createTestJwt({ sub: "user-123", email: "test@example.com" });
    const claims = parseJwtClaims(token);
    expect(claims).toBeDefined();
    expect(claims!.sub).toBe("user-123");
  });

  it("returns undefined for a malformed JWT with only 2 segments", () => {
    const claims = parseJwtClaims("header.body");
    expect(claims).toBeUndefined();
  });

  it("returns undefined for invalid base64 in payload", () => {
    const claims = parseJwtClaims("valid-header.!!!invalid-base64!!!.signature");
    expect(claims).toBeUndefined();
  });

  it("returns undefined for non-JSON payload", () => {
    const header = Buffer.from("{}").toString("base64url");
    const body = Buffer.from("not json at all").toString("base64url");
    const claims = parseJwtClaims(`${header}.${body}.sig`);
    expect(claims).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Account ID extraction
// ---------------------------------------------------------------------------

describe("extractAccountId", () => {
  let extractAccountId: typeof import("../src/infra/auth/openai-jwt.js").extractAccountId;

  beforeEach(async () => {
    const mod = await import("../src/infra/auth/openai-jwt.js");
    extractAccountId = mod.extractAccountId;
  });

  it("extracts from root chatgpt_account_id claim", () => {
    const idToken = createTestJwt({ chatgpt_account_id: "acct-root" });
    const result = extractAccountId({ id_token: idToken } as Parameters<typeof extractAccountId>[0]);
    expect(result).toBe("acct-root");
  });

  it("extracts from nested auth claim", () => {
    const idToken = createTestJwt({
      "https://api.openai.com/auth": { chatgpt_account_id: "acct-nested" },
    });
    const result = extractAccountId({ id_token: idToken } as Parameters<typeof extractAccountId>[0]);
    expect(result).toBe("acct-nested");
  });

  it("extracts from organizations fallback", () => {
    const idToken = createTestJwt({
      "https://api.openai.com/auth": {
        organizations: [{ id: "org-fallback" }],
      },
    });
    const result = extractAccountId({ id_token: idToken } as Parameters<typeof extractAccountId>[0]);
    expect(result).toBe("org-fallback");
  });

  it("prefers root claim over nested claim", () => {
    const idToken = createTestJwt({
      chatgpt_account_id: "acct-root",
      "https://api.openai.com/auth": { chatgpt_account_id: "acct-nested" },
    });
    const result = extractAccountId({ id_token: idToken } as Parameters<typeof extractAccountId>[0]);
    expect(result).toBe("acct-root");
  });

  it("returns undefined when no id_token is present", () => {
    const result = extractAccountId({} as Parameters<typeof extractAccountId>[0]);
    expect(result).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Token store
// ---------------------------------------------------------------------------

describe("openai-token-store", () => {
  let loadStoredTokens: typeof import("../src/infra/auth/openai-token-store.js").loadStoredTokens;
  let saveStoredTokens: typeof import("../src/infra/auth/openai-token-store.js").saveStoredTokens;
  let deleteStoredTokens: typeof import("../src/infra/auth/openai-token-store.js").deleteStoredTokens;
  let isTokenExpired: typeof import("../src/infra/auth/openai-token-store.js").isTokenExpired;

  beforeEach(async () => {
    ensureCleanDir(TEST_DIR);
    const mod = await import("../src/infra/auth/openai-token-store.js");
    loadStoredTokens = mod.loadStoredTokens;
    saveStoredTokens = mod.saveStoredTokens;
    deleteStoredTokens = mod.deleteStoredTokens;
    isTokenExpired = mod.isTokenExpired;
  });

  afterEach(() => {
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  });

  it("write/read round-trip preserves token data", () => {
    const tokens = {
      accessToken: "access-123",
      refreshToken: "refresh-456",
      expiresAtMs: Date.now() + 3_600_000,
      accountId: "acct-789",
    };
    saveStoredTokens(tokens, TEST_DIR);
    const loaded = loadStoredTokens(TEST_DIR);
    expect(loaded).not.toBeNull();
    expect(loaded!.accessToken).toBe("access-123");
    expect(loaded!.refreshToken).toBe("refresh-456");
    expect(loaded!.expiresAtMs).toBe(tokens.expiresAtMs);
    expect(loaded!.accountId).toBe("acct-789");
  });

  it("isTokenExpired returns true when token is past expiry", () => {
    const tokens = {
      accessToken: "a",
      refreshToken: "r",
      expiresAtMs: Date.now() - 1000,
    };
    expect(isTokenExpired(tokens)).toBe(true);
  });

  it("isTokenExpired returns true within buffer window", () => {
    const tokens = {
      accessToken: "a",
      refreshToken: "r",
      expiresAtMs: Date.now() + 30_000,
    };
    expect(isTokenExpired(tokens, 60_000)).toBe(true);
  });

  it("isTokenExpired returns false when token is fresh", () => {
    const tokens = {
      accessToken: "a",
      refreshToken: "r",
      expiresAtMs: Date.now() + 3_600_000,
    };
    expect(isTokenExpired(tokens)).toBe(false);
  });

  it("returns null when file does not exist", () => {
    const loaded = loadStoredTokens(TEST_DIR);
    expect(loaded).toBeNull();
  });

  it("saved file has 0o600 permissions", () => {
    const tokens = {
      accessToken: "a",
      refreshToken: "r",
      expiresAtMs: Date.now() + 3_600_000,
    };
    saveStoredTokens(tokens, TEST_DIR);
    const tokenPath = path.join(TEST_DIR, "openai.json");
    const stat = fs.statSync(tokenPath);
    const mode = stat.mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("rejects corrupt JSON via Zod validation", () => {
    const tokenPath = path.join(TEST_DIR, "openai.json");
    fs.writeFileSync(tokenPath, JSON.stringify({ garbage: true }), "utf-8");
    const loaded = loadStoredTokens(TEST_DIR);
    expect(loaded).toBeNull();
  });

  it("deleteStoredTokens is idempotent", () => {
    deleteStoredTokens(TEST_DIR);
    deleteStoredTokens(TEST_DIR);
  });
});

// ---------------------------------------------------------------------------
// PKCE
// ---------------------------------------------------------------------------

describe("PKCE", () => {
  let generatePKCE: typeof import("../src/infra/auth/openai-pkce.js").generatePKCE;
  let generateState: typeof import("../src/infra/auth/openai-pkce.js").generateState;

  beforeEach(async () => {
    const mod = await import("../src/infra/auth/openai-pkce.js");
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

  it("generateState returns a non-empty string", () => {
    const state = generateState();
    expect(state.length).toBeGreaterThan(0);
  });

  it("generateState returns different values on each call", () => {
    const a = generateState();
    const b = generateState();
    expect(a).not.toBe(b);
  });
});

// ---------------------------------------------------------------------------
// Types — StoredTokensSchema validation
// ---------------------------------------------------------------------------

describe("StoredTokensSchema", () => {
  let StoredTokensSchema: typeof import("../src/infra/auth/openai-auth-types.js").StoredTokensSchema;

  beforeEach(async () => {
    const mod = await import("../src/infra/auth/openai-auth-types.js");
    StoredTokensSchema = mod.StoredTokensSchema;
  });

  it("parses valid stored tokens", () => {
    const result = StoredTokensSchema.safeParse({
      accessToken: "access-abc",
      refreshToken: "refresh-def",
      expiresAtMs: Date.now() + 3_600_000,
    });
    expect(result.success).toBe(true);
  });

  it("accepts optional accountId", () => {
    const result = StoredTokensSchema.safeParse({
      accessToken: "a",
      refreshToken: "r",
      expiresAtMs: 123456,
      accountId: "acct-123",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.accountId).toBe("acct-123");
    }
  });

  it("rejects missing required fields", () => {
    const result = StoredTokensSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  it("rejects non-number expiresAtMs", () => {
    const result = StoredTokensSchema.safeParse({
      accessToken: "a",
      refreshToken: "r",
      expiresAtMs: "not-a-number",
    });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// writeFileAtomic — mode parameter
// ---------------------------------------------------------------------------

describe("writeFileAtomic — mode option", () => {
  let writeFileAtomic: typeof import("../src/infra/atomic-write.js").writeFileAtomic;

  beforeEach(async () => {
    ensureCleanDir(TEST_DIR);
    const mod = await import("../src/infra/atomic-write.js");
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
    expect(mode).toBe(0o600);
  });

  it("existing callers unaffected (no options)", () => {
    const filePath = path.join(TEST_DIR, "normal.json");
    writeFileAtomic(filePath, '{"data": true}');
    expect(fs.existsSync(filePath)).toBe(true);
    expect(fs.readFileSync(filePath, "utf-8")).toBe('{"data": true}');
  });
});
