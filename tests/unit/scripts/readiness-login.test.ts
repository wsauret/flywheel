import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { inHomeLogin, parseReleaseLoginStatus, releaseLoginPlan, releaseLoginStatus } from "../../../scripts/readiness-login.js";
import { AuthProfileStore } from "../../../src/infra/auth/auth-profile-store.js";
import { authDir } from "../../../src/infra/paths.js";
import type { TokenProbe } from "../../../src/orchestration/modules/provider-claude-agent-sdk/login-token.js";
import { LOGIN_ACCOUNTS_DIRECTORY } from "../../../src/orchestration/modules/provider-claude-agent-sdk/names.js";
import { AuthProfileManager } from "../../../src/orchestration/auth/auth-profile-manager.js";
import { temporaryDirectories } from "../../helpers/directories.js";

const temporary = temporaryDirectories();
const ROOT = "/repo";
/** The auth profile that the live auth profile setting names in these tests. */
const PROFILE = "Live";

/** A home whose `PROFILE` profile holds one Claude login folder, with the engine's token file when `token` says so,
 *  and with the cached flag that lets the engine keep the token in Windows Credential Manager when `credentialManager`
 *  says so. */
async function homeWithLogin(login: { readonly token: boolean; readonly credentialManager?: boolean } | undefined): Promise<string> {
  const home = temporary("readiness-login-");
  const userDataRoot = join(home, ".flywheel");
  const id = await new AuthProfileManager({ userDataRoot, projectRoot: home, env: {} }).create(PROFILE);
  if (login === undefined) return home;
  const configDir = join(authDir(userDataRoot, id), LOGIN_ACCOUNTS_DIRECTORY, "login");
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, ".claude.json"), JSON.stringify({
    oauthAccount: { accountUuid: "account-1", emailAddress: "person@example.com" },
    ...(login.credentialManager === true ? { cachedGrowthBookFeatures: { tengu_windows_credman: true } } : {}),
  }));
  if (login.token) writeFileSync(join(configDir, ".credentials.json"), "{}");
  return home;
}

const probe = (platform: NodeJS.Platform): TokenProbe => ({ platform, account: { user: "person", home: "/scratch" }, run: undefined, keychainUnlocked: () => undefined });

describe("the release login status", () => {
  test("is present when a login of the live profile has its token file", async () => {
    expect(await releaseLoginStatus(await homeWithLogin({ token: true }), ROOT, probe("linux"), PROFILE)).toEqual({ kind: "present", store: "file" });
  });

  test("is absent when the home has no login of the live profile, or a login whose token is gone", async () => {
    expect(await releaseLoginStatus(temporary("readiness-login-empty-"), ROOT, probe("linux"), PROFILE)).toEqual({ kind: "absent" });
    expect(await releaseLoginStatus(await homeWithLogin(undefined), ROOT, probe("win32"), PROFILE)).toEqual({ kind: "absent" });
    expect(await releaseLoginStatus(await homeWithLogin({ token: false }), ROOT, probe("linux"), PROFILE)).toEqual({ kind: "absent" });
  });

  test("is unchecked when the engine can keep the token in a store that Flywheel does not search", async () => {
    expect(await releaseLoginStatus(await homeWithLogin({ token: false, credentialManager: true }), ROOT, probe("win32"), PROFILE)).toEqual({
      kind: "unchecked", reason: "the engine can keep it in Windows Credential Manager, which Flywheel does not search",
    });
  });

  test("reads back each status line that the status mode prints, and nothing else", () => {
    expect(parseReleaseLoginStatus("present file\n")).toEqual({ kind: "present", store: "file" });
    expect(parseReleaseLoginStatus("present keychain\n")).toEqual({ kind: "present", store: "keychain" });
    expect(parseReleaseLoginStatus("absent\n")).toEqual({ kind: "absent" });
    expect(parseReleaseLoginStatus("unchecked the login keychain is locked\n")).toEqual({ kind: "unchecked", reason: "the login keychain is locked" });
    expect(parseReleaseLoginStatus("error: no such file\n")).toBeUndefined();
    expect(parseReleaseLoginStatus("present vault\n")).toBeUndefined();
  });
});

describe("the release login helper", () => {
  const context = { candidate: "/scratch/login/candidate.tar", folder: "flywheel-readiness-login-1", bunVersion: "1.3.14", dockerPlatform: "linux/arm64", liveAuthProfile: "Owner's" };
  const archive = { command: ["git", "archive", "--format=tar", "--output=/scratch/login/candidate.tar", "HEAD"], interactive: false };

  test("logs in on Windows over SSH at the named host in the persistent folder, from a fresh install of the candidate in a temporary folder, in the live profile", () => {
    const remote = String.raw`$env:USERPROFILE\AppData\Local\Temp\flywheel-readiness-login-1`;
    expect(releaseLoginPlan({ kind: "windows", sshHost: "windows-host" }, context)).toEqual({
      steps: [
        archive,
        { command: ["ssh", "windows-host", `New-Item -ItemType Directory -Force -Path "${remote}" | Out-Null`], interactive: false },
        { command: ["scp", "-q", "/scratch/login/candidate.tar", "windows-host:AppData/Local/Temp/flywheel-readiness-login-1/candidate.tar"], interactive: false },
        {
          command: ["ssh", "-t", "windows-host", [
            `Set-Location -LiteralPath "${remote}"`,
            String.raw`& "$env:SystemRoot\System32\tar.exe" -xf candidate.tar`,
            "if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }",
            "bun install --frozen-lockfile",
            "if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }",
            "$env:FLYWHEEL_LIVE_AUTH_PROFILE = 'Owner''s'",
            String.raw`bun run scripts/readiness-login.ts --in-home "$env:LOCALAPPDATA\FlywheelReadiness"`,
            "exit $LASTEXITCODE",
          ].join("; ")],
          interactive: true,
        },
      ],
      cleanup: [{ command: ["ssh", "windows-host", `Remove-Item -Recurse -Force -LiteralPath "${remote}"`], interactive: false }],
    });
  });

  test("logs in on Linux in a container whose home is the named volume, from a fresh install of the candidate, in the live profile", () => {
    expect(releaseLoginPlan({ kind: "linux" }, context)).toEqual({
      steps: [
        archive,
        {
          command: [
            "docker", "run", "--rm", "-it", "--platform=linux/arm64",
            "--mount", "type=volume,source=flywheel-readiness-claude,target=/home/readiness",
            "--mount", "type=bind,source=/scratch/login/candidate.tar,target=/input/candidate.tar,readonly",
            "--env", "HOME=/home/readiness", "--env", "BUN_INSTALL_CACHE_DIR=/tmp/bun-install-cache",
            "--env", "FLYWHEEL_LIVE_AUTH_PROFILE=Owner's",
            "oven/bun:1.3.14", "sh", "-c",
            "mkdir /work && tar -xf /input/candidate.tar -C /work && cd /work && bun install --frozen-lockfile && bun run scripts/readiness-login.ts --in-home /home/readiness",
          ],
          interactive: true,
        },
      ],
      cleanup: [],
    });
  });

  test("runs the CLI's own Claude login in the home, after it adds the live profile that the live tier reads", async () => {
    const home = temporary("readiness-login-home-");
    const login = await inHomeLogin(home, "/bun", ROOT, PROFILE);
    expect(login).toEqual({
      command: ["/bun", "--conditions=browser", join(ROOT, "scripts", "dev.ts"), "auth", "login", "--claude-agent-sdk"],
      env: { HOME: home, FLYWHEEL_AUTH_PROFILE: PROFILE },
    });
    const stored = () => new AuthProfileStore(join(home, ".flywheel")).inspect().profiles.map(({ displayName }) => displayName);
    expect(stored()).toEqual([PROFILE]);
    // A second login keeps the profile that the first one added.
    await inHomeLogin(home, "/bun", ROOT, PROFILE);
    expect(stored()).toEqual([PROFILE]);
  });

  test("logs in to a profile that the home names the live profile in another case, as the live tier finds it, and adds none", async () => {
    const home = temporary("readiness-login-home-");
    await new AuthProfileManager({ userDataRoot: join(home, ".flywheel"), projectRoot: home, env: {} }).create("live");
    const login = await inHomeLogin(home, "/bun", ROOT, PROFILE);
    expect(login.env).toEqual({ HOME: home, FLYWHEEL_AUTH_PROFILE: PROFILE });
    expect(new AuthProfileStore(join(home, ".flywheel")).inspect().profiles.map(({ displayName }) => displayName)).toEqual(["live"]);
  });
});
