import { parseSchema } from "../../../helpers/schema-assertions.js";
import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import { PersistedAuthStoreSchema, createAuthStoreSchema, CredentialSchema, MeteredCredentialRecordSchema } from "../../../../src/infra/auth/auth-store-types.js";

describe("CredentialSchema", () => {
  test("parses valid api_key credential", () => {
    const result = parseSchema(CredentialSchema, { type: "api_key", key: "sk-123" });
    expect(result).toEqual({ type: "api_key", key: "sk-123" });
  });

  test("parses valid oauth credential with all fields", () => {
    const result = parseSchema(CredentialSchema, {
      type: "oauth",
      access: "ghu_abc",
      refresh: "ghr_xyz",
      expires: 1700000000000,
      accountId: "acct-1",
      enterpriseDomain: "corp.github.com",
    });
    expect(result).toEqual({
      type: "oauth",
      access: "ghu_abc",
      refresh: "ghr_xyz",
      expires: 1700000000000,
      accountId: "acct-1",
      enterpriseDomain: "corp.github.com",
    });
  });

  test("rejects credential with unknown type", () => {
    expect(() => parseSchema(CredentialSchema, { type: "bearer", token: "x" })).toThrow();
  });

  test("rejects oauth credential missing access", () => {
    expect(() =>
      parseSchema(CredentialSchema, { type: "oauth", refresh: "r", expires: 1 }),
    ).toThrow();
  });

  test("parses oauth credential without a refresh token (provider issued none)", () => {
    const result = parseSchema(CredentialSchema, { type: "oauth", access: "a", expires: 1 });
    expect(result).toEqual({ type: "oauth", access: "a", expires: 1 });
  });

  test("rejects oversized and invalid persisted credential fields", () => {
    expect(() => parseSchema(CredentialSchema, { type: "api_key", key: "x".repeat(64 * 1024 + 1) })).toThrow();
    expect(() => parseSchema(CredentialSchema, { type: "oauth", access: "x".repeat(8 * 1024 + 1), expires: 1 })).toThrow();
    expect(() => parseSchema(CredentialSchema, { type: "oauth", access: "token", expires: Number.POSITIVE_INFINITY })).toThrow();
    expect(() => parseSchema(CredentialSchema, { type: "oauth", access: "token", expires: 32_503_680_000_001 })).toThrow();
  });
});

describe("MeteredCredentialRecordSchema", () => {
  test("requires an opaque UUID lineage on a metered credential", () => {
    const record = { type: "api_key" as const, key: "secret", lineageId: crypto.randomUUID() };
    expect(parseSchema(MeteredCredentialRecordSchema, record)).toEqual(record);
    expect(Schema.decodeUnknownSync(CredentialSchema)(record)).toEqual({ type: "api_key", key: "secret" });
    expect(() => parseSchema(MeteredCredentialRecordSchema, { type: "api_key", key: "secret" })).toThrow();
    expect(() => parseSchema(MeteredCredentialRecordSchema, { ...record, lineageId: "secret-derived-id" })).toThrow();
  });
});

describe("PersistedAuthStoreSchema", () => {
  test("parses valid store with mixed credential types", () => {
    const store = {
      anthropic_api: { type: "api_key" as const, key: "sk-ant", lineageId: crypto.randomUUID() },
      github_copilot: {
        type: "oauth" as const,
        access: "cop-tok",
        refresh: "gh-tok",
        expires: 1700000000000,
        lineageId: crypto.randomUUID(),
      },
    };
    expect(parseSchema(PersistedAuthStoreSchema, store)).toEqual(store);
  });

  test("parses empty object", () => {
    expect(parseSchema(PersistedAuthStoreSchema, {})).toEqual({});
  });

  test("rejects store with invalid credential", () => {
    expect(() =>
      parseSchema(PersistedAuthStoreSchema, { bad: { type: "unknown" } }),
    ).toThrow();
  });

  test("catalog-derived schema rejects an unknown provider id", () => {
    const schema = createAuthStoreSchema(["chatgpt", "openai_api"]);
    expect(() => parseSchema(schema, { removed_provider: { type: "api_key", key: "secret" } })).toThrow();
  });

  test("rejects duplicate stable instance IDs in one provider collection", () => {
    const duplicate = {
      chatgpt: [
        { id: "account-a", identity: "subject-a", credential: { type: "oauth", access: "one", expires: 1 } },
        { id: "account-a", identity: "subject-b", credential: { type: "oauth", access: "two", expires: 1 } },
      ],
    };
    expect(() => parseSchema(PersistedAuthStoreSchema, duplicate)).toThrow();
    expect(() => parseSchema(createAuthStoreSchema(["chatgpt"]), duplicate)).toThrow();
  });
});
