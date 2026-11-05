/**
 * Qualification of the bundled Claude engine's separation from the person's own `claude` installation, in the no-cost tier
 * that every engine bump passes on macOS, Linux, and Windows. The engine runs on a placeholder login against a fake
 * host (`_fake-host.ts`), with the runtime MCP server attached, beside an account home and in a project that hold
 * `claude` files of their own. The engine must write nothing in the account home and keep its own caches and logs
 * in the login's directory. On macOS the engine also runs in a sandbox that kills it at its first access to the
 * `claude` files and folders of the account home or of the person who runs the tests. Logins use a stand-in engine
 * (`_fake-engine.ts`), because a real login needs a person and a browser.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join, relative } from "node:path";
import { createLauncherScope, createProcessSupervisor } from "../../../../../src/infra/process-supervisor.js";
import { privateTemporaryRoot } from "../../../../../src/infra/private-temporary-root.js";
import type { ExternalAccount } from "../../../../../src/infra/llm/access-provider.js";
import { enginePath } from "../../../../../src/infra/claude-engine.js";
import { createClaudeAgentSdkModule } from "../../../../../src/orchestration/modules/provider-claude-agent-sdk/module.js";
import { temporaryDirectories } from "../../../../helpers/directories.js";
import { assistantMessage, removeEngineProbes, streamedToolCalls, withSdkClient } from "./_claude-sdk-client.js";
import { FAKE_ACCOUNT, startFakeHost, writeFakeClaudeLogin } from "./_fake-host.js";
import { LOGIN_ACCOUNTS_DIRECTORY } from "../../../../../src/orchestration/modules/provider-claude-agent-sdk/names.js";

const temporary = temporaryDirectories();
removeEngineProbes();
const READ_TOOL = { name: "read", description: "Reads a file.", input_schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } };

/** One line of the stand-in engine's log (`_fake-engine.ts`). */
interface FakeEngineCall {
  readonly args: readonly string[];
  readonly names: readonly string[];
  readonly placed: { readonly [variable: string]: string | undefined };
}

/** Every file under `dir` with its size and digest, and every directory, by relative path. */
function treeState(dir: string): ReadonlyMap<string, string> {
  const state = new Map<string, string>();
  const visit = (current: string) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      const key = relative(dir, path).replaceAll("\\", "/");
      if (entry.isDirectory()) {
        state.set(key, "directory");
        visit(path);
      } else {
        state.set(key, `${statSync(path).size} ${createHash("sha256").update(readFileSync(path)).digest("hex")}`);
      }
    }
  };
  visit(dir);
  return state;
}

/** `claude` files that change what an engine sends when it reads them: settings that add a request header,
 *  memory text, and an MCP server. */
function writeClaudeFiles(dir: string, marker: string): void {
  mkdirSync(join(dir, ".claude"), { recursive: true });
  writeFileSync(join(dir, ".claude", "settings.json"), JSON.stringify({ env: { ANTHROPIC_CUSTOM_HEADERS: `x-${marker}: read` } }));
  writeFileSync(join(dir, ".claude", "CLAUDE.md"), `${marker} memory text`);
  writeFileSync(join(dir, "CLAUDE.md"), `${marker} memory text`);
  writeFileSync(join(dir, ".mcp.json"), JSON.stringify({ mcpServers: { [marker]: { command: join(dir, "absent-server") } } }));
  writeFileSync(join(dir, ".claude.json"), JSON.stringify({ hasCompletedOnboarding: true, mcpServers: { [`${marker}-global`]: { command: join(dir, "absent-server") } } }));
}

/** Where `claude` keeps its configuration, caches, logs, data, state, and installs under one home, on every
 *  platform: its configuration, its `claude-cli-nodejs` folders, its native installer's folders, the cache of the Bun
 *  runtime that runs it, and the Anthropic profile store. An engine that Flywheel starts names none of them. */
function claudeHomePaths(home: string): string[] {
  const cliFolder = "claude-cli-nodejs";
  return [
    join(home, ".claude"), join(home, ".claude.json"), join(home, ".config", "anthropic"),
    ...["Caches", "Application Support", "Logs", "Preferences"].map((folder) => join(home, "Library", folder, cliFolder)),
    ...[[".cache"], [".config"], [".local", "share"], [".local", "state"], ["AppData", "Local"], ["AppData", "Roaming"]].map((parts) => join(home, ...parts, cliFolder)),
    join(home, ".cache", "claude"), join(home, ".local", "share", "claude"), join(home, ".local", "state", "claude"), join(home, ".local", "bin", "claude"),
    join(home, "Library", "Caches", "bun"), join(home, ".cache", "bun"),
  ];
}

/** On macOS, an engine path that runs the bundled engine in a sandbox that kills it at its first read or write of a
 *  path in `forbidden`. Elsewhere, the bundled engine. */
function guardedEngine(dir: string, forbidden: readonly string[]): string {
  if (process.platform !== "darwin") return enginePath();
  const quote = (path: string) => JSON.stringify(path);
  const profile = `(version 1)(allow default)(deny file-read* file-write* ${forbidden.map((path) => `(subpath ${quote(path)})`).join(" ")} (with send-signal SIGKILL))`;
  const wrapper = join(dir, "guarded-claude");
  writeFileSync(wrapper, `#!/bin/sh\nexec /usr/bin/sandbox-exec -p '${profile}' ${quote(enginePath())} "$@"\n`);
  chmodSync(wrapper, 0o755);
  return wrapper;
}

describe("the bundled Claude engine and the person's own `claude` installation", () => {
  test("a tool round reads and writes none of the `claude` files of the account home or the project, and keeps its caches and MCP logs in the login's own home", async () => {
    // The sandbox matches real paths, and the temporary directory can lie behind a link (/var on macOS).
    const root = realpathSync(temporary("claude-engine-separation-"));
    const home = join(root, "home");
    const projectRoot = join(root, "project");
    const configDir = join(root, "login");
    writeClaudeFiles(home, "person-home");
    writeClaudeFiles(projectRoot, "person-project");
    writeFakeClaudeLogin(configDir);
    const before = { home: treeState(home), project: treeState(projectRoot) };
    const engineTemporary = join(root, "engine-tmp");
    mkdirSync(engineTemporary);
    const person = userInfo().homedir;
    // The temporary directories that every `claude` session shares, unless this run's temporary directory lies inside one of them.
    const sharedTemporary = [`claude-${userInfo().uid}`, `cc-socks-${userInfo().uid}`].map((name) => join("/private/tmp", name)).filter((dir) => !root.startsWith(dir));
    const engine = guardedEngine(root, [
      ...claudeHomePaths(home), ...claudeHomePaths(person), join(projectRoot, ".claude"), join(projectRoot, "CLAUDE.md"), join(projectRoot, ".mcp.json"),
      ...sharedTemporary,
    ]);
    const host = startFakeHost((_, index) => index === 0 ? { blocks: [{ tool: "read", input: { path: "note.txt" } }] } : { blocks: [{ text: "done" }] });
    try {
      await withSdkClient({
        configDir, accountId: FAKE_ACCOUNT.accountUuid, projectRoot, wireModelId: "claude-haiku-5-5", contextLimit: 200_000,
        seams: { enginePath: engine, cliEnvironment: { ...host.environment, CLAUDE_CODE_TMPDIR: engineTemporary }, account: () => ({ home, user: "qualification" }) },
      }, async (open) => {
        const chat = await open();
        const first = await chat.stream({ messages: [{ kind: "user", origin: "human", content: "Read note.txt." }], tools: [READ_TOOL], systemPrompt: { stable: "Stable.", session: "", conversation: "" } });
        const call = streamedToolCalls(first)[0];
        const second = await chat.stream({ messages: [{ kind: "user", origin: "human", content: "Read note.txt." }, assistantMessage(first), { kind: "toolResult", toolUseId: call?.id ?? "", content: [{ type: "text", text: "text" }] }], tools: [READ_TOOL], systemPrompt: { stable: "Stable.", session: "", conversation: "" } });
        expect([first.error, second.error]).toEqual([undefined, undefined]);
      });
    } finally {
      await host.stop();
    }

    expect(host.requests).toHaveLength(2);
    const sent = JSON.stringify(host.requests);
    for (const marker of ["person-home", "person-project"]) expect(sent).not.toContain(marker);
    expect(host.requests.flatMap((request) => request.headerNames).filter((name) => name.startsWith("x-person"))).toEqual([]);
    // The engine writes nothing in the account home: no `claude` configuration, cache, log, or data.
    expect({ home: treeState(home), project: treeState(projectRoot) }).toEqual(before);
    // The engine's logs of the runtime MCP server are in its own home in the login's directory.
    expect([...treeState(configDir).keys()].filter((path) => /(?:^|\/)claude-cli-nodejs\/.*mcp-logs-runtime$/u.test(path))).toHaveLength(1);
  }, 60_000);
});

describe("Claude logins in auth profiles", () => {
  let binDir = "";
  let fakeEngine = "";
  beforeAll(async () => {
    binDir = mkdtempSync(join(tmpdir(), "claude-fake-engine-"));
    fakeEngine = join(binDir, process.platform === "win32" ? "claude.exe" : "claude");
    const build = Bun.spawn([process.execPath, "build", "--compile", join(import.meta.dir, "_fake-engine.ts"), "--outfile", fakeEngine], { stdout: "pipe", stderr: "pipe", windowsHide: true });
    if (await build.exited !== 0) throw new Error(`the stand-in engine did not build: ${await new Response(build.stderr).text()}`);
  });
  const supervisor = createProcessSupervisor();
  const launcher = createLauncherScope(supervisor);
  afterAll(async () => {
    await launcher.close();
    await supervisor.dispose();
    rmSync(binDir, { recursive: true, force: true });
  });

  test("each profile keeps its own login of one account, and a logout ends only that profile's login", async () => {
    const root = temporary("claude-profile-logins-");
    const home = join(root, "home");
    const log = join(root, "engine.jsonl");
    mkdirSync(home);
    const [profileA, profileB] = [join(root, "profile-a"), join(root, "profile-b")];
    for (const profile of [profileA, profileB]) mkdirSync(profile);
    const definition = createClaudeAgentSdkModule({
      enginePath: fakeEngine, account: () => ({ home, user: "qualification" }),
      cliEnvironment: { FAKE_ENGINE_LOG: log, FAKE_ENGINE_ACCOUNT: FAKE_ACCOUNT.accountUuid },
    }).contributions[0].value.definition;
    // The engine opens its own browser; a stand-in login opens none.
    const ports = { launcher, openBrowser: async () => { throw new Error("a stand-in login opens no browser"); } };
    const previous = { key: process.env["ANTHROPIC_API_KEY"], dir: process.env["CLAUDE_CONFIG_DIR"] };
    // Variables of the person's own environment that would move an engine onto another login.
    process.env["ANTHROPIC_API_KEY"] = "sk-ant-api03-person-environment";
    process.env["CLAUDE_CONFIG_DIR"] = join(home, ".claude");
    let accountA: ExternalAccount;
    let accountB: ExternalAccount;
    try {
      accountA = await definition.auth.login(profileA, ports, undefined);
      accountB = await definition.auth.login(profileB, ports, undefined);
      expect(definition.auth.accounts(profileA)).toEqual([accountA]);
      expect(definition.auth.accounts(profileB)).toEqual([accountB]);
      expect(accountA.accountId).toBe(accountB.accountId);
      expect(accountA.configDir).not.toBe(accountB.configDir);
      await definition.auth.logout(profileA, accountA.accountId, ports);
      expect([definition.auth.accounts(profileA), definition.auth.accounts(profileB)]).toEqual([[], [accountB]]);
      await definition.auth.logoutProfile(profileB, ports);
      expect(definition.auth.accounts(profileB)).toEqual([]);
    } finally {
      process.env["ANTHROPIC_API_KEY"] = previous.key;
      process.env["CLAUDE_CONFIG_DIR"] = previous.dir;
      if (previous.key === undefined) delete process.env["ANTHROPIC_API_KEY"];
      if (previous.dir === undefined) delete process.env["CLAUDE_CONFIG_DIR"];
    }

    const calls: readonly FakeEngineCall[] = readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(calls.map(({ args, placed }) => [args.slice(0, 2).join(" "), placed["CLAUDE_CONFIG_DIR"]])).toEqual([
      ["auth login", accountA.configDir], ["auth login", accountB.configDir], ["auth logout", accountA.configDir], ["auth logout", accountB.configDir],
    ]);
    expect([accountA.configDir, accountB.configDir].map((dir) => existsSync(dir))).toEqual([false, false]);
    for (const { names, placed } of calls) {
      // Each command runs in the login's own home, never in the account home.
      const engineHome = join(placed["CLAUDE_CONFIG_DIR"] ?? "", "home");
      expect(placed).toEqual({
        CLAUDE_CONFIG_DIR: expect.stringContaining(join(LOGIN_ACCOUNTS_DIRECTORY, "")), DISABLE_UPDATES: "1", DISABLE_AUTOUPDATER: "1",
        HOME: engineHome, USERPROFILE: engineHome, LOCALAPPDATA: join(engineHome, "AppData", "Local"), APPDATA: join(engineHome, "AppData", "Roaming"),
        CLAUDE_CODE_TMPDIR: privateTemporaryRoot(tmpdir(), "fw-claude"),
      });
      expect(names.filter((name) => name.startsWith("ANTHROPIC_"))).toEqual([]);
    }
  }, 60_000);
});
