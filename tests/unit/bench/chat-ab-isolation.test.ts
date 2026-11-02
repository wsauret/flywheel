import { describe, expect, it } from "bun:test";
import { mkdirSync, realpathSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { cellIsolation, claudeCodeRules, profileKeychainRules, inheritedCellEnvironment, profileCredentialRules } from "../../../bench/chat-ab/isolation.js";
import { temporaryDirectories } from "../../helpers/directories.js";
import { fakeOwnedCommandRunner, ownedCommandResult } from "../../helpers/owned-command-fake.js";
import { BUNDLED_SKILL_DIR } from "../../../src/workflows/skill-source-inventory.js";
import { CONTAINER_MARK_VARIABLE, STRICT_DESCENDANT_SETTLEMENT_VARIABLE } from "../../../src/infra/container-mark.js";

const temporaryDirectory = temporaryDirectories();

it("inherits only shell and SDK host inputs, never operator credentials or runtime routing", () => {
  expect(inheritedCellEnvironment({
    PATH: "/usr/bin:/bin", SHELL: "/bin/zsh", TZ: "UTC", USER: "operator",
    HOME: "/scratch/operator", TMPDIR: "/scratch/operator/tmp", TMUX: "operator-server",
    OPENAI_API_KEY: "synthetic-openai", AWS_SECRET_ACCESS_KEY: "synthetic-aws",
    ANTHROPIC_API_KEY: "synthetic-anthropic", CLAUDE_CODE_OAUTH_TOKEN: "synthetic-login",
    CLAUDECODE: "1", CLAUDE_CONFIG_DIR: "/scratch/controller-claude",
    GH_TOKEN: "synthetic-github", BENCH_RESULT: "operator-result",
    FLYWHEEL_AUTH_PROFILE: "operator-profile", FLYWHEEL_NATIVE_DIR: "operator-native",
    FLYWHEEL_CHAT_MODEL: "operator-model", FLYWHEEL_UNRECOGNIZED: "operator-override",
    UNKNOWN_CREDENTIAL: "synthetic-unknown", LANG: undefined,
    [CONTAINER_MARK_VARIABLE]: "outer",
    [STRICT_DESCENDANT_SETTLEMENT_VARIABLE]: "/outer/",
  })).toEqual({
    PATH: "/usr/bin:/bin", SHELL: "/bin/zsh", TZ: "UTC", USER: "operator",
    [CONTAINER_MARK_VARIABLE]: "outer", [STRICT_DESCENDANT_SETTLEMENT_VARIABLE]: "/outer/",
  });
});

// The rules are macOS sandbox-exec profile text, and a campaign refuses to start on any other host (isolation.ts).
describe.if(process.platform === "darwin")("chat A/B cell isolation", () => {
  it("denies a cell the credential file of every auth profile but its own, wherever a rename moves it, and lets it read and refresh its own", () => {
    const store = join(temporaryDirectory("chat-ab-isolation-"), ".flywheel");
    const profiles = join(store, "auth", "profiles");
    const escaped = profiles.replaceAll(".", "\\.");

    // The store holds no profile yet: the rules name paths and read nothing, so a synthetic default profile needs no stored one.
    expect(profileCredentialRules(store, "default")).toEqual([
      // One pattern covers a profile created after the campaign starts and a profile folder renamed to any name.
      `(deny file-read-data file-write* (regex #"^${escaped}/[^/]+/auth\\.json$"))`,
      // A rename of the auth or profiles folder would move every credential file out of the pattern, and a rename onto the arm's own folder would move another profile's file under the allowance below.
      `(deny file-write* (literal "${join(store, "auth")}") (literal "${profiles}") (literal "${join(profiles, "default")}"))`,
      `(allow file-read-data file-write* (literal "${join(profiles, "default", "auth.json")}"))`,
    ]);
  });

  it("allows normal profile keychain access while denying historical bench credentials", () => {
    const home = "/scratch/operator";
    const normalLogin = `(allow file-read* file-read-data file-write* (subpath "${home}/Library/Keychains"))`;
    const denied = `(deny file-read* file-read-data file-write* (subpath "${home}/.flywheel-bench"))`;

    // The runtime and agent tools share this allowance. OS item-level protections remain in force.
    expect(profileKeychainRules(home)).toEqual([normalLogin, denied]);
  });

  it("allows Claude Code's normal configuration and keychains while denying the Flywheel and bench stores", () => {
    const home = "/scratch/operator";
    const rules = claudeCodeRules(home);
    expect(rules.slice(0, 2)).toEqual([
      `(allow file-read* file-read-data file-write* (subpath "${home}/.claude") (subpath "${home}/Library/Keychains") (regex #"^/scratch/operator/\\.claude\\.json[^/]*$"))`,
      `(deny file-read* file-read-data file-write* (subpath "${home}/.flywheel") (subpath "${home}/.flywheel-bench"))`,
    ]);
    expect(rules[2]).toStartWith("(deny file-read-data file-write* ");
    for (const store of ["projects", "file-history", "todos", "history.jsonl", "session-env", "plans", "tasks", "debug", "paste-cache", "uploads", "feedback", "feedback-bundles", "jobs", "daemon", "daemon.log", "sessions", "teams"]) {
      expect(rules[2]).toContain(`(subpath "${home}/.claude/${store}")`);
    }
    expect(rules[2]).not.toContain("shell-snapshots");
    // A rename of ~/.claude itself would move every store out of these paths.
    expect(rules[3]).toBe(`(deny file-write* (literal "${home}/.claude"))`);
  });

  it("lets a Flywheel cell write only the lock folders of the bundled skill roots in the denied repository, so a skill load can lock its package", async () => {
    const root = realpathSync(temporaryDirectory("chat-ab-skill-locks-"));
    const { run } = fakeOwnedCommandRunner((command) => Promise.resolve(ownedCommandResult(command.includes("--git-common-dir") ? `${root}/.git\n` : "")));
    // A skill load locks its package in the `.locks` folder beside it (package-directory-lock.ts). A cell runs this
    // source tree, so its bundled packages lie in the repository, whose writes the profile denies.
    const locks = [`(subpath "${join(realpathSync(BUNDLED_SKILL_DIR), ".locks")}")`];

    const flywheel = (await cellIsolation(root, root, run, { kind: "flywheel", authProfile: "default" })).wrap(["true"])[2]!.split("\n");
    const repositoryDenial = flywheel.findIndex((line) => line.startsWith("(deny file-write*") && line.includes(`(subpath "${root}")`));
    const lockAllowance = flywheel.findIndex((line) => line.startsWith("(allow file-write*") && locks.every((lock) => line.includes(lock)));
    expect(repositoryDenial).toBeGreaterThan(-1);
    // A later rule wins, so the allowance follows the denial it narrows.
    expect(lockAllowance).toBeGreaterThan(repositoryDenial);
    // A Claude Code cell loads no Flywheel skill, so its profile keeps the whole repository denied.
    const claudeCode = (await cellIsolation(root, root, run, { kind: "claude-code" })).wrap(["true"])[2]!;
    expect(locks.some((lock) => claudeCode.includes(lock))).toBe(false);
  });

  it("lets a Flywheel cell lock shared skill packages under the denied home, and needs no shared root to exist", async () => {
    const root = realpathSync(temporaryDirectory("chat-ab-shared-skill-locks-"));
    const home = join(root, "home");
    const { run } = fakeOwnedCommandRunner((command) => Promise.resolve(ownedCommandResult(command.includes("--git-common-dir") ? `${root}/.git\n` : "")));
    const sharedLocks = `(subpath "${join(home, ".agents", "skills", ".locks")}")`;
    const oldHome = process.env.HOME;
    try {
      process.env.HOME = home;
      mkdirSync(home);
      const withoutShared = (await cellIsolation(root, root, run, { kind: "flywheel", authProfile: "default" })).wrap(["true"])[2]!;
      expect(withoutShared).not.toContain(sharedLocks);
      mkdirSync(join(home, ".agents", "skills"), { recursive: true });
      const profile = (await cellIsolation(root, root, run, { kind: "flywheel", authProfile: "default" })).wrap(["true"])[2]!.split("\n");
      const homeDenial = profile.findIndex((line) => line.startsWith("(deny file-write*") && line.includes(`(subpath "${home}")`));
      const lockAllowance = profile.findIndex((line) => line.startsWith("(allow file-write*") && line.includes(sharedLocks));
      expect(homeDenial).toBeGreaterThan(-1);
      expect(lockAllowance).toBeGreaterThan(homeDenial);
    } finally {
      if (oldHome === undefined) delete process.env.HOME;
      else process.env.HOME = oldHome;
    }
  });

  it("confines one cell to its own folders inside the folders that hold every cell's work, and keeps the account rules above that", async () => {
    const root = realpathSync(temporaryDirectory("chat-ab-confine-"));
    const sibling = join(realpathSync(temporaryDirectory("chat-ab-sibling-")), "outside checkout");
    mkdirSync(sibling);
    const [results, cells] = [join(root, "results"), join(root, "cells")];
    for (const dir of [join(results, "block", "claude-code"), join(cells, "sandbox")]) mkdirSync(dir, { recursive: true });
    // The sandbox checks the real path, so an own folder named through a link is confined at its target.
    symlinkSync(join(cells, "sandbox"), join(root, "link"));
    const roster = [`worktree ${root}`, "HEAD abc", "", `worktree ${sibling}`, "HEAD def", "", ""].join("\0");
    const { run } = fakeOwnedCommandRunner((command) => Promise.resolve(ownedCommandResult(command.includes("--git-common-dir") ? `${root}/.git\n` : command.includes("worktree") ? roster : "")));
    const isolation = await cellIsolation(root, results, run, { kind: "claude-code" });
    const projectRoot = join(cells, "sandbox");
    const sessionId = "10000000-0000-4000-8000-000000000001";
    const confined = await isolation.confine({ hidden: [results, cells], own: [join(results, "block", "claude-code"), join(root, "link")], claudeCode: { projectRoot, sessionId } });

    const profile = confined.wrap(["true"])[2]!.split("\n");
    const recordedDenial = profile.indexOf(claudeCodeRules(isolation.accountHome)[2]!);
    const ownSession = profile.findIndex((line) => line.startsWith("(allow file-read-data") && line.includes(`/session-env/${sessionId}`));
    expect(recordedDenial).toBeGreaterThan(-1);
    expect(ownSession).toBeGreaterThan(recordedDenial);
    expect(profile[ownSession]).toContain(`/projects/${projectRoot.replace(/[^a-zA-Z0-9]/g, "-")}`);
    for (const name of ["file-history", "session-env", "tasks", "uploads"]) expect(profile[ownSession]).toContain(`/${name}/${sessionId}`);
    expect(profile[ownSession]).toContain(`/debug/${sessionId}.txt`);
    expect(profile[ownSession]).toContain(`/todos/${sessionId}-agent-`);
    const siblingDenial = profile.findIndex((line) => line.startsWith("(deny file-read-data ") && line.includes(`(subpath ${JSON.stringify(sibling)})`));
    expect(siblingDenial).toBeGreaterThan(-1);
    const nested = join(sibling, "source");
    mkdirSync(nested);
    const nestedRoster = `${roster}worktree ${nested}\0HEAD ghi\0\0`;
    const { run: nestedRun } = fakeOwnedCommandRunner((command) => Promise.resolve(ownedCommandResult(command.includes("--git-common-dir") ? `${root}/.git\n` : command.includes("worktree") ? nestedRoster : "")));
    const nestedProfile = (await cellIsolation(nested, results, nestedRun, { kind: "claude-code" })).wrap(["true"])[2]!.split("\n");
    const ancestorDenial = nestedProfile.findIndex((line) => line.startsWith("(deny file-read-data ") && line.includes(`(subpath ${JSON.stringify(sibling)})`));
    const sourceAllowance = nestedProfile.indexOf(`(allow file-read-data (subpath ${JSON.stringify(nested)}))`);
    expect(ancestorDenial).toBeGreaterThan(-1);
    expect(sourceAllowance).toBeGreaterThan(ancestorDenial);
    const hidden = profile.indexOf(`(deny file-read-data file-write* (subpath "${results}") (subpath "${cells}"))`);
    expect(hidden).toBeGreaterThan(-1);
    expect(siblingDenial).toBeLessThan(hidden);
    expect(profile[hidden + 1]).toBe(`(allow file-read-data file-write* (subpath "${join(results, "block", "claude-code")}") (subpath "${join(cells, "sandbox")}"))`);
    const readonly = join(cells, "shared-runtime");
    mkdirSync(readonly);
    const readProfile = (await isolation.confine({ hidden: [cells], own: [join(cells, "sandbox")], readonly: [readonly] })).wrap(["true"])[2]!.split("\n");
    expect(readProfile).toContain(`(allow file-read-data (subpath "${readonly}"))`);
    const writes = readProfile.filter(line => line.startsWith("(allow file-write") || line.startsWith("(allow file-read-data file-write*"));
    expect(writes.every(line => !line.includes(readonly))).toBe(true);
    const hiddenTasks = join(readonly, "tasks");
    mkdirSync(hiddenTasks);
    const controllerCache = join(root, "node_modules", ".cache");
    const campaignProfile = (await isolation.confine({
      hidden: [cells, hiddenTasks], own: [join(cells, "sandbox")], readonly: [readonly], writeDenied: [controllerCache],
    })).wrap(["true"])[2]!.split("\n");
    expect(campaignProfile.indexOf(`(deny file-read-data file-write* (subpath "${hiddenTasks}"))`)).toBeGreaterThan(campaignProfile.indexOf(`(allow file-read-data (subpath "${readonly}"))`));
    expect(campaignProfile).toContain(`(deny file-write* (subpath "${controllerCache}"))`);
    // Configuration allowances precede confinement; private store denials remain last.
    expect(profile.findIndex((line) => line.includes("Library/Keychains"))).toBeLessThan(hidden);
    // The campaign's isolation, which other cells share, stays as it was.
    expect(isolation.wrap(["true"])[2]).not.toContain(cells);
    expect(confined.accountHome).toBe(isolation.accountHome);
    const nativeProfile = (await cellIsolation(root, results, run, { kind: "flywheel", authProfile: "native-profile" })).wrap(["true"])[2]!;
    const keychainAllowance = profileKeychainRules(isolation.accountHome)[0]!;
    expect(nativeProfile).toContain(keychainAllowance);
    for (const rule of profileCredentialRules(join(isolation.accountHome, ".flywheel"), "native-profile")) {
      expect(nativeProfile).toContain(rule);
    }
    expect(isolation.wrap(["true"])[2]).toContain(`(subpath "${join(isolation.accountHome, "Library", "Keychains")}")`);
    const cellHome = join(results, "block", "claude-code", "home");
    const environment = { ...inheritedCellEnvironment({ HOME: "/scratch/operator", TMPDIR: "/scratch/operator/tmp" }), ...await confined.prepareHome(cellHome) };
    expect(environment).toEqual({
      HOME: cellHome, TMPDIR: join(cellHome, "tmp"), TMUX_TMPDIR: join(cellHome, "tmp"), GH_CONFIG_DIR: join(cellHome, "gh"),
    });
  });

  it("keeps checkout confinement after Claude configuration allowances when the checkout lies under .claude/worktrees", async () => {
    const home = realpathSync(temporaryDirectory("chat-ab-claude-overlap-"));
    const root = join(home, ".claude", "worktrees", "controller");
    const results = join(root, "bench/chat-ab/results");
    const own = join(results, "cell/workspace");
    const tasks = join(root, "bench/chat-ab/tasks");
    const cache = join(root, "node_modules/.cache");
    const locks = join(root, "src/agent-skills/.locks");
    for (const path of [own, tasks, cache, locks]) mkdirSync(path, { recursive: true });
    const { run } = fakeOwnedCommandRunner((command) => Promise.resolve(ownedCommandResult(command.includes("--git-common-dir") ? `${root}/.git\n` : "")));
    const previousHome = process.env.HOME;
    try {
      process.env.HOME = home;
      const isolation = await cellIsolation(root, results, run, { kind: "claude-code" });
      const profile = (await isolation.confine({ hidden: [results, tasks], own: [own], writeDenied: [cache, locks] })).wrap(["true"])[2]!.split("\n");
      const allowance = profile.indexOf(claudeCodeRules(home)[0]!);
      const hidden = profile.indexOf(`(deny file-read-data file-write* (subpath "${results}") (subpath "${tasks}"))`);
      const writeDenied = profile.indexOf(`(deny file-write* (subpath "${cache}") (subpath "${locks}"))`);
      const checkoutDenied = profile.findIndex((line) => line.startsWith("(deny file-write*") && line.includes(`(subpath "${root}")`));
      expect(allowance).toBeGreaterThan(-1);
      expect(checkoutDenied).toBeGreaterThan(allowance);
      expect(hidden).toBeGreaterThan(allowance);
      expect(writeDenied).toBeGreaterThan(allowance);
      expect(profile.indexOf(claudeCodeRules(home)[1]!)).toBeGreaterThan(hidden);
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
    }
  });
});
