import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { captureSubscriptionCredentials } from "../../../../../../src/infra/auth/auth-context.js";
import { AuthProfileStore } from "../../../../../../src/infra/auth/auth-profile-store.js";
import { authDir } from "../../../../../../src/infra/paths.js";
import { createClaudeAgentSdkModule } from "../../../../../../src/orchestration/modules/provider-claude-agent-sdk/module.js";
import { CLAUDE_SDK_PROFILE, setupClaudeSdkHome, setupClaudeSdkProfile } from "../../../../../../src/orchestration/modules/development/claude-sdk/setup.js";
import { temporaryDirectories } from "../../../../../helpers/directories.js";
import { roleCapture } from "../../../../../helpers/role-capture.js";
import { resolveSessionRoles } from "../../../../../../src/orchestration/config/session-role-resolver.js";
import { LOGIN_ACCOUNTS_DIRECTORY } from "../../../../../../src/orchestration/modules/provider-claude-agent-sdk/names.js";

const temporaryDirectory = temporaryDirectories();
const classifySlot = () => "subscription" as const;

/** A scratch OS account whose own `claude` is logged in, and the Agent SDK provider that runs on that OS
 *  account. No profile uses that login. */
function loggedInAccount(root: string) {
  const account = { home: join(root, "os-home"), user: "tester" };
  mkdirSync(join(account.home, ".claude"), { recursive: true });
  writeFileSync(join(account.home, ".claude.json"), JSON.stringify({ oauthAccount: { accountUuid: "uuid-person", emailAddress: "person@example.com" } }));
  const [provider] = createClaudeAgentSdkModule({ account: () => account }).contributions;
  return { account, provider: provider.value.definition, accounts: provider.value.definition.auth.accounts };
}

describe("the claude-sdk setup", () => {
  test("makes a profile that stores no credential and has no Claude account until a login of its own, which it then reports once", async () => {
    const root = temporaryDirectory("claude-sdk-setup-");
    const userDataRoot = join(root, ".flywheel");
    const { provider, accounts } = loggedInAccount(root);

    const first = await setupClaudeSdkHome({ userDataRoot, accounts });
    // The CLI writes this after the login button of the profile.
    const configDir = join(authDir(userDataRoot, CLAUDE_SDK_PROFILE), LOGIN_ACCOUNTS_DIRECTORY, "a");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, ".claude.json"), JSON.stringify({ oauthAccount: { accountUuid: "uuid-person", emailAddress: "person@example.com" } }));
    const second = await setupClaudeSdkHome({ userDataRoot, accounts });

    expect(existsSync(join(userDataRoot, "flywheel.toml"))).toBe(false);
    const roles = await resolveSessionRoles({ defaults: {}, overrides: {} }, roleCapture(["claude-opus-5.5", "claude-haiku-5.5", "claude-fable-5.2"]), userDataRoot);
    expect(await new AuthProfileStore(userDataRoot).readStickyProfile()).toBe(CLAUDE_SDK_PROFILE);
    expect(first).toEqual({ authDirectory: authDir(userDataRoot, CLAUDE_SDK_PROFILE), accounts: [] });
    expect(second.accounts).toEqual([{ accountId: "uuid-person", identity: "person@example.com", configDir }]);
    expect(existsSync(join(authDir(userDataRoot, CLAUDE_SDK_PROFILE), "auth.json"))).toBe(false);
    const captured = captureSubscriptionCredentials([provider], { kind: "persisted", authDir: authDir(userDataRoot, CLAUDE_SDK_PROFILE), classifySlot, report: false });
    expect(captured.get("claude_agent_sdk")).toEqual([{ instanceId: "uuid-person", identity: "person@example.com", lineageId: "uuid-person", credential: { type: "external", configDir } }]);
    expect(roles.get("chat")).toMatchObject({ model: "claude-opus-5.5", effort: "medium" });
    expect(roles.get("advisor")).toMatchObject({ model: "claude-fable-5.2", effort: "high" });
    expect(roles.get("title-generation")).toMatchObject({ model: "claude-haiku-5.5", effort: "low" });
  });

  test("stores an explicit model only in its profile and skips an unreachable setting as a whole", async () => {
    const root = temporaryDirectory("claude-sdk-model-");
    const userDataRoot = join(root, ".flywheel");
    await setupClaudeSdkHome({ userDataRoot, accounts: () => [], model: "lost-model" });
    const config = Bun.TOML.parse(readFileSync(join(userDataRoot, "flywheel.toml"), "utf8"));
    expect(config).toMatchObject({ profiles: { [CLAUDE_SDK_PROFILE]: { roles: { chat: { model: "lost-model" }, "title-generation": { model: "lost-model" } } } } });
    const roles = await resolveSessionRoles({ defaults: {}, overrides: {} }, roleCapture(["claude-opus-5.5", "claude-haiku-5.5"], { chat: { model: "lost-model" }, "title-generation": { model: "lost-model" } }), userDataRoot);
    expect(roles.get("chat")).toMatchObject({ model: "claude-opus-5.5", effort: "medium" });
    expect(roles.get("title-generation")).toMatchObject({ model: "claude-haiku-5.5", effort: "low" });
    expect(config).not.toHaveProperty("roles");
  });

  test("adds only the profile to an account that already exists: its settings, active profile, and other profiles stay as they were", async () => {
    const root = temporaryDirectory("claude-sdk-account-");
    const userDataRoot = join(root, ".flywheel");
    const { accounts } = loggedInAccount(root);
    const settings = 'proactive_compaction_threshold = 100000\n\n[profiles.Personal.roles.chat]\nmodel = "gpt-6-luna"\neffort = "high"\n';
    mkdirSync(userDataRoot, { recursive: true });
    writeFileSync(join(userDataRoot, "flywheel.toml"), settings);
    const store = new AuthProfileStore(userDataRoot);
    (await store.create("Personal")).close();
    await store.writeStickyProfile("Personal");
    const personal = authDir(userDataRoot, "Personal");
    const personalFiles = readdirSync(personal).sort();

    await setupClaudeSdkProfile({ userDataRoot, accounts });
    const result = await setupClaudeSdkProfile({ userDataRoot, accounts });

    expect(readFileSync(join(userDataRoot, "flywheel.toml"), "utf8")).toBe(settings);
    expect(await store.readStickyProfile()).toBe("Personal");
    expect(readdirSync(personal).sort()).toEqual(personalFiles);
    // The account's own `claude` login is no login of the profile.
    expect(result.accounts).toEqual([]);
    expect((await store.list()).map(({ id }) => id).toSorted()).toEqual(["Personal", CLAUDE_SDK_PROFILE]);
  });

  test("refuses to prepare a whole home that already holds an account, and leaves the account as it was", async () => {
    const root = temporaryDirectory("claude-sdk-account-");
    const userDataRoot = join(root, ".flywheel");
    const settings = 'proactive_compaction_threshold = 100000\n';
    mkdirSync(userDataRoot, { recursive: true });
    writeFileSync(join(userDataRoot, "flywheel.toml"), settings);
    const store = new AuthProfileStore(userDataRoot);
    (await store.create("Personal")).close();
    await store.writeStickyProfile("Personal");

    await expect(setupClaudeSdkHome({ userDataRoot, accounts: loggedInAccount(root).accounts })).rejects.toThrow("--profile-only");

    expect(readFileSync(join(userDataRoot, "flywheel.toml"), "utf8")).toBe(settings);
    expect(await store.readStickyProfile()).toBe("Personal");
    expect((await store.list()).map(({ id }) => id)).toEqual(["Personal"]);
  });

  test("refuses to add only the profile to a home that holds no account, so a mistyped home creates nothing", async () => {
    const root = temporaryDirectory("claude-sdk-account-");
    const userDataRoot = join(root, ".flywheel");

    await expect(setupClaudeSdkProfile({ userDataRoot, accounts: loggedInAccount(root).accounts })).rejects.toThrow("holds no Flywheel account");

    expect(existsSync(userDataRoot)).toBe(false);
  });

  test("treats a home that holds any Flywheel data as an account, even with no settings file or auth store", async () => {
    const root = temporaryDirectory("claude-sdk-account-");
    const userDataRoot = join(root, ".flywheel");
    mkdirSync(join(userDataRoot, "log"), { recursive: true });

    // A whole-home setup would set the active profile of a home that a person already used.
    const { accounts } = loggedInAccount(root);
    await expect(setupClaudeSdkHome({ userDataRoot, accounts })).rejects.toThrow("--profile-only");
    expect(existsSync(join(userDataRoot, "flywheel.toml"))).toBe(false);
    await setupClaudeSdkProfile({ userDataRoot, accounts });
    expect((await new AuthProfileStore(userDataRoot).list()).map(({ id }) => id)).toEqual([CLAUDE_SDK_PROFILE]);
    expect(await new AuthProfileStore(userDataRoot).readStickyProfile()).toBeUndefined();
  });
});
