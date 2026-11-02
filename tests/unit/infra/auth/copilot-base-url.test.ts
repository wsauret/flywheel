import { describe, expect, test } from "bun:test";
import { Redacted } from "effect";
import { getGitHubCopilotBaseUrl, rebaseToCopilotHost } from "../../../../src/orchestration/modules/provider-github-copilot/base-url.js";

describe("getGitHubCopilotBaseUrl", () => {
  test("uses proxy endpoint embedded in a Copilot token", () => {
    expect(getGitHubCopilotBaseUrl(Redacted.make("abc;proxy-ep=proxy.business.githubcopilot.com;def"))).toBe(
      "https://api.business.githubcopilot.com",
    );
  });

  test("uses enterprise domain when token has no proxy endpoint", () => {
    expect(getGitHubCopilotBaseUrl(Redacted.make("token"), "example.ghe.com")).toBe("https://copilot-api.example.ghe.com");
  });

  test("falls back to individual Copilot API", () => {
    expect(getGitHubCopilotBaseUrl()).toBe("https://api.individual.githubcopilot.com");
  });

  test("rejects hostile proxy and enterprise hosts", () => {
    for (const host of ["evil.example", "githubcopilot.com.evil.example", "user@githubcopilot.com", "githubcopilot.com:443", "githubcopilot.com/path"]) {
      expect(() => getGitHubCopilotBaseUrl(Redacted.make(`token;proxy-ep=${host};end`))).toThrow("accepted HTTPS host");
    }
    for (const domain of ["evil.example", "example.ghe.com.evil.example", "user@example.ghe.com", "example.ghe.com:443", "example.ghe.com/path"]) {
      expect(() => getGitHubCopilotBaseUrl(undefined, domain)).toThrow("accepted HTTPS host");
    }
  });
});

describe("rebaseToCopilotHost", () => {
  test("moves a request onto the host the current token names, keeping path and query", () => {
    expect(
      rebaseToCopilotHost(
        "https://api.individual.githubcopilot.com/chat/completions?beta=1",
        "https://api.business.githubcopilot.com",
      ),
    ).toBe("https://api.business.githubcopilot.com/chat/completions?beta=1");
  });

  test("leaves a request alone when the host already matches", () => {
    expect(
      rebaseToCopilotHost("https://api.individual.githubcopilot.com/models", "https://api.individual.githubcopilot.com"),
    ).toBe("https://api.individual.githubcopilot.com/models");
  });

  test("accepts URL instances", () => {
    expect(
      rebaseToCopilotHost(new URL("https://api.individual.githubcopilot.com/v1/messages"), "https://copilot-api.example.ghe.com"),
    ).toBe("https://copilot-api.example.ghe.com/v1/messages");
  });
});
