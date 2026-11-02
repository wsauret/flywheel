import { describe, expect, it, spyOn } from "bun:test";
import { Redacted } from "effect";
import { loginXai, parseXaiDeviceCodeResponse, pollForXaiTokens } from "../../../../src/orchestration/modules/provider-supergrok/oauth.js";

describe("parseXaiDeviceCodeResponse", () => {
  it("keeps a trusted complete URL that embeds the user code", () => {
    const parsed = parseXaiDeviceCodeResponse({
      device_code: "dev-1",
      user_code: "WXYZ-5678",
      verification_uri: "https://accounts.x.ai/oauth2/device",
      verification_uri_complete: "https://accounts.x.ai/oauth2/device?user_code=WXYZ-5678",
      interval: 7,
      expires_in: 600,
    });
    expect(parsed).toEqual({
      device_code: "dev-1",
      user_code: "WXYZ-5678",
      verification_uri: "https://accounts.x.ai/oauth2/device",
      verification_uri_complete: "https://accounts.x.ai/oauth2/device?user_code=WXYZ-5678",
      interval: 7,
      expires_in: 600,
    });
  });

  it("defaults a missing interval and rejects invalid intervals", () => {
    const base = {
      device_code: "dev-1",
      user_code: "WXYZ-5678",
      verification_uri: "https://auth.x.ai/activate",
      verification_uri_complete: "https://accounts.x.ai/oauth2/device?user_code=WXYZ-5678",
      expires_in: 600,
    };
    expect(parseXaiDeviceCodeResponse(base).interval).toBe(5);
    expect(() => parseXaiDeviceCodeResponse({ ...base, interval: 0 })).toThrow("Invalid device code response fields");
    expect(() => parseXaiDeviceCodeResponse({ ...base, interval: 61 })).toThrow("Invalid device code response fields");
  });

  it("rejects an excessive device-code lifetime", () => {
    expect(() => parseXaiDeviceCodeResponse({
      device_code: "dev-1",
      user_code: "WXYZ-5678",
      verification_uri: "https://auth.x.ai/activate",
      verification_uri_complete: "https://accounts.x.ai/oauth2/device?user_code=WXYZ-5678",
      expires_in: 1_801,
    })).toThrow("Invalid device code response fields");
  });

  it("rejects oversized secrets and unsafe verification URLs", () => {
    const base = {
      device_code: "dev-1",
      user_code: "WXYZ-5678",
      verification_uri: "https://auth.x.ai/activate",
      verification_uri_complete: "https://accounts.x.ai/oauth2/device?user_code=WXYZ-5678",
      expires_in: 600,
    };
    expect(() => parseXaiDeviceCodeResponse({ ...base, device_code: "x".repeat(8193) })).toThrow("Invalid device code response fields");
    expect(() => parseXaiDeviceCodeResponse({ ...base, verification_uri: "https://evil.example/activate" })).toThrow("Invalid device code response fields");
    for (const complete of [undefined, "https://evil.example/activate?user_code=x", "https://auth.x.ai/activate?user_code=" + "x".repeat(2049)]) {
      expect(() => parseXaiDeviceCodeResponse({ ...base, verification_uri_complete: complete })).toThrow("SuperGrok did not return a valid complete verification URL");
    }
  });
});

describe("loginXai", () => {
  async function firstInstructions(deviceResponse: Parameters<typeof parseXaiDeviceCodeResponse>[0]) {
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async () => Response.json(deviceResponse), { preconnect: fetch.preconnect }));
    const abort = new AbortController();
    const opened: string[] = [];
    let shown: { userCode?: string; url: string } | undefined;
    try {
      await expect(loginXai({
        openBrowser: async (url) => { opened.push(url); return true; },
        onUserCode: (instructions) => { shown = instructions; abort.abort(); },
        signal: abort.signal,
      })).rejects.toThrow("Login cancelled");
    } finally {
      fetchSpy.mockRestore();
    }
    return { shown, opened };
  }
  const device = { device_code: "dev-1", user_code: "WXYZ-5678", verification_uri: "https://accounts.x.ai/oauth2/device", expires_in: 600 };

  it("shows and opens the complete link without the separate code", async () => {
    const complete = "https://accounts.x.ai/oauth2/device?user_code=WXYZ-5678";
    const { shown, opened } = await firstInstructions({ ...device, verification_uri_complete: complete });
    expect(shown).toEqual({ url: complete });
    expect(opened).toEqual([complete]);
  });

});

describe("pollForXaiTokens", () => {
  it("polls again after a dropped connection or a server error, and reports each change of state once", async () => {
    const answers: Array<() => Promise<Response>> = [
      async () => { throw new TypeError("fetch failed"); },
      async () => { throw new TypeError("fetch failed"); },
      async () => new Response("", { status: 503 }),
      async () => Response.json({ error: "slow_down" }, { status: 400 }),
      async () => Response.json({ error: "authorization_pending" }, { status: 400 }),
      async () => Response.json({ access_token: "xai-access", refresh_token: "xai-refresh", expires_in: 3600 }),
    ];
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async () => {
      const next = answers.shift();
      if (next === undefined) throw new Error("the poll asked more often than the test answers");
      return next();
    }, { preconnect: fetch.preconnect }));
    const progress: string[] = [];
    const waits: number[] = [];
    const device = parseXaiDeviceCodeResponse({
      device_code: "dev-1",
      user_code: "WXYZ-5678",
      verification_uri: "https://accounts.x.ai/oauth2/device",
      verification_uri_complete: "https://accounts.x.ai/oauth2/device?user_code=WXYZ-5678",
      expires_in: 600,
    });
    try {
      const tokens = await pollForXaiTokens(device, { onProgress: (message) => progress.push(message), wait: async (ms) => { waits.push(ms); } });
      expect(Redacted.value(tokens.accessToken)).toBe("xai-access");
    } finally {
      fetchSpy.mockRestore();
    }
    expect(answers).toEqual([]);
    expect(waits).toEqual([5000, 5000, 5000, 5000, 10000, 10000]);
    expect(progress).toEqual([
      "The connection to SuperGrok was interrupted. Still waiting for approval...",
      "SuperGrok asked Flywheel to check less often. Checking every 10 seconds...",
    ]);
  });
});
