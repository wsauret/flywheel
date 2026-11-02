import { describe, expect, spyOn, test } from "bun:test";
import { POSIX_FAILURE_STAGING } from "../../../helpers/posix-failure-staging.js";
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AuthProfileDisplayNameConflictError, AuthProfileManager } from "../../../../src/orchestration/auth/auth-profile-manager.js";
import { AuthProfileStore } from "../../../../src/infra/auth/auth-profile-store.js";
import { ContainedDirectory } from "../../../../src/infra/descriptor-directory.js";
import { authDir } from "../../../../src/infra/paths.js";
import { temporaryDirectories } from "../../../helpers/directories.js";

const temporaryDirectory = temporaryDirectories();

describe("AuthProfileManager", () => {
  test("renames a display name without changing stable references or the directory id", async () => {
    const root = temporaryDirectory("auth-profile-manager-");
    const projectRoot = join(root, "project");
    const manager = new AuthProfileManager({ userDataRoot: root, projectRoot, env: {} });

    await manager.create("Work Account");
    expect((await manager.bind("work-account")).ok).toBe(true);
    await manager.rename("work-account", "Personal Work");

    expect(await manager.resolve()).toMatchObject({ id: "work-account", displayName: "Personal Work", source: "project", projectBinding: "work-account" });
    expect(existsSync(authDir(root, "work-account"))).toBe(true);
    expect(JSON.parse(readFileSync(join(authDir(root, "work-account"), "profile.json"), "utf8"))).toEqual({ displayName: "Personal Work" });
  });

  test("hides synthetic Default when a stored non-default profile is effective", async () => {
    const root = temporaryDirectory("auth-profile-manager-default-hidden-");
    const manager = new AuthProfileManager({ userDataRoot: root, projectRoot: join(root, "project"), env: {} });
    await manager.create("Work");
    await manager.select("work");

    expect(await manager.resolve()).toMatchObject({ id: "work", availableProfiles: [{ id: "work", displayName: "Work" }] });
  });

  test("slugifies new ids and appends a suffix for empty or colliding slugs", async () => {
    const root = temporaryDirectory("auth-profile-manager-create-");
    const manager = new AuthProfileManager({ userDataRoot: root, projectRoot: join(root, "project"), env: {} });

    await manager.create("Work Account");
    await manager.create("work-account!");
    await manager.create("!!!");

    expect((await manager.resolve()).availableProfiles).toEqual([
      { id: "default", displayName: "Default" },
      { id: "-2", displayName: "!!!" },
      { id: "work-account", displayName: "Work Account" },
      { id: "work-account-2", displayName: "work-account!" },
    ]);
  });

  test("rejects case-insensitive display-name duplicates on create and rename", async () => {
    const root = temporaryDirectory("auth-profile-manager-conflict-");
    const manager = new AuthProfileManager({ userDataRoot: root, projectRoot: join(root, "project"), env: {} });
    await manager.create("Work");
    await manager.create("Personal");

    await expect(manager.create("WORK")).rejects.toBeInstanceOf(AuthProfileDisplayNameConflictError);
    await expect(manager.rename("personal", "wOrK")).rejects.toThrow('auth profile display name already exists: wOrK');
  });

  test("resolves environment selectors by exact id before display name", async () => {
    const root = temporaryDirectory("auth-profile-manager-env-");
    const setup = new AuthProfileManager({ userDataRoot: root, projectRoot: join(root, "project"), env: {} });
    await setup.create("Work Account");
    await setup.create("work-account");

    const byId = new AuthProfileManager({ userDataRoot: root, projectRoot: join(root, "project"), env: { FLYWHEEL_AUTH_PROFILE: "work-account" } });
    expect(await byId.resolve()).toMatchObject({ id: "work-account", displayName: "Work Account", source: "environment" });

    const byDisplayName = new AuthProfileManager({ userDataRoot: root, projectRoot: join(root, "project"), env: { FLYWHEEL_AUTH_PROFILE: "WORK-ACCOUNT" } });
    expect(await byDisplayName.resolve()).toMatchObject({ id: "work-account-2", displayName: "work-account", source: "environment" });
  });

  test("keeps persisted selection separate from an environment-locked effective profile", async () => {
    const root = temporaryDirectory("auth-profile-manager-env-lock-");
    const setup = new AuthProfileManager({ userDataRoot: root, projectRoot: join(root, "project"), env: {} });
    await setup.create("Work");
    await setup.create("External");
    await setup.select("work");

    const locked = new AuthProfileManager({ userDataRoot: root, projectRoot: join(root, "project"), env: { FLYWHEEL_AUTH_PROFILE: "external" } });
    expect(await locked.resolve()).toMatchObject({ id: "external", persistedId: "work", source: "environment" });
  });

  test("keeps invalid environment selectors on the existing missing-profile error path", async () => {
    const root = temporaryDirectory("auth-profile-manager-env-missing-");
    const manager = new AuthProfileManager({ userDataRoot: root, projectRoot: join(root, "project"), env: { FLYWHEEL_AUTH_PROFILE: "Missing Profile" } });

    expect(await manager.resolve()).toMatchObject({ id: "Missing Profile", displayName: "Missing Profile", source: "environment" });
    await expect(manager.acquireAccess({ createDefault: true })).rejects.toThrow("auth profile does not exist: Missing Profile");
  });

  test("materializes the implicit default that an environment selector names by its display name", async () => {
    const root = temporaryDirectory("auth-profile-manager-env-default-");
    await new AuthProfileManager({ userDataRoot: root, projectRoot: join(root, "project"), env: {} }).create("Work");
    const manager = new AuthProfileManager({ userDataRoot: root, projectRoot: join(root, "project"), env: { FLYWHEEL_AUTH_PROFILE: "Default" } });

    const access = await manager.acquireAccess({ createDefault: true });
    access.close();

    expect(existsSync(authDir(root, "default"))).toBe(true);
    expect(await manager.resolve()).toMatchObject({ id: "default", displayName: "Default", source: "environment" });
  });

  test("materializes only the implicit default when startup requests it", async () => {
    const root = temporaryDirectory("auth-profile-manager-first-run-");
    const manager = new AuthProfileManager({ userDataRoot: root, projectRoot: join(root, "project"), env: {} });

    const access = await manager.acquireAccess({ createDefault: true });
    access.close();
    const reopened = await manager.acquireAccess();
    reopened.close();

    expect(existsSync(authDir(root, "default"))).toBe(true);
    expect(await manager.resolve()).toMatchObject({ id: "default", source: "default" });
  });

  test("migrates one root Copilot cap to every stored profile plus synthetic Default", async () => {
    const root = temporaryDirectory("auth-profile-manager-cap-migration-");
    const configPath = join(root, "flywheel.toml");
    const manager = new AuthProfileManager({ userDataRoot: root, projectRoot: join(root, "project"), configPath, env: {} });
    await manager.create("Work");
    writeFileSync(configPath, "# keep\n[providers.github_copilot]\nmonthly_credit_cap = false # authored\n\n[profiles.work]\ngit_ai_attribution = true\n\n[profiles.work.providers.github_copilot]\nmonthly_credit_cap = 1234\n");

    expect(await manager.migrateProviderSettings()).toEqual({ ok: true });
    const first = readFileSync(configPath, "utf8");
    const parsed = Bun.TOML.parse(first);
    expect(parsed).not.toHaveProperty("providers.github_copilot.monthly_credit_cap");
    expect(parsed).toMatchObject({ profiles: {
      default: { providers: { github_copilot: { monthly_credit_cap: 0 } } },
      work: { providers: { github_copilot: { monthly_credit_cap: 1234 } } },
    } });
    expect(first).toContain("git_ai_attribution = true");
    expect(await manager.migrateProviderSettings()).toEqual({ ok: true });
    expect(readFileSync(configPath, "utf8")).toBe(first);
  });

  test("selection rewrites an existing project binding with the selected id", async () => {
    const root = temporaryDirectory("auth-profile-manager-select-");
    const manager = new AuthProfileManager({ userDataRoot: root, projectRoot: join(root, "project"), env: {} });
    await manager.create("Work");
    expect((await manager.bind("work")).ok).toBe(true);
    await manager.create("Personal");

    await manager.select("work");
    expect(await manager.resolve()).toMatchObject({ id: "work", source: "project", projectBinding: "work" });
  });

    interface ProjectProfiles { readonly [projectRoot: string]: string }
  test("resolves project bindings from the injected runtime config snapshot", async () => {
    const root = temporaryDirectory("auth-profile-manager-runtime-config-");
    const projectRoot = join(root, "project");
    let projectProfiles: ProjectProfiles = { [projectRoot]: "work" };
    const manager = new AuthProfileManager({
      userDataRoot: root,
      projectRoot,
      env: {},
      config: () => ({ auth: { project_profiles: projectProfiles } }),
    });
    await manager.create("Work");
    await manager.create("Personal");

    expect(await manager.resolve()).toMatchObject({ id: "work", source: "project" });
    projectProfiles = { [projectRoot]: "personal" };
    expect(await manager.resolve()).toMatchObject({ id: "personal", source: "project" });
  });

  test("selection refuses to persist behind an environment override", async () => {
    const root = temporaryDirectory("auth-profile-manager-env-select-");
    const manager = new AuthProfileManager({ userDataRoot: root, projectRoot: join(root, "project"), env: { FLYWHEEL_AUTH_PROFILE: "external" } });
    await new AuthProfileManager({ userDataRoot: root, projectRoot: join(root, "project"), env: {} }).create("Work");

    await expect(manager.select("work")).rejects.toThrow("environment-selected");
  });

  test("returns a stable id without changing the persisted selection", async () => {
    const root = temporaryDirectory("auth-profile-manager-create-selection-");
    const projectRoot = join(root, "project");
    const manager = new AuthProfileManager({ userDataRoot: root, projectRoot, env: {} });

    await manager.create("Existing");
    expect(await manager.select("existing")).toBeUndefined();
    expect(await manager.create("New Profile")).toBe("new-profile");

    expect(await manager.resolve()).toMatchObject({ id: "existing", source: "sticky" });
  });

  test("cleans bindings and moves sticky selection before deleting a profile", async () => {
    const root = temporaryDirectory("auth-profile-manager-delete-");
    const projectRoot = join(root, "project");
    const manager = new AuthProfileManager({ userDataRoot: root, projectRoot, env: {} });
    await manager.create("Work");
    await manager.create("Personal");
    await manager.select("work");
    expect((await manager.bind("work")).ok).toBe(true);
    const other = new AuthProfileManager({ userDataRoot: root, projectRoot: join(root, "other-project"), env: {} });
    expect((await other.bind("work")).ok).toBe(true);

    expect((await manager.delete("work", undefined, "personal")).ok).toBe(true);
    expect(await manager.resolve()).toMatchObject({ id: "personal", source: "project", projectBinding: "personal" });
    expect((await new AuthProfileManager({ userDataRoot: root, projectRoot: join(root, "other-project"), env: {} }).resolve()).projectBinding).toBe("personal");
    await expect(manager.acquireAccess()).resolves.toBeDefined();
  });

  test("runs pre-remove only after durable binding repair and before directory removal", async () => {
    const root = temporaryDirectory("auth-profile-manager-pre-remove-");
    const projectRoot = join(root, "project");
    const observations: Array<{ bindingRemoved: boolean; directoryExists: boolean }> = [];
    const manager = new AuthProfileManager({
      userDataRoot: root,
      projectRoot,
      env: {},
    });
    await manager.create("Work");
    expect((await manager.bind("work")).ok).toBe(true);

    expect((await manager.delete("work", async (id) => {
      observations.push({
        bindingRemoved: !readFileSync(join(root, "flywheel.toml"), "utf8").includes(' = "work"'),
        directoryExists: existsSync(authDir(root, id)),
      });
      return () => {};
    }, null)).ok).toBe(true);
    expect(observations).toEqual([{ bindingRemoved: true, directoryExists: true }]);
    expect(existsSync(authDir(root, "work"))).toBe(false);
  });

  test("clears the sole custom and Default profiles into distinct clean identities", async () => {
    const root = temporaryDirectory("auth-profile-manager-delete-last-");
    const manager = new AuthProfileManager({ userDataRoot: root, projectRoot: join(root, "project"), env: {} });
    await manager.create("Work");
    await manager.select("work");
    expect((await manager.delete("work", undefined, null)).ok).toBe(true);

    const access = await manager.acquireAccess({ createDefault: true });
    access.close();
    expect(existsSync(authDir(root, "default"))).toBe(true);
    writeFileSync(join(authDir(root, "default"), "auth.json"), '{"old":"credential"}');
    expect((await manager.delete("default", undefined, null)).ok).toBe(true);
    const cleared = await manager.resolve();
    expect(cleared.id).not.toBe("default");
    expect(cleared.availableProfiles).toEqual([{ id: cleared.id, displayName: "Default" }]);
    expect(existsSync(join(cleared.directory, "auth.json"))).toBe(false);
    expect((await manager.delete(cleared.id, undefined, null)).ok).toBe(true);
    expect((await manager.resolve()).id).not.toBe(cleared.id);
  });

  test.skipIf(!POSIX_FAILURE_STAGING)("keeps the profile when binding removal reaches a durability error", async () => {
    const fs = await import("node:fs");
    const root = temporaryDirectory("auth-profile-manager-delete-durability-");
    const configPath = join(root, "config", "flywheel.toml");
    const manager = new AuthProfileManager({ userDataRoot: root, projectRoot: join(root, "project"), configPath, env: {} });
    await manager.create("Work");
    await manager.select("work");
    expect((await manager.bind("work")).ok).toBe(true);
    const original = fs.fsyncSync;
    let failed = false;
    const fsync = spyOn(fs, "fsyncSync").mockImplementation((fd) => {
      const published = fs.fstatSync(fd).isDirectory() && !fs.readFileSync(configPath, "utf8").includes(' = "work"');
      if (published && !failed) {
        failed = true;
        throw new Error("directory sync boom");
      }
      return original(fd);
    });
    try {
      const result = await manager.delete("work", undefined, null);
      expect(result.ok).toBe(false);
      expect(existsSync(authDir(root, "work"))).toBe(true);
    } finally {
      fsync.mockRestore();
    }
  });

  test("removes multiline project bindings before deleting a profile", async () => {
    const root = temporaryDirectory("auth-profile-manager-delete-multiline-");
    const configPath = join(root, "config", "flywheel.toml");
    const projectRoot = join(root, "project");
    const manager = new AuthProfileManager({ userDataRoot: root, projectRoot, configPath, env: {} });
    await manager.create("Work");
    mkdirSync(join(root, "config"), { recursive: true });
    // A TOML basic string escapes backslashes, and a Windows project root is
    // full of them. JSON escaping matches TOML's for every character a path can
    // hold, so this composes the key the config writer would have written.
    writeFileSync(configPath, `[auth.project_profiles]\n${JSON.stringify(projectRoot)} = """\\\nwork\\\n"""\n`);

    expect((await manager.delete("work", undefined, null)).ok).toBe(true);
    expect(Bun.TOML.parse(readFileSync(configPath, "utf8"))).toMatchObject({ auth: { project_profiles: { [projectRoot]: "default" } } });
  });

  test("keeps a committed successor and retries exact-source cleanup when config publication fails", async () => {
    const root = temporaryDirectory("auth-profile-manager-delete-config-failure-");
    const projectRoot = join(root, "project");
    const configDirectory = join(root, "config");
    const configPath = join(configDirectory, "flywheel.toml");
    const manager = new AuthProfileManager({ userDataRoot: root, projectRoot, configPath, env: {} });
    await manager.create("Work");
    await manager.create("Personal");
    await manager.select("work");
    expect((await manager.bind("work")).ok).toBe(true);
    const heldConfigDirectory = join(root, "held-config");
    renameSync(configDirectory, heldConfigDirectory);
    writeFileSync(configDirectory, "not a directory");

    let preRemoveCalls = 0;
    const result = await manager.delete("work", async () => { preRemoveCalls += 1; return () => {}; }, "personal");

    unlinkSync(configDirectory);
    renameSync(heldConfigDirectory, configDirectory);
    expect(result.ok).toBe(false);
    expect(existsSync(authDir(root, "work"))).toBe(true);
    expect(await manager.resolve()).toMatchObject({ id: "personal", source: "project", projectBinding: "personal", retirements: { work: "personal" } });
    expect(preRemoveCalls).toBe(0);
    expect((await manager.delete("work", undefined, "personal")).ok).toBe(true);
    expect(existsSync(authDir(root, "work"))).toBe(false);
    expect(existsSync(authDir(root, "personal"))).toBe(true);
  });

  test("previews real survivors, requires a choice for many, and refuses a stale exact choice", async () => {
    const root = temporaryDirectory("auth-profile-manager-choice-");
    const manager = new AuthProfileManager({ userDataRoot: root, projectRoot: join(root, "project"), env: {} });
    await manager.create("Work");
    expect(await manager.previewDelete("work")).toMatchObject({ kind: "fresh-default" });
    const configPath = join(root, "flywheel.toml");
    const sourceConfig = '[profiles.work]\nauto_enable_new_models = false\n';
    writeFileSync(configPath, sourceConfig);
    await manager.create("Personal");
    await expect(manager.delete("work", undefined, null)).rejects.toThrow("preview changed");
    expect(readFileSync(configPath, "utf8")).toBe(sourceConfig);
    expect(manager.inspect().retirements).toEqual({});
    expect(await manager.previewDelete("work")).toMatchObject({ kind: "automatic", successor: { id: "personal", displayName: "Personal" } });
    await manager.create("Other");
    expect(await manager.previewDelete("work")).toMatchObject({ kind: "choose", candidates: [{ id: "other" }, { id: "personal" }] });
    await expect(manager.delete("work", undefined, null)).rejects.toThrow("choose");
    await manager.delete("personal", undefined, "other");
    await expect(manager.delete("work", undefined, "personal")).rejects.toThrow("destination does not exist");
    expect(readFileSync(configPath, "utf8")).toContain(sourceConfig);
    expect((await manager.delete("work", undefined, "other")).successorId).toBe("other");
    expect(manager.inspect().retirements).toEqual({ personal: "other", work: "other" });
  });

  test("flattens historical transfers and never allocates retired or configured ids", async () => {
    const root = temporaryDirectory("auth-profile-manager-history-");
    const configPath = join(root, "flywheel.toml");
    const manager = new AuthProfileManager({ userDataRoot: root, projectRoot: join(root, "project"), env: {} });
    writeFileSync(configPath, '[profiles.work]\nauto_enable_new_models = false\n');
    expect(await manager.create("Work")).toBe("work-2");
    await manager.create("Personal");
    await manager.delete("work-2", undefined, "personal");
    expect(await manager.create("Work")).toBe("work-3");
    await manager.delete("personal", undefined, "work-3");
    expect(manager.inspect().retirements).toEqual({ "work-2": "work-3", personal: "work-3" });
    const stale = new AuthProfileManager({ userDataRoot: root, projectRoot: join(root, "project"), env: {}, config: () => ({ auth: { project_profiles: { [join(root, "project")]: "work-2" } } }) });
    expect(stale.inspect()).toMatchObject({ id: "work-3", persistedId: "work-3" });
  });

  test.each([
    '[profiles.work]\nauto_enable_new_models = false\n[profiles.work.providers.copilot]\nmax_requests_per_minute = 9\n',
    '[profiles]\nwork = { auto_enable_new_models = false, providers = { copilot = { max_requests_per_minute = 9 } } }\n',
    'profiles.work.auto_enable_new_models = false\nprofiles.work.providers.copilot.max_requests_per_minute = 9\n',
  ])("removes the complete source config without inheriting it or rewriting unrelated TOML: %s", async (settings) => {
    const root = temporaryDirectory("auth-profile-manager-settings-");
    const manager = new AuthProfileManager({ userDataRoot: root, projectRoot: join(root, "project"), env: {} });
    await manager.create("Work");
    const configPath = join(root, "flywheel.toml");
    const untouched = '# Keep this exact comment\n[profiles.unrelated]\nauto_enable_new_models = true # keep\n';
    writeFileSync(configPath, `${settings}${untouched}`);
    const result = await manager.delete("work", undefined, null);
    expect(result.ok).toBe(true);
    expect(readFileSync(configPath, "utf8")).toContain(untouched);
    const parsed = Bun.TOML.parse(readFileSync(configPath, "utf8"));
    if (parsed === null || typeof parsed !== "object" || !("profiles" in parsed)) throw new Error("expected profile settings");
    expect(parsed.profiles).toEqual({ unrelated: { auto_enable_new_models: true } });
    expect(result.successorId).toBe("default");
  });

  test.each([0, 1, 2])("clears implicit Default with %i stored survivors only on request", async (survivors) => {
    const root = temporaryDirectory("auth-profile-manager-synthetic-");
    const manager = new AuthProfileManager({ userDataRoot: root, projectRoot: join(root, "project"), env: {} });
    expect(manager.inspect().availableProfiles).toEqual([{ id: "default", displayName: "Default" }]);
    expect(existsSync(authDir(root, "default"))).toBe(false);
    for (let i = 0; i < survivors; i++) await manager.create(`Survivor ${i}`);
    expect(manager.inspect().availableProfiles).toContainEqual({ id: "default", displayName: "Default" });
    const locked = new AuthProfileManager({ userDataRoot: root, projectRoot: join(root, "project"), env: { FLYWHEEL_AUTH_PROFILE: "Default" } });
    await expect(locked.previewDelete("default")).rejects.toThrow("cannot delete the environment-selected auth profile");
    expect((await manager.previewDelete("default")).kind).toBe(survivors === 0 ? "fresh-default" : survivors === 1 ? "automatic" : "choose");
    const successor = survivors === 0 ? "default-2" : "survivor-0";
    expect((await manager.delete("default", undefined, survivors === 0 ? null : successor)).successorId).toBe(successor);
    expect(manager.inspect().availableProfiles).not.toContainEqual({ id: "default", displayName: "Default" });
    await expect(manager.previewDelete("default")).rejects.toThrow("does not exist");
  });

  test("removes an unpublished fresh destination on failure before ledger publication", async () => {
    const root = temporaryDirectory("auth-profile-manager-before-commit-");
    const store = new AuthProfileStore(root);
    const manager = new AuthProfileManager({ userDataRoot: root, projectRoot: join(root, "project"), env: {}, store });
    await manager.create("Default");
    const original = ContainedDirectory.prototype.writeFile;
    const write = spyOn(ContainedDirectory.prototype, "writeFile").mockImplementation(function (this: ContainedDirectory, name, content) {
      if (name === ".profile-retirements.json") throw new Error("ledger write failed");
      return original.call(this, name, content);
    });
    try {
      await expect(manager.delete("default", undefined, null)).rejects.toThrow("ledger write failed");
    } finally {
      write.mockRestore();
    }
    expect(store.inspect().profiles).toEqual([{ id: "default", displayName: "Default" }]);
    expect(store.inspect().retirements).toEqual({});
    expect(existsSync(authDir(root, "default-2"))).toBe(false);
  });

  test("keeps the fresh successor after ledger publication and retries physical cleanup", async () => {
    const root = temporaryDirectory("auth-profile-manager-after-commit-");
    const manager = new AuthProfileManager({ userDataRoot: root, projectRoot: join(root, "project"), env: {} });
    await manager.create("Default");
    const original = ContainedDirectory.prototype.writeFile;
    const write = spyOn(ContainedDirectory.prototype, "writeFile").mockImplementation(function (this: ContainedDirectory, name, content) {
      const result = original.call(this, name, content);
      return name === ".profile-retirements.json" ? new Error("ledger directory sync failed") : result;
    });
    try {
      await expect(manager.delete("default", undefined, null)).rejects.toThrow("ledger directory sync failed");
    } finally {
      write.mockRestore();
    }
    expect(manager.inspect()).toMatchObject({ id: "default-2", availableProfiles: [{ id: "default-2" }], retirements: { default: "default-2" } });
    const remove = spyOn(ContainedDirectory.prototype, "removeTree").mockImplementation(() => { throw new Error("remove failed"); });
    try {
      await expect(manager.delete("default", undefined, null)).rejects.toThrow("remove failed");
    } finally {
      remove.mockRestore();
    }
    expect(existsSync(authDir(root, "default-2"))).toBe(true);
    await expect(manager.delete("default", async () => { throw new Error("preRemove failed"); }, "default-2")).rejects.toThrow("preRemove failed");
    expect(existsSync(authDir(root, "default"))).toBe(true);
    await manager.create("Successor");
    await manager.delete("default-2", undefined, "successor");
    await manager.create("Other");
    await expect(manager.delete("default", undefined, "other")).rejects.toThrow("already committed");
    expect(await manager.delete("default", undefined, "default-2")).toMatchObject({ successorId: "successor", createdDefault: false });
    expect(manager.inspect().retirements).toEqual({ default: "successor", "default-2": "successor" });
    expect(existsSync(authDir(root, "default"))).toBe(false);
  });

  test("refuses deleting the environment-selected profile", async () => {
    const root = temporaryDirectory("auth-profile-manager-delete-guards-");
    const projectRoot = join(root, "project");
    const setup = new AuthProfileManager({ userDataRoot: root, projectRoot, env: {} });
    await setup.create("Work");

    const locked = new AuthProfileManager({ userDataRoot: root, projectRoot, env: { FLYWHEEL_AUTH_PROFILE: "work" } });
    await expect(locked.delete("work", undefined, null)).rejects.toThrow("cannot delete the environment-selected auth profile");
    const byName = new AuthProfileManager({ userDataRoot: root, projectRoot, env: { FLYWHEEL_AUTH_PROFILE: "Work" } });
    await expect(byName.delete("work", undefined, null)).rejects.toThrow("cannot delete the environment-selected auth profile");
  });
});
