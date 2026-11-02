import { describe, expect, test } from "bun:test";

import { Redacted, Schema } from "effect";

import { createAuthLoginService } from "../../../../src/orchestration/app-service/auth-login-service.js";
import { FrontendMutationSchema } from "../../../../src/protocol/runtime-protocol-schemas.js";
import type { AuthProviderStatus } from "../../../../src/protocol/auth-status-protocol-types.js";
import { defaultModuleState } from "../../../../src/orchestration/config/module-descriptor.js";
import { refusingLauncher } from "../../../helpers/launcher-fake.js";

/** The `auth.login` key is a credential, and the wire codec is its one
 *  serialization boundary. Decode must hand every consumer a `Redacted`, so a
 *  logged or traced mutation can only ever show the placeholder, and encode
 *  must unwrap so the runtime on the other side receives the real key. */

const SECRET = "sk-test-1234567890";

describe("auth.login secret handling", () => {
  test("decoding the wire frame wraps the key before anything can observe it", () => {
    const decoded = Schema.decodeUnknownSync(FrontendMutationSchema)({
      type: "auth.login",
      providerId: "anthropic_api",
      apiKey: SECRET,
    });
    if (decoded.type !== "auth.login") throw new Error(`Decoded the wrong mutation: ${decoded.type}`);
    expect(Redacted.isRedacted(decoded.apiKey)).toBe(true);
    expect(decoded.apiKey === undefined ? undefined : Redacted.value(decoded.apiKey)).toBe(SECRET);
    // What a log line, trace field, or thrown error would render.
    expect(String(decoded.apiKey)).not.toContain(SECRET);
    expect(JSON.stringify(decoded)).not.toContain(SECRET);
  });

  test("encoding unwraps the key onto the wire and nowhere else", () => {
    const encoded = Schema.encodeUnknownSync(FrontendMutationSchema)({
      type: "auth.login",
      providerId: "anthropic_api",
      apiKey: Redacted.make(SECRET),
    });
    expect(encoded).toEqual({ type: "auth.login", providerId: "anthropic_api", apiKey: SECRET });
  });

  test("browser completion is redacted after protocol decode", () => {
    const decoded = Schema.decodeUnknownSync(FrontendMutationSchema)({
      type: "auth.login.complete",
      operationId: "operation-1",
      input: SECRET,
    });
    if (decoded.type !== "auth.login.complete") throw new Error(`Decoded the wrong mutation: ${decoded.type}`);
    expect(Redacted.isRedacted(decoded.input)).toBe(true);
    expect(Redacted.value(decoded.input)).toBe(SECRET);
    expect(JSON.stringify(decoded)).not.toContain(SECRET);
  });

  test("the login service accepts the Redacted key and still refuses a blank one", async () => {
    const provider: AuthProviderStatus = {
      providerId: "anthropic_api",
      kind: "singleton",
      source: "unconfigured",
      expired: false,
      modelCapable: true,
      loginMethod: "api-key",
      statusRank: 0,
      group: "model",
      accounts: [],
      displayName: "Anthropic API",
    };
    const login = createAuthLoginService({
      resolveProfile: () => ({ id: "default", directory: "/scratch/does-not-matter" }),
      resolveKey: async (value: string) => Redacted.make(value),
      launcher: refusingLauncher,
      openBrowser: async () => false,
      refresh: async () => {},
      publishNotice: async () => {},
      settleCatalog: () => async () => {},
      admit: async (request) => ({ ok: true, grant: { ...defaultModuleState(), ...request } }),
      providers: async () => [provider],
      loginFlows: () => undefined,
      log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    });
    // A whitespace-only key proves the service unwrapped the Redacted value to
    // judge emptiness rather than treating the wrapper itself as a key.
    const result = await login.login({ providerId: "anthropic_api", apiKey: Redacted.make("   ") });
    expect(result.kind).toBe("needs_key");
    login.dispose();
  });
});
