import { describe, expect, test } from "bun:test";
import { Redacted } from "effect";
import { fetchCopilotIdentity, parseDeviceCodeResponse } from "../../../../src/orchestration/modules/provider-github-copilot/oauth.js";

const COMPLETE_RESPONSE = {
  device_code: "dc-123",
  user_code: "ABCD-1234",
  verification_uri: "https://github.com/login/device",
  interval: 7,
  expires_in: 900,
};

describe("parseDeviceCodeResponse", () => {
  test("passes through a complete response", () => {
    expect(parseDeviceCodeResponse(COMPLETE_RESPONSE)).toEqual(COMPLETE_RESPONSE);
  });

  test("defaults a missing interval to 5 seconds per RFC 8628", () => {
    const { interval: _omitted, ...withoutInterval } = COMPLETE_RESPONSE;
    expect(parseDeviceCodeResponse(withoutInterval).interval).toBe(5);
  });

  test("rejects a non-numeric, non-positive, or excessive interval", () => {
    expect(() => parseDeviceCodeResponse({ ...COMPLETE_RESPONSE, interval: "10" })).toThrow("Invalid device code response fields");
    expect(() => parseDeviceCodeResponse({ ...COMPLETE_RESPONSE, interval: 0 })).toThrow("Invalid device code response fields");
    expect(() => parseDeviceCodeResponse({ ...COMPLETE_RESPONSE, interval: 61 })).toThrow("Invalid device code response fields");
  });

  test("rejects an excessive device-code lifetime", () => {
    expect(() => parseDeviceCodeResponse({ ...COMPLETE_RESPONSE, expires_in: 1_801 })).toThrow("Invalid device code response fields");
  });

  test("rejects a response missing a required field", () => {
    const { device_code: _omitted, ...withoutDeviceCode } = COMPLETE_RESPONSE;
    expect(() => parseDeviceCodeResponse(withoutDeviceCode)).toThrow("Invalid device code response fields");
  });
});

describe("fetchCopilotIdentity", () => {
  test("uses the public whoami endpoint and required GitHub headers", async () => {
    let request: Request | undefined;
    const identity = await fetchCopilotIdentity(Redacted.make("github-token"), undefined, undefined, Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
      request = new Request(input, init);
      return Response.json({ login: "octocat" });
    }, { preconnect: () => {} }));
    expect(identity).toBe("octocat");
    expect(request?.url).toBe("https://api.github.com/user");
    expect(request?.headers.get("authorization")).toBe("Bearer github-token");
    expect(request?.headers.get("accept")).toBe("application/vnd.github+json");
  });

  test("uses the enterprise API URL and tolerates non-cancellation failures", async () => {
    let url = "";
    const identity = await fetchCopilotIdentity(Redacted.make("github-token"), "company.ghe.com", undefined, Object.assign(async (input: RequestInfo | URL) => {
      url = String(input);
      return new Response("unavailable", { status: 503 });
    }, { preconnect: () => {} }));
    expect(url).toBe("https://company.ghe.com/api/v3/user");
    expect(identity).toBeUndefined();
  });

  test("propagates caller cancellation", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(fetchCopilotIdentity(Redacted.make("github-token"), undefined, controller.signal, fetch)).rejects.toThrow("Login cancelled");
  });
});
