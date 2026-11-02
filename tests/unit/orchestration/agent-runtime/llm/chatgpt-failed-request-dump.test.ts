import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Redacted } from "effect";
import { Log } from "../../../../../src/infra/log.js";
import * as windowsAcl from "../../../../../src/infra/windows-private-directory-acl.js";
import { createChatGPTClient } from "../../../../../src/orchestration/agent-runtime/llm/chatgpt-client.js";
import { dumpFailedChatGptRequest } from "../../../../../src/orchestration/agent-runtime/llm/openai-chatgpt.js";
import { createProviderAvailability } from "../../../../../src/orchestration/agent-runtime/llm/provider-availability.js";
import { CHATGPT_RATE_LIMIT_HEADER_PREFIX } from "../../../../../src/infra/auth/openai-auth-types.js";

const DUMP_RELATIVE_DIR = join(".flywheel", "log", "chatgpt-adapter-failures");
const CONNECTION = { authDir: join(tmpdir(), "flywheel-chatgpt-dump-auth"), oauthPersistence: "memory-only" as const };

function chatGptAuth() {
  return {
    kind: "chatgpt" as const,
    accessToken: Redacted.make("access-token"),
    refreshToken: Redacted.make("refresh-token"),
    expiresAtMs: Date.now() + 3_600_000,
    accountId: "account-1",
  };
}

/** A 4xx from the backend, with the prompt body the SDK sent. */
const failingTransport = async (): Promise<Response> =>
  new Response(JSON.stringify({ error: { message: "bad request", code: "invalid_request" } }), { status: 400 });

async function request(projectRoot: string, input = "hello"): Promise<void> {
  const client = createChatGPTClient({ auth: chatGptAuth(), projectRoot, transportFetch: failingTransport, ...CONNECTION });
  await client.responses.create({ model: "gpt-5.4", input }).catch(() => {});
}

describe("ChatGPT failed-request dump", () => {
  let projectRoot: string;
  const previousOptIn = process.env.FLYWHEEL_DUMP_FAILED_REQUESTS;

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), "chatgpt-dump-"));
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
    if (previousOptIn === undefined) delete process.env.FLYWHEEL_DUMP_FAILED_REQUESTS;
    else process.env.FLYWHEEL_DUMP_FAILED_REQUESTS = previousOptIn;
  });

  it("writes the dump under the project root the client was built with", async () => {
    process.env.FLYWHEEL_DUMP_FAILED_REQUESTS = "1";
    const apply = spyOn(windowsAcl, "applyWindowsPrivateDirectoryAcl").mockImplementation(() => {});
    const verify = spyOn(windowsAcl, "windowsDirectoryIsOwnerOnly").mockReturnValue(true);
    let sentBody: unknown;
    const client = createChatGPTClient({
      auth: chatGptAuth(), projectRoot, ...CONNECTION,
      transportFetch: async (_url, init) => {
        sentBody = JSON.parse(String(init?.body));
        return failingTransport();
      },
    });
    try {
      await client.responses.create({ model: "gpt-5.4", input: "hello" }).catch(() => {});
      const dumpDir = join(projectRoot, DUMP_RELATIVE_DIR);
      const dumps = readdirSync(dumpDir);
      expect(dumps).toHaveLength(1);
      const [dumpName] = dumps;
      if (!dumpName) throw new Error("expected failed request dump");
      const dumped: unknown = JSON.parse(readFileSync(join(dumpDir, dumpName), "utf8"));
      expect(dumped).toEqual({ status: 400, request: sentBody, response: { error: { message: "bad request", code: "invalid_request" } } });
      if (process.platform === "win32") {
        expect(apply).toHaveBeenCalledWith(dumpDir);
        expect(verify).toHaveBeenCalledWith(dumpDir);
      }
    } finally {
      apply.mockRestore();
      verify.mockRestore();
    }
  });

  it.each([true, false])("verifies an existing Windows dump directory before writing (private: %s)", (privateDirectory) => {
    process.env.FLYWHEEL_DUMP_FAILED_REQUESTS = "1";
    const dumpDir = join(projectRoot, DUMP_RELATIVE_DIR);
    mkdirSync(dumpDir, { recursive: true });
    const calls: string[] = [];
    const apply = spyOn(windowsAcl, "applyWindowsPrivateDirectoryAcl").mockImplementation((directory) => {
      expect(directory).toBe(dumpDir);
      expect(readdirSync(directory)).toEqual([]);
      calls.push("apply");
    });
    const verify = spyOn(windowsAcl, "windowsDirectoryIsOwnerOnly").mockImplementation((directory) => {
      expect(directory).toBe(dumpDir);
      expect(calls).toEqual(["apply"]);
      expect(readdirSync(directory)).toEqual([]);
      calls.push("verify");
      return privateDirectory;
    });
    const warning = spyOn(Log.create({ service: "llm-openai-chatgpt" }), "warn").mockImplementation(() => {});
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    try {
      Object.defineProperty(process, "platform", { value: "win32" });
      dumpFailedChatGptRequest(projectRoot, 400, { input: "private-marker" }, { error: "rejected" });
    } finally {
      Object.defineProperty(process, "platform", platform);
      apply.mockRestore();
      verify.mockRestore();
    }
    try {
      expect(calls).toEqual(["apply", "verify"]);
      expect(readdirSync(dumpDir)).toHaveLength(privateDirectory ? 1 : 0);
      if (privateDirectory) expect(warning).not.toHaveBeenCalled();
      else expect(warning).toHaveBeenCalledWith("failed to dump ChatGPT backend request", expect.objectContaining({
        error: "ChatGPT dump directory is not owner-only",
      }));
    } finally {
      warning.mockRestore();
    }
  });

  it("writes nothing when the developer has not opted in", async () => {
    delete process.env.FLYWHEEL_DUMP_FAILED_REQUESTS;
    const warning = spyOn(Log.create({ service: "llm-openai-chatgpt" }), "warn").mockImplementation(() => {});
    try {
      await request(projectRoot, "private-http-marker");
      expect(existsSync(join(projectRoot, DUMP_RELATIVE_DIR))).toBe(false);
      const diagnostic = warning.mock.calls.find(([message]) => message === "ChatGPT backend request rejected");
      expect(diagnostic?.[1]).toMatchObject({ transport: "http", requestFields: { input: "string" } });
      expect(JSON.stringify(diagnostic)).not.toContain("private-http-marker");
    } finally {
      warning.mockRestore();
    }
  });

  it("defers exhausted headers on terminal quota responses to the stream classifier", async () => {
    const candidate = { kind: "subscription", providerId: "chatgpt", instanceId: "account-1", spendMode: "included" } as const;
    const availability = createProviderAvailability().forCandidates("default", [candidate]);
    const resetsAtSeconds = Math.floor(Date.now() / 1000) + 3_600;
    const transportFetch = async (): Promise<Response> => new Response(JSON.stringify({
      error: { code: "usage_limit_reached", message: "limit reached", resets_at: resetsAtSeconds },
    }), {
      status: 429,
      headers: {
        [`${CHATGPT_RATE_LIMIT_HEADER_PREFIX}-primary-used-percent`]: "100",
        [`${CHATGPT_RATE_LIMIT_HEADER_PREFIX}-primary-reset-at`]: String(resetsAtSeconds),
      },
    });
    const client = createChatGPTClient({ auth: chatGptAuth(), transportFetch, availability, candidate, ...CONNECTION });

    await client.responses.create({ model: "gpt-5.4", input: "hello" }).catch(() => {});

    expect(availability.chatGptStanding(candidate)).toEqual({ kind: "live" });
  });
});
