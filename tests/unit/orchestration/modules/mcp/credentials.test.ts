import { describe, expect, test } from "bun:test";
import { POSIX_FILE_MODES } from "../../../../helpers/posix-modes.js";
import { statSync } from "node:fs";
import { join } from "node:path";
import { Redacted, Schema } from "effect";
import { McpConfigSchema, resolveMcpConfig } from "../../../../../src/orchestration/modules/mcp/config.js";
import {
  createMcpCredentialStore,
  credentialKey,
  fromDiskCredential,
  toDiskCredential,
  type McpCredential,
} from "../../../../../src/orchestration/modules/mcp/credentials.js";
import { temporaryDirectories } from "../../../../helpers/directories.js";

const temporaryDirectory = temporaryDirectories();

function credential(value: string): McpCredential {
  return {
    tokens: {
      accessToken: Redacted.make(value),
      refreshToken: Redacted.make(`${value}-refresh`),
      tokenType: "Bearer",
      expiresAt: 1234,
      scope: "tools",
      issuer: "https://auth.example",
    },
    clientInformation: {
      clientId: "client-id",
      clientSecret: Redacted.make(`${value}-client`),
      clientIdIssuedAt: 12,
      clientSecretExpiresAt: 34,
      issuer: "https://auth.example",
    },
    codeVerifier: Redacted.make(`${value}-verifier`),
    clientSecret: Redacted.make(`${value}-preregistered`),
  };
}

describe("MCP credentials", () => {
  test("keys credentials by server name and SHA-256 URL", () => {
    expect(credentialKey("work", "https://one.example/mcp")).toMatch(/^work:[a-f0-9]{64}$/);
    expect(credentialKey("work", "https://one.example/mcp"))
      .not.toBe(credentialKey("work", "https://two.example/mcp"));
  });

  test("round-trips only through explicit disk DTO functions", () => {
    const original = credential("access-value");
    const restored = fromDiskCredential(toDiskCredential(original));
    expect(Redacted.value(restored.tokens?.accessToken ?? Redacted.make(""))).toBe("access-value");
    expect(Redacted.value(restored.tokens?.refreshToken ?? Redacted.make(""))).toBe("access-value-refresh");
    expect(Redacted.value(restored.clientInformation?.clientSecret ?? Redacted.make(""))).toBe("access-value-client");
    expect(Redacted.value(restored.codeVerifier ?? Redacted.make(""))).toBe("access-value-verifier");
    expect(Redacted.value(restored.clientSecret ?? Redacted.make(""))).toBe("access-value-preregistered");
    expect(restored.tokens?.issuer).toBe("https://auth.example");
    expect(restored.clientInformation?.issuer).toBe("https://auth.example");
  });

  test("reads a store written before the pre-registered client secret existed", async () => {
    const dir = temporaryDirectory("mcp-credentials-test-");
    const url = "https://one.example/mcp";
    await Bun.write(join(dir, "mcp-credentials.json"), JSON.stringify({
      [credentialKey("work", url)]: {
        tokens: { access_token: "old-access", token_type: "Bearer", refresh_token: "old-refresh", expires_at: 1234, scope: "tools" },
        client_information: { client_id: "old-client", client_secret: "old-client-secret", client_id_issued_at: 12, client_secret_expires_at: 34 },
        headers: { "X-Api-Key": "old-header" },
      },
    }));
    const restored = createMcpCredentialStore(dir).get("work", url);
    expect(restored?.tokens).toMatchObject({ tokenType: "Bearer", expiresAt: 1234, scope: "tools" });
    expect(Redacted.value(restored?.tokens?.accessToken ?? Redacted.make(""))).toBe("old-access");
    expect(Redacted.value(restored?.tokens?.refreshToken ?? Redacted.make(""))).toBe("old-refresh");
    expect(restored?.tokens?.issuer).toBeUndefined();
    expect(restored?.clientInformation).toMatchObject({ clientId: "old-client", clientIdIssuedAt: 12, clientSecretExpiresAt: 34 });
    expect(Redacted.value(restored?.clientInformation?.clientSecret ?? Redacted.make(""))).toBe("old-client-secret");
    expect(restored?.clientInformation?.issuer).toBeUndefined();
    expect(Redacted.value(restored?.headers?.["X-Api-Key"] ?? Redacted.make(""))).toBe("old-header");
    expect(restored?.clientSecret).toBeUndefined();
  });

  test("isolates same-name credentials for different URLs and writes mode 0600", async () => {
    const dir = temporaryDirectory("mcp-credentials-test-");
    const store = createMcpCredentialStore(dir);
    await store.save("work", "https://one.example/mcp", credential("one"));
    await store.save("work", "https://two.example/mcp", credential("two"));
    await store.save("personal", "https://one.example/mcp", credential("personal"));
    expect(Redacted.value(store.get("work", "https://one.example/mcp")?.tokens?.accessToken ?? Redacted.make(""))).toBe("one");
    expect(Redacted.value(store.get("work", "https://two.example/mcp")?.tokens?.accessToken ?? Redacted.make(""))).toBe("two");
    const reopened = createMcpCredentialStore(dir);
    expect(Redacted.value(reopened.get("personal", "https://one.example/mcp")?.tokens?.accessToken ?? Redacted.make(""))).toBe("personal");
    expect(Redacted.value(reopened.get("work", "https://one.example/mcp")?.tokens?.accessToken ?? Redacted.make(""))).toBe("one");
    const config = Schema.decodeUnknownSync(McpConfigSchema)({
      servers: { work: { url: "https://one.example/mcp" } },
      projects: { "/a": { servers: { work: { url: "https://one.example/mcp" }, personal: { url: "https://one.example/mcp" } } } },
    });
    for (const root of ["/a", "/b"]) {
      const url = resolveMcpConfig(config, root).servers.work?.url;
      expect(url).toBe("https://one.example/mcp");
      expect(Redacted.value(reopened.get("work", url!)?.tokens?.accessToken ?? Redacted.make(""))).toBe("one");
    }
    if (POSIX_FILE_MODES) expect(statSync(join(dir, "mcp-credentials.json")).mode & 0o777).toBe(0o600);
  });

  test("preserves concurrent writes to different keys", async () => {
    const dir = temporaryDirectory("mcp-credentials-test-");
    const store = createMcpCredentialStore(dir);
    await Promise.all(Array.from({ length: 8 }, (_, index) =>
      store.save(`server-${index}`, "https://example.test/mcp", credential(String(index)))));
    for (let index = 0; index < 8; index++) {
      expect(store.get(`server-${index}`, "https://example.test/mcp")).toBeDefined();
    }
  });
});
