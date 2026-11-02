import { describe, expect, test } from "bun:test";
import {
  formatProviderUserAgent,
  openCodeGoRequestHeaders,
  openRouterRequestHeaders,
} from "../../../../src/infra/llm/provider-request-identity.js";

describe("provider request identity", () => {
  test("formats the canonical Flywheel User-Agent", () => {
    expect(formatProviderUserAgent("1.2.3", "linux", "6.8.0", "x64")).toBe("flywheel/1.2.3 (linux 6.8.0; x64)");
  });

  test("adds OpenRouter application attribution", async () => {
    expect(await openRouterRequestHeaders()).toMatchObject({
      "HTTP-Referer": "https://github.com/wsauret/flywheel",
      "X-Title": "Flywheel",
    });
  });

  test("rejects an OpenCode Go request without a stable session identity", async () => {
    expect(openCodeGoRequestHeaders(undefined)).rejects.toThrow("OpenCode Go requests require a provider session key");
  });
});
