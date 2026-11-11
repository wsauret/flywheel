import { describe, expect, test } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { quotaPreflightLines, quotaRefusal, readQuotaPreflight } from "../../../bench/harbor/quota-preflight.js";
import { AuthProfileStore } from "../../../src/infra/auth/auth-profile-store.js";
import type { AccessProviderCandidate } from "../../../src/infra/llm/access-provider.js";
import { AVAILABILITY_PROTOCOL_VERSION, createAvailabilityAuthority } from "../../../src/infra/llm/availability-store.js";
import { authDir, availabilityAuthorityDbFile } from "../../../src/infra/paths.js";
import { createProviderAvailability } from "../../../src/orchestration/agent-runtime/llm/provider-availability.js";
import { temporaryDirectories } from "../../helpers/directories.js";

const NOW = Date.parse("2026-11-11T01:00:00.000Z");
const RESET = Date.parse("2026-11-13T14:00:00.000Z");
const account = (id: string): AccessProviderCandidate => ({ kind: "subscription", providerId: "chatgpt", instanceId: id, spendMode: "included" });

describe("Harbor quota preflight", () => {
  const temporaryDirectory = temporaryDirectories();

  /** A data directory whose profile Personal holds the ChatGPT accounts `ids`, each with the identity `<id>@example.com`,
   *  and an OpenAI API key. */
  async function profileWith(ids: readonly string[]) {
    const userDataRoot = join(temporaryDirectory("harbor-quota-preflight-"), ".flywheel");
    (await new AuthProfileStore(userDataRoot).create("personal", "Personal")).close();
    const directory = authDir(userDataRoot, "personal");
    writeFileSync(join(directory, "auth.json"), JSON.stringify({ chatgpt: ids.map((id) => ({ id, identity: `${id}@example.com`, credential: { type: "oauth", access: "access", refresh: "refresh", expires: NOW + 3_600_000 } })), openai_api: { type: "api_key", key: "sk-test" } }), { mode: 0o600 });
    const read = (credentialProviders: readonly string[], tokenKeychainItems: readonly string[] = []) =>
      readQuotaPreflight({ authProfile: "Personal", credentialProviders, tokenKeychainItems, projectRoot: userDataRoot, nowMs: NOW, userDataRoot });
    return { userDataRoot, read };
  }

  test("an account is spent when the availability authority states it out of quota after now, a run is refused only when every account is spent, and a missing authority is not created", async () => {
    const { userDataRoot, read } = await profileWith(["one"]);
    const dbFile = availabilityAuthorityDbFile(userDataRoot, AVAILABILITY_PROTOCOL_VERSION);
    expect((await read(["chatgpt"])).accounts).toEqual([{ providerId: "chatgpt", account: "one@example.com", kind: "open" }]);
    expect(existsSync(dbFile)).toBe(false);

    const owner = createProviderAvailability({ authority: createAvailabilityAuthority({ dbFile }), now: () => NOW });
    owner.forCandidates("personal", [account("one")]).observeChatGptQuotaExhausted(account("one"), RESET / 1000);
    await owner.dispose();

    const partly = await read(["chatgpt", "openai_api"]);
    expect(partly.accounts).toEqual([
      { providerId: "chatgpt", account: "one@example.com", kind: "spent", untilMs: RESET },
      { providerId: "openai_api", account: "stored credential", kind: "open" },
    ]);
    expect(quotaRefusal(partly)).toBeUndefined();

    const spent = await read(["chatgpt"]);
    expect(quotaRefusal(spent)).toBe("quota preflight refused the run: every account of the auth profile Personal that the arm uses is out of quota, the first until 2026-11-13T14:00:00.000Z; each trial would only wait for that reset until Harbor's agent timeout");
  });

  test("a login token is reported as not checked and keeps the run from being refused, and a missing profile is refused by name", async () => {
    const { read } = await profileWith([]);
    const preflight = await read(["claude_agent_sdk"], ["item-a", "item-b"]);
    expect(preflight.accounts.map((entry) => [entry.account, entry.kind])).toEqual([["token of keychain item item-a", "unchecked"], ["token of keychain item item-b", "unchecked"]]);
    expect(quotaPreflightLines(preflight)[0]).toBe("quota preflight: claude_agent_sdk token of keychain item item-a: not checked, because a login token is its own account of the trial profile, which no host store has observed");
    expect(quotaRefusal(preflight)).toBeUndefined();
    const { userDataRoot } = await profileWith([]);
    await expect(readQuotaPreflight({ authProfile: "Missing", credentialProviders: ["chatgpt"], tokenKeychainItems: [], projectRoot: userDataRoot, nowMs: NOW, userDataRoot })).rejects.toThrow("the auth profile Missing does not exist");
  });
});
