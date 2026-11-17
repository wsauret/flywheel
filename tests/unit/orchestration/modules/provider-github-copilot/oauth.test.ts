import { describe, expect, onTestFinished, spyOn, test } from "bun:test";
import { Redacted } from "effect";
import { loginGitHubCopilot } from "../../../../../src/orchestration/modules/provider-github-copilot/oauth.js";
import { onFakeClock } from "../../../../helpers/fake-clock.js";

const DEVICE = {
  device_code: "dc-123",
  user_code: "ABCD-1234",
  verification_uri: "https://github.com/login/device",
  interval: 7,
  expires_in: 900,
};
const GITHUB_TOKEN = "github-access";

/** One request of a login, as GitHub and Copilot receive it. `atMs` is the fake clock's time since the device code
 *  request. */
interface SeenRequest {
  readonly method: string;
  readonly url: string;
  readonly atMs: number;
  readonly form: URLSearchParams;
  readonly headers: Headers;
}

interface ServiceAnswers {
  readonly device?: { readonly [field: string]: unknown };
  /** The answers of the token endpoint, in order. The last one repeats. */
  readonly polls?: readonly { readonly [field: string]: unknown }[];
  readonly identity?: () => Response;
  readonly listing?: () => Response;
}

/** GitHub and Copilot as one login reaches them through `fetch`. Returns every request that the login sends. */
function copilotService(answers: ServiceAnswers = {}): readonly SeenRequest[] {
  const requests: SeenRequest[] = [];
  const polls = [...(answers.polls ?? [{ access_token: GITHUB_TOKEN }])];
  let startedAt: number | undefined;
  const answer = (path: string): Response => {
    if (path === "/login/device/code") return Response.json(answers.device ?? DEVICE);
    if (path === "/login/oauth/access_token") return Response.json(polls.length > 1 ? polls.shift() : polls[0]);
    if (path === "/copilot_internal/v2/token") return Response.json({ token: "copilot-token", expires_at: Math.floor(Date.now() / 1000) + 3600 });
    if (path === "/user" || path === "/api/v3/user") return answers.identity?.() ?? Response.json({ login: "octocat" });
    if (path === "/models") return answers.listing?.() ?? Response.json({ data: [] });
    if (path.endsWith("/policy")) return new Response(null, { status: 204 });
    throw new Error(`The login sent a request that no service answers: ${path}`);
  };
  const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    startedAt ??= Date.now();
    requests.push({
      method: request.method, url: request.url, atMs: Date.now() - startedAt,
      form: new URLSearchParams(await request.text()), headers: request.headers,
    });
    return answer(new URL(request.url).pathname);
  }, { preconnect: fetch.preconnect }));
  onTestFinished(() => { fetchSpy.mockRestore(); });
  return requests;
}

const tokenRequests = (requests: readonly SeenRequest[]) => requests.filter(({ url }) => url.endsWith("/login/oauth/access_token"));
const copilotRequests = (requests: readonly SeenRequest[]) => requests
  .filter(({ url }) => url.startsWith("https://api.individual.githubcopilot.com/"))
  .map(({ method, url }) => ({ method, url }));

describe("the GitHub Copilot device login", () => {
  test("A device code response leads to one token request per interval", async () => {
    const requests = copilotService({ polls: [{ error: "authorization_pending" }, { error: "authorization_pending" }, { access_token: GITHUB_TOKEN }] });
    const shown: { readonly userCode?: string; readonly url: string }[] = [];
    const tokens = await onFakeClock(() => loginGitHubCopilot({ onUserCode: (instructions) => { shown.push(instructions); } }));

    expect(shown).toEqual([{ userCode: "ABCD-1234", url: "https://github.com/login/device" }]);
    // The first poll waits the device code's interval of 7 seconds with a margin of 20 percent.
    expect(tokenRequests(requests).map(({ atMs, form }) => [atMs, form.get("device_code")])).toEqual([[8_400, "dc-123"], [16_800, "dc-123"], [25_200, "dc-123"]]);
    expect(Redacted.value(tokens.githubToken)).toBe(GITHUB_TOKEN);
    expect(Redacted.value(tokens.copilotToken)).toBe("copilot-token");
  });

  test("polls every 5 seconds when the device code response states no interval, as RFC 8628 requires", async () => {
    const { interval: _omitted, ...withoutInterval } = DEVICE;
    const requests = copilotService({ device: withoutInterval, polls: [{ error: "authorization_pending" }, { access_token: GITHUB_TOKEN }] });
    await onFakeClock(() => loginGitHubCopilot({}));

    expect(tokenRequests(requests).map(({ atMs }) => atMs)).toEqual([6_000, 12_000]);
  });

  test.each([
    ["a non-numeric interval", { ...DEVICE, interval: "10" }],
    ["a zero interval", { ...DEVICE, interval: 0 }],
    ["an interval over one minute", { ...DEVICE, interval: 61 }],
    ["a device code lifetime over 30 minutes", { ...DEVICE, expires_in: 1_801 }],
    ["no device code", { user_code: DEVICE.user_code, verification_uri: DEVICE.verification_uri, interval: DEVICE.interval, expires_in: DEVICE.expires_in }],
  ])("refuses a device code response with %s before it shows a code or polls", async (_case, device) => {
    const requests = copilotService({ device });
    const shown: unknown[] = [];

    await expect(loginGitHubCopilot({ onUserCode: (instructions) => { shown.push(instructions); } })).rejects.toThrow("Invalid device code response fields");
    expect(shown).toEqual([]);
    expect(requests.map(({ url }) => url)).toEqual(["https://github.com/login/device/code"]);
  });

  test("names the account by the public whoami endpoint, which it asks with the GitHub token and the required GitHub headers", async () => {
    const requests = copilotService();
    const tokens = await onFakeClock(() => loginGitHubCopilot({}));

    expect(tokens.identity).toBe("octocat");
    const [whoami] = requests.filter(({ url }) => url === "https://api.github.com/user");
    expect(whoami?.headers.get("authorization")).toBe(`Bearer ${GITHUB_TOKEN}`);
    expect(whoami?.headers.get("accept")).toBe("application/vnd.github+json");
  });

  test("uses the enterprise endpoints of the domain that the person names, and completes without a name when whoami fails", async () => {
    const requests = copilotService({
      device: { ...DEVICE, verification_uri: "https://company.ghe.com/login/device" },
      identity: () => new Response("unavailable", { status: 503 }),
    });
    const tokens = await onFakeClock(() => loginGitHubCopilot({ onPrompt: async () => "company.ghe.com" }));

    expect(requests.map(({ url }) => url).slice(0, 4)).toEqual([
      "https://company.ghe.com/login/device/code",
      "https://company.ghe.com/login/oauth/access_token",
      "https://api.company.ghe.com/copilot_internal/v2/token",
      "https://company.ghe.com/api/v3/user",
    ]);
    expect(tokens.enterpriseDomain).toBe("company.ghe.com");
    expect(tokens.identity).toBeUndefined();
  });

  test("ends cancelled when the person cancels while it asks whoami, instead of completing without a name", async () => {
    const controller = new AbortController();
    copilotService({
      identity: () => {
        controller.abort();
        throw new DOMException("The operation was aborted.", "AbortError");
      },
    });

    await expect(onFakeClock(() => loginGitHubCopilot({ signal: controller.signal }))).rejects.toThrow("Login cancelled");
  });

  test("posts the policy only for the exact ids of a successful account listing", async () => {
    const requests = copilotService({ listing: () => Response.json({ data: [{ id: "Claude.Exact-Wire" }, { id: "gpt.exact-wire" }] }) });
    await onFakeClock(() => loginGitHubCopilot({}));

    expect(copilotRequests(requests)).toEqual([
      { url: "https://api.individual.githubcopilot.com/models", method: "GET" },
      { url: "https://api.individual.githubcopilot.com/models/Claude.Exact-Wire/policy", method: "POST" },
      { url: "https://api.individual.githubcopilot.com/models/gpt.exact-wire/policy", method: "POST" },
    ]);
  });

  test.each([
    ["empty", () => Response.json({ data: [] })],
    ["malformed", () => Response.json({ data: [{ id: 42 }] })],
    ["unavailable", () => new Response(null, { status: 503 })],
  ])("posts no policy when the listing is %s", async (_case, listing) => {
    const requests = copilotService({ listing });
    await onFakeClock(() => loginGitHubCopilot({}));

    expect(copilotRequests(requests)).toEqual([{ url: "https://api.individual.githubcopilot.com/models", method: "GET" }]);
  });
});
