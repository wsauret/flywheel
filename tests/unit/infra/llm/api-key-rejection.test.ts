import { describe, expect, test } from "bun:test";
import { apiKeyRejectionReason } from "../../../../src/infra/llm/access-provider.js";
import { testProviderSelection } from "../../../helpers/provider-authority.js";

/** The check reads each definition's declared key prefix: a key that carries
 *  another installed provider's prefix is refused, and nothing else is. */
const definitions = testProviderSelection().definitions;
const reason = (providerId: string, key: string) => apiKeyRejectionReason(definitions, providerId, key);

describe("apiKeyRejectionReason", () => {
  test("rejects a Vertex express key entered for the Gemini API provider", () => {
    const rejection = reason("google_api", "AQ.Ab8example");
    expect(rejection).toContain("Vertex AI express key");
    expect(rejection).toContain("Google Vertex");
  });

  test("rejects a Gemini Developer key entered for the Vertex provider", () => {
    const rejection = reason("google_vertex", "AIzaExample");
    expect(rejection).toContain("Gemini Developer API key");
    expect(rejection).toContain("Google API Key");
  });

  test("longest prefix wins: an Anthropic key at OpenAI is rejected as Anthropic, not accepted as sk-", () => {
    expect(reason("openai_api", "sk-ant-example")).toContain("Anthropic API key");
    expect(reason("anthropic_api", "sk-ant-example")).toBeUndefined();
    expect(reason("openai_api", "sk-proj-example")).toBeUndefined();
  });

  test("accepts unknown key formats so a new provider format never locks out", () => {
    expect(reason("google_api", "totally-new-format")).toBeUndefined();
  });

  test("never rejects for providers that own no prefix", () => {
    expect(reason("opencode_go", "AIzaExample")).toBeUndefined();
    expect(reason("my_custom_proxy", "AIzaExample")).toBeUndefined();
    expect(reason("exa", "sk-ant-example")).toBeUndefined();
  });
});
