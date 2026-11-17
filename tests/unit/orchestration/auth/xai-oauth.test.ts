import { describe, expect, it, onTestFinished, spyOn } from "bun:test";
import { Redacted } from "effect";
import { loginXai } from "../../../../src/orchestration/modules/provider-supergrok/oauth.js";
import { onFakeClock } from "../../../helpers/fake-clock.js";

const COMPLETE_URL = "https://accounts.x.ai/oauth2/device?user_code=WXYZ-5678";
const DEVICE = {
  device_code: "dev-1",
  user_code: "WXYZ-5678",
  verification_uri: "https://auth.x.ai/activate",
  verification_uri_complete: COMPLETE_URL,
  expires_in: 600,
};
const TOKEN = async () => Response.json({ access_token: "xai-access", refresh_token: "xai-refresh", expires_in: 3600 });

/** xAI as one login reaches it through `fetch`: the device grant answers `device`, and each token request takes the
 *  next answer of `polls`. Returns the fake clock's time of each token request since the device grant. */
function xaiService(device: { readonly [field: string]: unknown }, polls: (() => Promise<Response>)[] = []): readonly number[] {
  const tokenRequests: number[] = [];
  let startedAt: number | undefined;
  const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async (input: string | URL | Request) => {
    startedAt ??= Date.now();
    if (!String(input).endsWith("/token")) return Response.json(device);
    tokenRequests.push(Date.now() - startedAt);
    const next = polls.shift();
    if (next === undefined) throw new Error("the poll asked more often than the test answers");
    return next();
  }, { preconnect: fetch.preconnect }));
  onTestFinished(() => { fetchSpy.mockRestore(); });
  return tokenRequests;
}

/** A login that is cancelled when it shows the link, with what it showed and opened before it polls. */
function firstInstructions(device: { readonly [field: string]: unknown }) {
  xaiService(device);
  const abort = new AbortController();
  const opened: string[] = [];
  const shown: { readonly userCode?: string; readonly url: string }[] = [];
  const login = loginXai({
    openBrowser: async (url) => { opened.push(url); return true; },
    onUserCode: (instructions) => { shown.push(instructions); abort.abort(); },
    signal: abort.signal,
  });
  return { login, shown, opened };
}

describe("loginXai", () => {
  it("shows and opens the complete link without the separate code", async () => {
    const { login, shown, opened } = firstInstructions({ ...DEVICE, verification_uri: "https://accounts.x.ai/oauth2/device", interval: 7 });
    await expect(login).rejects.toThrow("Login cancelled");
    expect(shown).toEqual([{ url: COMPLETE_URL }]);
    expect(opened).toEqual([COMPLETE_URL]);
  });

  it.each([
    ["a zero interval", { ...DEVICE, interval: 0 }, "Invalid device code response fields"],
    ["an interval over one minute", { ...DEVICE, interval: 61 }, "Invalid device code response fields"],
    ["a device code lifetime over 30 minutes", { ...DEVICE, expires_in: 1_801 }, "Invalid device code response fields"],
    ["an oversized device code", { ...DEVICE, device_code: "x".repeat(8193) }, "Invalid device code response fields"],
    ["an untrusted verification URL", { ...DEVICE, verification_uri: "https://evil.example/activate" }, "Invalid device code response fields"],
    ["no complete verification URL", { ...DEVICE, verification_uri_complete: undefined }, "SuperGrok did not return a valid complete verification URL"],
    ["an untrusted complete verification URL", { ...DEVICE, verification_uri_complete: "https://evil.example/activate?user_code=x" }, "SuperGrok did not return a valid complete verification URL"],
    ["an oversized complete verification URL", { ...DEVICE, verification_uri_complete: `https://auth.x.ai/activate?user_code=${"x".repeat(2049)}` }, "SuperGrok did not return a valid complete verification URL"],
  ])("refuses a device grant with %s before it shows or opens anything", async (_case, device, message) => {
    const { login, shown, opened } = firstInstructions(device);
    await expect(login).rejects.toThrow(message);
    expect(shown).toEqual([]);
    expect(opened).toEqual([]);
  });

  it("waits the interval that the device grant states before it asks for the token", async () => {
    const tokenRequests = xaiService({ ...DEVICE, interval: 7 }, [TOKEN]);
    await onFakeClock(() => loginXai({}));

    expect(tokenRequests).toEqual([7_000]);
  });

  it("polls every 5 seconds when the device grant states no interval, polls again after a dropped connection or a server error, and reports each change of state once", async () => {
    const tokenRequests = xaiService(DEVICE, [
      async () => { throw new TypeError("fetch failed"); },
      async () => { throw new TypeError("fetch failed"); },
      async () => new Response("", { status: 503 }),
      async () => Response.json({ error: "slow_down" }, { status: 400 }),
      async () => Response.json({ error: "authorization_pending" }, { status: 400 }),
      TOKEN,
    ]);
    const progress: string[] = [];
    const tokens = await onFakeClock(() => loginXai({ onProgress: (message) => progress.push(message) }));

    expect(Redacted.value(tokens.accessToken)).toBe("xai-access");
    // Each wait is 5 seconds, and 10 seconds after the slow_down.
    expect(tokenRequests).toEqual([5_000, 10_000, 15_000, 20_000, 30_000, 40_000]);
    expect(progress).toEqual([
      "The connection to SuperGrok was interrupted. Still waiting for approval...",
      "SuperGrok asked Flywheel to check less often. Checking every 10 seconds...",
    ]);
  });
});
