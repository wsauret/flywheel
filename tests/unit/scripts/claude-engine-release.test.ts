import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { claudeEngineFreshness, engineBump, liveClaudeAccounts, type RegistryFetch } from "../../../scripts/claude-engine-release.js";
import { AuthProfileManager } from "../../../src/orchestration/auth/auth-profile-manager.js";
import { AuthProfileStore } from "../../../src/infra/auth/auth-profile-store.js";
import { LOGIN_ACCOUNTS_DIRECTORY } from "../../../src/orchestration/modules/provider-claude-agent-sdk/names.js";
import { temporaryDirectories } from "../../helpers/directories.js";

const SDK = "@anthropic-ai/claude-agent-sdk";
const DAY_MS = 86_400_000;
const NOW = Date.parse("2026-11-20T12:00:00Z");

/** A lockfile that pins the SDK at `version`. */
const lock = (version: string) => `${JSON.stringify({ lockfileVersion: 1, packages: { [SDK]: [`${SDK}@${version}`, "", {}, "sha512-sdk"] } }, null, 2).slice(0, -2)},\n}\n`;

/** A registry that published each version `daysAgo` days before `NOW`, with an engine of the same patch. */
function registry(releases: ReadonlyArray<readonly [version: string, daysAgo: number]>, latest = releases.at(-1)?.[0]): RegistryFetch {
  const document = {
    "dist-tags": { latest },
    versions: Object.fromEntries(releases.map(([version]) => [version, { version, claudeCodeVersion: `2.1.${version.split(".")[2]}` }])),
    time: Object.fromEntries(releases.map(([version, daysAgo]) => [version, new Date(NOW - daysAgo * DAY_MS).toISOString()])),
  };
  return async (url) => {
    expect(url).toBe(`https://registry.npmjs.org/${SDK}`);
    return JSON.stringify(document);
  };
}

const check = (pin: string, fetch: RegistryFetch, hold?: string) => claudeEngineFreshness({ lockText: lock(pin), holdText: hold, nowMs: NOW, fetch });
const hold = (sdkVersion: string, recordedOn: string) => JSON.stringify({ sdkVersion, recordedOn, reason: "The 0.3.300 engine refuses a resumed thinking row." });

describe("the Claude engine pin's freshness", () => {
  test("a pin with no newer release passes and states the pin, its engine, and its age", async () => {
    const verdict = await check("0.3.296", registry([["0.3.295", 12], ["0.3.296", 11]]));
    expect(verdict).toEqual({ status: "pass", lines: [
      `${SDK} 0.3.296 (engine 2.1.296), published 2026-11-09, 11 days old`,
      "newest 0.3.296 (engine 2.1.296), 0 releases behind",
    ] });
  });

  test("newer releases pass until the oldest of them is older than 21 days", async () => {
    const within = await check("0.3.296", registry([["0.3.296", 30], ["0.3.297", 21], ["0.3.298", 2]]));
    expect(within.status).toBe("pass");
    expect(within.lines[1]).toBe("newest 0.3.298 (engine 2.1.298), 2 releases behind; 0.3.297 superseded the pin 21 days ago, and readiness fails after 21");
    const stale = await check("0.3.296", registry([["0.3.296", 30], ["0.3.297", 22], ["0.3.298", 2]]));
    expect(stale.status).toBe("fail");
    expect(stale.lines.at(-1)).toContain("bump the SDK and qualify it, or record a dated reason in scripts/claude-engine-hold.json");
  });

  test("prereleases and versions that no tag reached do not count", async () => {
    const fetch = registry([["0.3.296", 30], ["0.3.297-beta.1", 25], ["0.3.297", 5]]);
    expect((await check("0.3.296", fetch)).lines[1]).toStartWith("newest 0.3.297 (engine 2.1.297), 1 release behind");
  });

  test("a hold for the pinned version, recorded within 21 days, passes a stale pin and names its reason", async () => {
    const fetch = registry([["0.3.296", 40], ["0.3.297", 30]]);
    const held = await check("0.3.296", fetch, hold("0.3.296", "2026-11-01"));
    expect(held.status).toBe("pass");
    expect(held.lines.at(-1)).toBe("held since 2026-11-01 until 2026-11-22: The 0.3.300 engine refuses a resumed thinking row.");
    expect((await check("0.3.296", fetch, hold("0.3.296", "2026-10-29"))).status).toBe("fail");
    expect((await check("0.3.296", fetch, hold("0.3.296", "2026-11-21"))).status).toBe("fail");
  });

  test("a hold that names another version fails, so a bump removes its hold", async () => {
    const verdict = await check("0.3.297", registry([["0.3.296", 40], ["0.3.297", 30]]), hold("0.3.296", "2026-11-01"));
    expect(verdict.status).toBe("fail");
    expect(verdict.lines.at(-1)).toBe("scripts/claude-engine-hold.json holds 0.3.296, not the pinned 0.3.297; remove it");
  });

  test("a malformed hold fails and states the shape", async () => {
    const verdict = await check("0.3.296", registry([["0.3.296", 1]]), JSON.stringify({ sdkVersion: "0.3.296", reason: "" }));
    expect(verdict).toEqual({ status: "fail", lines: [expect.stringContaining('{"sdkVersion": "<pinned version>", "recordedOn": "YYYY-MM-DD", "reason": "<why>"}')] });
  });

  test("a registry that cannot answer, or does not list the pin, leaves the question open", async () => {
    const unreachable = await check("0.3.296", async () => { throw new Error("getaddrinfo ENOTFOUND registry.npmjs.org"); });
    expect(unreachable).toEqual({ status: "blocked", lines: [`the npm registry did not answer for ${SDK}: getaddrinfo ENOTFOUND registry.npmjs.org`] });
    expect((await check("0.3.299", registry([["0.3.296", 1]]))).status).toBe("blocked");
  });
});

describe("an engine bump", () => {
  test("is a pinned SDK that differs from the one the last release tag pinned, a pin that release did not have, or any pin before a first release", () => {
    expect(engineBump(lock("0.3.297"), { tag: "v0.0.12", lockText: lock("0.3.296") })).toEqual({ bumped: true, detail: `${SDK} 0.3.296 in v0.0.12 is now 0.3.297` });
    expect(engineBump(lock("0.3.296"), { tag: "v0.0.12", lockText: lock("0.3.296") })).toEqual({ bumped: false, detail: `v0.0.12 already shipped ${SDK} 0.3.296` });
    expect(engineBump(lock("0.3.296"), undefined)).toEqual({ bumped: true, detail: `no release tag precedes ${SDK} 0.3.296` });
    expect(engineBump(lock("0.3.296"), { tag: "v0.0.12", lockText: JSON.stringify({ lockfileVersion: 1, packages: {} }) })).toEqual({ bumped: true, detail: `v0.0.12 shipped no ${SDK}; this release adds 0.3.296` });
  });
});

describe("the live tier's Claude login", () => {
  const temporary = temporaryDirectories();

  test("is found in a profile renamed to the live display name, which keeps the directory of its original id", async () => {
    const userDataRoot = join(temporary("flywheel-live-login-"), ".flywheel");
    const access = await new AuthProfileStore(userDataRoot).create("default");
    access.close();
    const configDir = join(access.authDirectory, LOGIN_ACCOUNTS_DIRECTORY, "a");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, ".claude.json"), JSON.stringify({ oauthAccount: { accountUuid: "uuid-person", emailAddress: "person@example.com" } }));
    await new AuthProfileManager({ userDataRoot, projectRoot: userDataRoot, env: {} }).rename("default", "Live");

    expect(liveClaudeAccounts(userDataRoot, userDataRoot, "Live").map(({ configDir: found }) => found)).toEqual([configDir]);
    expect(liveClaudeAccounts(userDataRoot, userDataRoot, "Work")).toEqual([]);
  });
});
