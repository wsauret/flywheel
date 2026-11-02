import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Log } from "../../../../src/infra/log.js";
import { temporaryDirectories } from "../../../helpers/directories.js";
import { installCustomProviders } from "../../../../src/infra/llm/custom-provider-registry.js";
import { buildCustomProvidersFromConfig, logCustomProviderDiagnostics, publishCustomProvidersFromConfig } from "../../../../src/orchestration/config/custom-providers.js";
import { CONFIG_VALUE_ABSENT, createRuntimeConfigOwner, type RuntimeConfigOwnerOptions } from "../../../../src/orchestration/config/runtime-config-owner.js";
import { ConfigPublicationError, withConfigOwnership } from "../../../../src/orchestration/config/config-file.js";
import { AuthProfileStore } from "../../../../src/infra/auth/auth-profile-store.js";
import { resolveRoles } from "../../../../src/orchestration/config/role-resolution.js";

// Custom providers publish into a process-wide registry that every module
// composition in this process reads; a test that publishes clears it, so
// the compositions other files compose stay the shipped catalog.
afterEach(() => { installCustomProviders([]); });

const temporaryDirectory = temporaryDirectories();

function fixture() {
  const root = temporaryDirectory("runtime-config-owner-");
  mkdirSync(join(root, ".flywheel"));
  return { root, configPath: join(root, ".flywheel", "flywheel.toml") };
}

describe("RuntimeConfigOwner", () => {
  it.each([
    ['[roles.chat]\nmodel = "retired-model"\n', "config-root-roles-retired"],
    ['[model_efforts]\n"gpt-6-luna" = "high"\n', "config-model-efforts-retired"],
    ['[roles.chat]\nmodel = "retired-model"\n[model_efforts]\n"gpt-6-luna" = "high"\n', "config-model-efforts-retired"],
  ])("retires obsolete tables before first publication and after an external edit: %s", async (retired, code) => {
    const test = fixture();
    const warning = spyOn(Log.create({ service: "config" }), "warn");
    const siblings = 'show_thinking = true\n[profiles.personal.roles.chat]\nmodel = "gpt-6-luna"\neffort = "low"\n[profiles.other]\nallow_training_routes = true\n';
    writeFileSync(test.configPath, `${siblings}${retired}`);
    const owner = await createRuntimeConfigOwner({ configPath: test.configPath, env: {}, watch: false });
    try {
      expect(Bun.TOML.parse(readFileSync(test.configPath, "utf8"))).not.toHaveProperty("roles");
      expect(owner.snapshot().config.profiles.personal?.roles.chat?.model).toBe("gpt-6-luna");
      expect(owner.snapshot().config.profiles.other?.allow_training_routes).toBe(true);
      expect(owner.snapshot().config.show_thinking).toBe(true);
      expect(owner.snapshot().config.profiles.personal?.roles.chat?.effort).toBe("low");
      expect(owner.snapshot().config).not.toHaveProperty("model_efforts");
      expect(warning.mock.calls.filter(([, fields]) => fields?.code === code)).toHaveLength(1);
      const first = owner.snapshot();
      await owner.refresh();
      expect(owner.snapshot()).toBe(first);
      writeFileSync(test.configPath, `${siblings}${retired}`);
      await owner.refresh();
      expect(Bun.TOML.parse(readFileSync(test.configPath, "utf8"))).not.toHaveProperty("roles");
      expect(owner.snapshot()).toBe(first);
      expect(warning.mock.calls.filter(([, fields]) => fields?.code === code)).toHaveLength(2);
      await owner.refresh();
      expect(warning.mock.calls.filter(([, fields]) => fields?.code === code)).toHaveLength(2);
    } finally { warning.mockRestore(); await owner.dispose(); }
  });

  it("moves v0.0.12 root roles to every auth profile without merging partial role overrides", async () => {
    const test = fixture();
    const userDataRoot = join(test.root, ".flywheel");
    const profiles = new AuthProfileStore(userDataRoot);
    for (const id of ["default", "personal", "effort-only", "unconfigured"]) (await profiles.create(id)).close();
    writeFileSync(test.configPath, `
[roles.chat]
model = "root-model"
effort = "high"
provider = "openai_api"
[roles.step-agent]
model = "workflow-model"
effort = "low"
[roles.reviewer]
model = "root-reviewer"
effort = "low"
[roles.reviewer-quality]
model = "root-quality"
effort = "high"
[roles.compactor]
model = "removed-model"
[roles.unknown-role]
model = "unknown-model"
[profiles.personal.roles.chat]
model = "profile-model"
effort = "low"
[profiles.effort-only.roles.chat]
effort = "medium"
[profiles.personal.roles.step-worker]
effort = "high"
[profiles.personal.roles.reviewer]
model = "profile-reviewer"
effort = "medium"
[profiles.effort-only.roles.reviewer]
model = "profile-reviewer"
[profiles.effort-only.roles.reviewer-quality]
model = "profile-quality"
effort = "low"
`);
    const owner = await createRuntimeConfigOwner({ configPath: test.configPath, userDataRoot, env: {}, watch: false });
    try {
      const config = owner.snapshot().config;
      for (const id of ["default", "unconfigured"]) {
        expect(config.profiles[id]?.roles.chat).toEqual({ model: "root-model", effort: "high" });
      }
      expect(config.profiles.personal?.roles.chat).toEqual({ model: "profile-model", effort: "low" });
      expect(config.profiles["effort-only"]?.roles.chat).toEqual({ effort: "medium" });
      expect(config.profiles.personal?.roles).not.toHaveProperty("reviewer-quality");
      const available = new Map([["openai", new Set(["root-reviewer", "root-quality", "profile-reviewer", "profile-quality"])] as const]);
      for (const id of ["default", "personal", "effort-only", "unconfigured"]) {
        expect(config.profiles[id]?.roles["workflow-agent"]).toEqual(id === "personal"
          ? { effort: "high" } : { model: "workflow-model", effort: "low" });
        expect(config.profiles[id]?.roles).not.toHaveProperty("compactor");
        expect(config.profiles[id]?.roles).not.toHaveProperty("unknown-role");
        const resolved = await resolveRoles(config, available, { userDataRoot, roleEnvironment: {} }, id, [], new Set(["reviewer-quality", "reviewer-elegance"]));
        expect(resolved.get("reviewer-quality")).toMatchObject(id === "personal"
          ? { model: "profile-reviewer", effort: "medium" }
          : id === "effort-only" ? { model: "profile-quality", effort: "low" }
          : { model: "root-quality", effort: "high" });
        expect(resolved.get("reviewer-elegance")?.model).toBe(id === "personal" || id === "effort-only" ? "profile-reviewer" : "root-reviewer");
        if (id === "default" || id === "unconfigured") {
          expect(config.profiles[id]?.roles.reviewer).toEqual({ model: "root-reviewer", effort: "low" });
          expect(config.profiles[id]?.roles["reviewer-quality"]).toEqual({ model: "root-quality", effort: "high" });
        }
      }
      const saved = readFileSync(test.configPath, "utf8");
      expect(Bun.TOML.parse(saved)).not.toHaveProperty("roles");
      expect(saved).not.toContain("provider");
      expect(saved).not.toContain("removed-model");
      expect(saved).not.toContain("unknown-model");
      await owner.refresh();
      expect(readFileSync(test.configPath, "utf8")).toBe(saved);
    } finally { await owner.dispose(); }
  });

  it("awaits a held retirement lock without exposing an initial snapshot", async () => {
    const test = fixture();
    writeFileSync(test.configPath, '[model_efforts]\n"gpt-6-luna" = "high"\n');
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let exposed = false;
    const pending = createRuntimeConfigOwner({
      configPath: test.configPath, env: {}, watch: false,
      withOwnership: async (location, use) => {
        entered.resolve();
        await release.promise;
        return withConfigOwnership(location, use);
      },
    }).then((owner) => { exposed = true; return owner; });
    await entered.promise;
    expect(exposed).toBe(false);
    expect(readFileSync(test.configPath, "utf8")).toContain("[model_efforts]");
    const unrelated = await createRuntimeConfigOwner({ configPath: join(test.root, "other.toml"), watch: false });
    await unrelated.dispose();
    release.resolve();
    const owner = await pending;
    try {
      expect(exposed).toBe(true);
      expect(Bun.TOML.parse(readFileSync(test.configPath, "utf8"))).not.toHaveProperty("model_efforts");
      expect(owner.snapshot().status.kind).toBe("valid");
    } finally { await owner.dispose(); }
  });

  it("does not publish retirement candidates when the ownership write fails", async () => {
    const test = fixture();
    const original = 'show_thinking = true\n[roles.chat]\nmodel = "lost"\n[model_efforts]\n"gpt-6-luna" = "high"\n';
    writeFileSync(test.configPath, original);
    let fail = true;
    const owner = await createRuntimeConfigOwner({
      configPath: test.configPath, env: {}, watch: false,
      withOwnership: (location, use) => withConfigOwnership(location, (ownership) => use({
        ...ownership, write: (text) => {
          if (fail) throw new Error("injected retirement failure");
          return ownership.write(text);
        },
      })),
    });
    try {
      expect(readFileSync(test.configPath, "utf8")).toBe(original);
      expect(owner.snapshot().status).toMatchObject({ kind: "malformed", fallback: "defaults" });
      expect(owner.snapshot().config.show_thinking).toBe(false);
      fail = false;
      await owner.refresh();
      expect(owner.snapshot().config.show_thinking).toBe(true);
      fail = true;
      writeFileSync(test.configPath, original.replace("true", "false"));
      await owner.refresh();
      expect(owner.snapshot().status).toMatchObject({ kind: "malformed", fallback: "last-valid" });
      expect(owner.snapshot().config.show_thinking).toBe(true);
    } finally { await owner.dispose(); }
  });

  it("converts external root roles inside mutation and use-time ownership windows", async () => {
    const test = fixture();
    const owner = await createRuntimeConfigOwner({ configPath: test.configPath, env: {}, watch: false });
    try {
      writeFileSync(test.configPath, '[roles.chat]\nmodel = "lost"\n[model_efforts]\n"gpt-6-luna" = "high"\n');
      expect((await owner.mutate("showThinking", false, true)).ok).toBe(true);
      const converted = { show_thinking: true, profiles: { default: { roles: { chat: { model: "lost" } } } } };
      expect(Bun.TOML.parse(readFileSync(test.configPath, "utf8"))).toEqual(converted);
      writeFileSync(test.configPath, 'show_thinking = true\n[roles.chat]\nmodel = "lost"\n[model_efforts]\n"gpt-6-luna" = "high"\n');
      const read = await owner.revalidateUseTime((value) => value, (value) => value);
      expect(read.kind === "text" ? Bun.TOML.parse(read.text) : undefined).toEqual(converted);
      expect(Bun.TOML.parse(readFileSync(test.configPath, "utf8"))).toEqual(converted);
    } finally { await owner.dispose(); }
  });

  it("defaults maintenance settings for previous files and persists live changes", async () => {
    const test = fixture();
    const previous = 'show_thinking = true\n[profiles.personal.roles.chat]\nmodel = "old-model"\n';
    writeFileSync(test.configPath, previous);
    const owner = await createRuntimeConfigOwner({ configPath: test.configPath, watch: false });
    let changes = 0;
    const unsubscribe = owner.subscribe("idleCompaction", () => { changes++; });
    try {
      expect(owner.snapshot().config.idle_compaction).toBe(true);
      expect(owner.snapshot().config.auto_delete_session_days).toBe(0);
      expect((await owner.mutate("autoDeleteSessionDays", 0, 14)).ok).toBe(true);
      expect(owner.snapshot().config.auto_delete_session_days).toBe(14);
      expect(readFileSync(test.configPath, "utf8")).toContain("auto_delete_session_days = 14");
      expect((await owner.mutate("autoDeleteSessionDays", 14, 1.5)).ok).toBe(false);
      expect((await owner.mutate("autoDeleteSessionDays", 14, -1)).ok).toBe(false);
      expect((await owner.mutate("autoDeleteSessionDays", 14, 0)).ok).toBe(true);
      expect((await owner.mutate("idleCompaction", true, false)).ok).toBe(true);
      expect(changes).toBe(1);
      expect(owner.snapshot().config.idle_compaction).toBe(false);
      expect(owner.snapshot().config.profiles.personal?.roles.chat?.model).toBe("old-model");
      expect(readFileSync(test.configPath, "utf8")).toContain("idle_compaction = false");
      await owner.refresh();
      expect(owner.snapshot().config.idle_compaction).toBe(false);
    } finally { await unsubscribe(); await owner.dispose(); }
  });
  it("retains the last valid config across a malformed edit and recovers", async () => {
    const test = fixture();
    writeFileSync(test.configPath, "show_thinking = true\n");
    const owner = await createRuntimeConfigOwner({ configPath: test.configPath, watch: false });
    try {
      expect(owner.snapshot().config.show_thinking).toBe(true);
      expect(owner.snapshot().status).toEqual({ kind: "valid" });
      const revision = owner.snapshot().revision;
      writeFileSync(test.configPath, "show_thinking = [\n");
      await owner.refresh();
      expect(owner.snapshot().revision).toBe(revision + 1);
      expect(owner.snapshot().config.show_thinking).toBe(true);
      expect(owner.snapshot().status.kind).toBe("malformed");
      expect(owner.snapshot().status).toEqual({ kind: "malformed", fallback: "last-valid", message: "Config text is malformed." });
      writeFileSync(test.configPath, "show_thinking = false\n");
      await owner.refresh();
      expect(owner.snapshot().config.show_thinking).toBe(false);
      expect(owner.snapshot().status.kind).toBe("valid");
      expect(owner.snapshot().diagnostics).toEqual([]);
    } finally {
      await owner.dispose();
    }
  });

  it("retains an invalid module selection without resetting other settings and applies its repair", async () => {
    const test = fixture();
    writeFileSync(test.configPath, 'show_thinking = true\ndisabled_modules = ["remote"]\n');
    const owner = await createRuntimeConfigOwner({ configPath: test.configPath, watch: false });
    try {
      const modules = owner.snapshot().config.modules;
      writeFileSync(test.configPath, 'show_thinking = false\ndisabled_modules = ["nope"]\n');
      await owner.refresh();
      expect(owner.snapshot().config.modules).toEqual(modules);
      expect(owner.snapshot().config.show_thinking).toBe(false);
      expect(owner.snapshot().warnings.join("\n")).toContain("nope");
      writeFileSync(test.configPath, "disabled_modules = []\n");
      await owner.refresh();
      expect(owner.snapshot().config.modules).toContain("remote");
      expect(owner.snapshot().warnings).toEqual([]);
    } finally {
      await owner.dispose();
    }
  });

  it("keeps default fallback provenance and prior normalization diagnostics across malformed refreshes", async () => {
    const test = fixture();
    writeFileSync(test.configPath, 'allow_persistent_processes = "invalid"\nshow_thinking = "invalid"\n');
    const owner = await createRuntimeConfigOwner({ configPath: test.configPath, watch: false });
    try {
      expect(owner.snapshot().status).toEqual({ kind: "malformed", fallback: "defaults", message: "Config text is malformed." });
      expect(owner.snapshot().diagnostics).toContainEqual({ kind: "setting", settingId: "allowPersistentProcesses", path: ["allow_persistent_processes"], reason: "normalized-value" });
      expect(owner.snapshot().diagnostics).toContainEqual({ kind: "setting", settingId: "showThinking", path: ["show_thinking"], reason: "invalid-value" });
      await owner.refresh();
      expect(owner.snapshot().status).toEqual({ kind: "malformed", fallback: "defaults", message: "Config text is malformed." });
    } finally {
      await owner.dispose();
    }
  });

  it("distinguishes missing files from refused and oversized malformed snapshots", async () => {
    const test = fixture();
    const missing = await createRuntimeConfigOwner({ userDataRoot: test.root, watch: false });
    expect(missing.snapshot().status.kind).toBe("missing");
    await missing.dispose();

    writeFileSync(join(test.root, "outside.toml"), "show_thinking = true\n");
    symlinkSync(join(test.root, "outside.toml"), test.configPath);
    const refused = await createRuntimeConfigOwner({ configPath: test.configPath, watch: false });
    expect(refused.snapshot().status.kind).toBe("malformed");
    expect(refused.snapshot().status).toEqual({ kind: "malformed", fallback: "defaults", message: "Config file was refused or unreadable." });
    rmSync(test.configPath);
    writeFileSync(test.configPath, "x".repeat(1024 * 1024 + 1));
    await refused.refresh();
    expect(refused.snapshot().status.kind).toBe("malformed");
    const invalidUtf8 = Buffer.concat([Buffer.from("# "), Buffer.from([0xff]), Buffer.from("\n")]);
    writeFileSync(test.configPath, invalidUtf8);
    await refused.refresh();
    expect(refused.snapshot().status.kind).toBe("malformed");
    const mutation = await refused.mutate("showThinking", CONFIG_VALUE_ABSENT, true);
    expect(mutation.ok).toBe(false);
    if (!mutation.ok) expect(mutation.kind).toBe("parse-or-decode-failed");
    expect(readFileSync(test.configPath)).toEqual(invalidUtf8);
    await refused.dispose();
  });

  it("retains the last valid snapshot when a later descriptor read is refused", async () => {
    const test = fixture();
    writeFileSync(test.configPath, "show_thinking = true\n");
    const owner = await createRuntimeConfigOwner({ configPath: test.configPath, watch: false });
    rmSync(test.configPath);
    mkdirSync(test.configPath);
    await owner.refresh();
    expect(owner.snapshot().status.kind).toBe("malformed");
    expect(owner.snapshot().config.show_thinking).toBe(true);
    await owner.dispose();
  });

  it("rejects a stale expected value without publishing", async () => {
    const test = fixture();
    const owner = await createRuntimeConfigOwner({ configPath: test.configPath, watch: false });
    try {
      const before = owner.snapshot();
      const result = await owner.mutate("showThinking", true, true);
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("stale mutation unexpectedly committed");
      expect(result.kind).toBe("stale");
      expect(owner.snapshot()).toBe(before);
      const source = 'theme = "aura"\nshow_thinking = true\n[notifications]\ndesktop = false\n[profiles.work.providers.github_copilot]\nmonthly_credit_cap = 100\n';
      writeFileSync(test.configPath, source);
      await owner.refresh();
      const beforeReset = owner.snapshot();
      const edited = source.replace("monthly_credit_cap = 100", "monthly_credit_cap = 200");
      writeFileSync(test.configPath, edited);
      const reset = await owner.resetSettings("work");
      expect(reset.ok).toBe(false);
      if (!reset.ok) expect(reset.kind).toBe("stale");
      expect(readFileSync(test.configPath, "utf8")).toBe(edited);
      expect(owner.snapshot()).toBe(beforeReset);
    } finally {
      await owner.dispose();
    }
  });

  it("matches a projected default when the setting is not authored", async () => {
    const test = fixture();
    const owner = await createRuntimeConfigOwner({ configPath: test.configPath, watch: false });
    try {
      const result = await owner.mutate("webSearchProvider", "chatgpt", "exa");
      expect(result.ok).toBe(true);
      expect(owner.snapshot().config.web_search.provider).toBe("exa");
    } finally {
      await owner.dispose();
    }
  });

  it("applies semantic CAS to one profile Git AI attribution overlay", async () => {
    const test = fixture();
    writeFileSync(test.configPath, '[profiles.work.roles.review]\nmodel = "gpt-5.4-mini"\n');
    const owner = await createRuntimeConfigOwner({ configPath: test.configPath, watch: false });
    try {
      const enabled = await owner.mutateProfileBoolean("gitAiAttribution", "work", false, true);
      expect(enabled.ok).toBe(true);
      expect(owner.snapshot().config.profiles.work?.git_ai_attribution).toBe(true);

      const stale = await owner.mutateProfileBoolean("gitAiAttribution", "work", false, true);
      expect(stale.ok).toBe(false);
      if (stale.ok) throw new Error("stale profile mutation unexpectedly committed");
      expect(stale.kind).toBe("stale");

      const disabled = await owner.mutateProfileBoolean("gitAiAttribution", "work", true, false);
      expect(disabled.ok).toBe(true);
      expect(readFileSync(test.configPath, "utf8")).toBe('[profiles.work.roles.review]\nmodel = "gpt-5.4-mini"\n');
      expect(owner.snapshot().config.profiles.work?.git_ai_attribution).toBe(false);
    } finally {
      await owner.dispose();
    }
  });

  it("keeps Show build per project: a config without the section reads off, writes persist across reopen and never touch other projects or settings", async () => {
    const test = fixture();
    writeFileSync(test.configPath, "show_thinking = true\n");
    const first = await createRuntimeConfigOwner({ configPath: test.configPath, watch: false });
    try {
      // The previous file shape has no `projects` section.
      expect(first.snapshot().config.projects).toEqual({});
      expect(first.snapshot().config.show_thinking).toBe(true);

      expect((await first.mutateProjectShowBuild("/scratch/a", false, true)).ok).toBe(true);
      const stale = await first.mutateProjectShowBuild("/scratch/a", false, true);
      expect(stale.ok).toBe(false);
      if (stale.ok) throw new Error("stale project mutation unexpectedly committed");
      expect(stale.kind).toBe("stale");
      expect((await first.mutateProjectShowBuild("/scratch/b", false, true)).ok).toBe(true);
      expect((await first.mutateProjectShowBuild("/scratch/b", true, false)).ok).toBe(true);
    } finally {
      await first.dispose();
    }

    writeFileSync(test.configPath, readFileSync(test.configPath, "utf8").replaceAll("show_build =", '"show_build" ='));
    const reopened = await createRuntimeConfigOwner({ configPath: test.configPath, watch: false });
    try {
      const { config } = reopened.snapshot();
      expect(config.projects["/scratch/a"]?.show_build).toBe(true);
      expect(config.projects["/scratch/b"]?.show_build ?? false).toBe(false);
      expect(config.show_thinking).toBe(true);
      expect((await reopened.mutateProjectShowBuild("/scratch/a", true, false)).ok).toBe(true);
      expect(reopened.snapshot().config.projects["/scratch/a"]?.show_build).toBe(false);
      expect(Bun.TOML.parse(readFileSync(test.configPath, "utf8"))).toMatchObject({
        show_thinking: true,
        projects: { "/scratch/a": { show_build: false }, "/scratch/b": { show_build: false } },
      });
    } finally {
      await reopened.dispose();
    }
  });

  it("applies semantic CAS to one profile provider setting overlay", async () => {
    const test = fixture();
    writeFileSync(test.configPath, '[profiles.work.roles.review]\nmodel = "gpt-5.4-mini"\n\n[profiles.personal.providers.github_copilot]\nmonthly_credit_cap = false\n');
    const owner = await createRuntimeConfigOwner({ configPath: test.configPath, watch: false });
    const revisions: number[] = [];
    owner.subscribeAll((snapshot) => { revisions.push(snapshot.revision); });
    const cap = (profileId: string, expected: number, value: number) => owner.mutateProfileProviderSetting(profileId, "github_copilot", "monthly_credit_cap", expected, value, 3_900);
    try {
      const capped = await cap("work", 3_900, 1_200);
      expect(capped.ok).toBe(true);
      expect(owner.snapshot().config.profiles.work?.providers.github_copilot?.monthly_credit_cap).toBe(1_200);
      // The retired spelling `false` reads as off.
      expect(owner.snapshot().config.profiles.personal?.providers.github_copilot?.monthly_credit_cap).toBe(0);
      expect(readFileSync(test.configPath, "utf8")).toContain('[profiles.work.providers.github_copilot]\nmonthly_credit_cap = 1200');

      const beforeStale = readFileSync(test.configPath, "utf8");
      const stale = await cap("work", 3_900, 0);
      expect(stale.ok).toBe(false);
      expect(readFileSync(test.configPath, "utf8")).toBe(beforeStale);
      expect(revisions).toEqual([1]);

      const disabled = await cap("work", 1_200, 0);
      expect(disabled.ok).toBe(true);
      expect(owner.snapshot().config.profiles.work?.providers.github_copilot?.monthly_credit_cap).toBe(0);
      // An authored `false` compares as the off value it decodes to.
      const personal = await cap("personal", 0, 500);
      expect(personal.ok).toBe(true);
      expect(owner.snapshot().config.profiles.personal?.providers.github_copilot?.monthly_credit_cap).toBe(500);
      expect(revisions).toEqual([1, 2, 3]);
    } finally {
      await owner.dispose();
    }
  });

  it("does not publish an array-table assignment as the owner of a regular table path", async () => {
    const test = fixture();
    writeFileSync(test.configPath, '[web_search]\ntimeout=5\n[[other]]\nprovider="private"\n');
    const owner = await createRuntimeConfigOwner({ configPath: test.configPath, watch: false });
    try {
      const result = await owner.mutate("webSearchProvider", "chatgpt", "exa");
      expect(result.ok).toBe(true);
      expect(readFileSync(test.configPath, "utf8")).toBe('[web_search]\nprovider = "exa"\ntimeout=5\n[[other]]\nprovider="private"\n');
      expect(owner.snapshot().config.web_search.provider).toBe("exa");
    } finally {
      await owner.dispose();
    }
  });

  it("publishes warning-only changes and ignores unchanged refresh hints", async () => {
    const test = fixture();
    writeFileSync(test.configPath, "future_key = true\n");
    const owner = await createRuntimeConfigOwner({ configPath: test.configPath, watch: false });
    try {
      const warned = owner.snapshot();
      expect(warned.warnings.length).toBe(1);
      expect(await owner.refresh()).toBe(warned);
      writeFileSync(test.configPath, "another_future_key = true\n");
      const next = await owner.refresh();
      expect(next.revision).toBe(warned.revision + 1);
      expect(next.config).toEqual(warned.config);
      expect(next.warnings).not.toEqual(warned.warnings);
    } finally {
      await owner.dispose();
    }
  });

  it("publishes every non-deduplicated revision to snapshot subscribers", async () => {
    const test = fixture();
    writeFileSync(test.configPath, "show_thinking = true\n");
    const owner = await createRuntimeConfigOwner({ configPath: test.configPath, watch: false });
    const statuses: string[] = [];
    owner.subscribeAll((next) => { statuses.push(next.status.kind); });
    try {
      writeFileSync(test.configPath, "show_thinking = [\n");
      await owner.refresh();
      writeFileSync(test.configPath, "show_thinking = true\n");
      await owner.refresh();
      expect(statuses).toEqual(["malformed", "valid"]);
    } finally {
      await owner.dispose();
    }
  });

  it("owns one resident watcher and closes it on disposal", async () => {
    const test = fixture();
    let watches = 0;
    let closes = 0;
    const owner = await createRuntimeConfigOwner({
      configPath: test.configPath,
      watchFile: () => {
        watches += 1;
        return { dispose: () => { closes += 1; } };
      },
    });
    expect(watches).toBe(1);
    await owner.dispose();
    expect(closes).toBe(1);
    await owner.dispose();
    expect(closes).toBe(1);
  });

  it("subscribes to retained sections", async () => {
    const test = fixture();
    const owner = await createRuntimeConfigOwner({ configPath: test.configPath, watch: false });
    let publications = 0;
    owner.subscribe("profiles", () => { publications += 1; });
    try {
      writeFileSync(test.configPath, "[profiles.personal.roles.chat]\nmodel = \"claude-opus-5-5\"\n");
      await owner.refresh();
      expect(publications).toBe(1);
    } finally {
      await owner.dispose();
    }
  });

  it("keeps runtime config diagnostics closed in the real JSONL sink", async () => {
    const test = fixture();
    const sentinels = ["SECRET_TOML_FRAGMENT", "SECRET_SUBSCRIBER_TEXT", "SECRET_PROVIDER_ID", "https://secret.example", "secret-model"];
    await Log.init({ dir: test.root, level: "DEBUG" });
    try {
      writeFileSync(test.configPath, `unknown_SECRET_TOML_FRAGMENT = [\n`);
      const owner = await createRuntimeConfigOwner({ configPath: test.configPath, watch: false });
      owner.subscribeAll(() => { throw new Error(sentinels[1]); });
      writeFileSync(test.configPath, "show_thinking = true\n");
      await owner.refresh();
      const candidate = buildCustomProvidersFromConfig({
        SECRET_PROVIDER_ID: { base_url: "https://secret.example", models: ["secret-model"] },
        alpha: { base_url: "https://secret.example", models: ["secret-model"] },
        beta: { base_url: "https://secret.example", models: ["secret-model"] },
      });
      publishCustomProvidersFromConfig(candidate);
      logCustomProviderDiagnostics(candidate);
      await owner.dispose();
    } finally {
      // The level is process-global; a later file in this process expects INFO.
      await Log.init({ dir: test.root, level: "INFO" });
      await Log.closeGlobal();
    }
    const logDir = join(test.root, ".flywheel", "log");
    const contents = readdirSync(logDir).map((name) => readFileSync(join(logDir, name), "utf8")).join("\n");
    for (const sentinel of sentinels) expect(contents).not.toContain(sentinel);
    expect(contents).toContain("runtime-config-read-malformed");
    expect(contents).toContain("runtime-config-subscriber-failed");
    expect(contents).toContain("custom-provider-config-rejected");
    expect(contents).toContain("custom-provider-config-warning");
  });

  it("publishes a saved publication verification or durability warning once", async () => {
    const test = fixture();
    const owner = await createRuntimeConfigOwner({
      configPath: test.configPath,
      watch: false,
      withOwnership: async (_location, use) => use({
        read: () => ({ kind: "missing" }),
        readText: () => "",
        write: () => new Error("directory sync unavailable"),
      }),
    });
    let publications = 0;
    owner.subscribeAll(() => { publications += 1; });
    try {
      const result = await owner.mutate("showThinking", CONFIG_VALUE_ABSENT, true);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.durabilityWarning).toBe("directory sync unavailable");
        expect(result.snapshot.warnings.at(-1)).toBe("Config saved but publication verification or durability could not be confirmed.");
      }
      expect(publications).toBe(1);
    } finally {
      await owner.dispose();
    }
  });

  it("preserves mutation failure stages", async () => {
    const cases = [
      {
        kind: "lock-failed",
        withOwnership: (async () => { throw new Error("ownership unavailable"); }) satisfies NonNullable<RuntimeConfigOwnerOptions["withOwnership"]>,
      },
      {
        kind: "parse-or-decode-failed",
        withOwnership: (async (_location, use) => use({ read: () => ({ kind: "text", text: "show_thinking = [\n" }), readText: () => "show_thinking = [\n", write: () => undefined })) satisfies NonNullable<RuntimeConfigOwnerOptions["withOwnership"]>,
      },
      {
        kind: "write-not-applied",
        withOwnership: (async (_location, use) => use({ read: () => ({ kind: "missing" }), readText: () => "", write: () => { throw new Error("rename unavailable"); } })) satisfies NonNullable<RuntimeConfigOwnerOptions["withOwnership"]>,
      },
      {
        kind: "write-outcome-unknown",
        withOwnership: (async (_location, use) => use({ read: () => ({ kind: "missing" }), readText: () => "", write: () => { throw new ConfigPublicationError("unknown"); } })) satisfies NonNullable<RuntimeConfigOwnerOptions["withOwnership"]>,
      },
    ] as const;

    for (const testCase of cases) {
      const test = fixture();
      const owner = await createRuntimeConfigOwner({ configPath: test.configPath, watch: false, withOwnership: testCase.withOwnership });
      const before = owner.snapshot();
      let publications = 0;
      let applications = 0;
      owner.subscribeAll(() => { publications += 1; });
      owner.subscribe("showThinking", () => { applications += 1; });
      try {
        const result = await owner.mutate("showThinking", CONFIG_VALUE_ABSENT, true);
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.kind).toBe(testCase.kind);
        expect(owner.snapshot()).toBe(before);
        expect(publications).toBe(0);
        expect(applications).toBe(0);
        if (testCase.kind === "write-not-applied") expect(existsSync(test.configPath)).toBe(false);
      } finally {
        await owner.dispose();
      }
    }
  });
});
