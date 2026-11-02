import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { POSIX_FAILURE_STAGING } from "../../../helpers/posix-failure-staging.js";
import { POSIX_FILE_MODES } from "../../../helpers/posix-modes.js";
import { mkdirSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { loadConfig } from "../../../../src/orchestration/config/loader.js";
import { DEFAULT_PROACTIVE_COMPACTION_THRESHOLD, DEFAULT_THEME_SELECTION, MIN_PROACTIVE_COMPACTION_THRESHOLD } from "../../../../src/orchestration/config/defaults.js";
import { ConfigWriteError, PERSISTED_SETTING_WRITERS, migrateLegacyModelSpellings, migrateModelAssignments, patchProfileBoolean, patchProfileProviderSetting, resetModalSettings, seedConfigDefaults, setAuthProjectProfile, updateAutoInstall, updateDiffColors, updateProactiveCompactionThreshold, updateShowThinking, updateThemeSelection } from "../../../../src/orchestration/config/writer.js";
import { profileBooleanSettingDefinition } from "../../../../src/orchestration/config/setting-definitions.js";

async function withConfig(source: string, run: (path: string, dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "flywheel-settings-"));
  try {
    const path = join(dir, "flywheel.toml");
    await writeFile(path, source);
    await run(path, dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function occurrences(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

describe("config settings persistence", () => {
  test("migrates role model assignments to dotted identities without disturbing other TOML", async () => {
    const source = '# keep\nnotes = """model = "claude-opus-4-7"\n"""\n\n[profiles.personal.roles.chat]\nmodel = " Vendor/Model-1-2 " # role\n\n[profiles."work profile".roles.reviewer]\nmodel = "gpt-6-1-sol-20260901"\n\n[profiles.work.roles.explorer]\nmodel = "claude-sonnet-4-20250514"\n\n[profiles.work.roles.implementer]\nmodel = "claude-opus-4-6-2026-02-01"\n\n[model_efforts]\n"claude-opus-4-6-20260101" = "low"\n"claude-opus-4-6-20260201" = "high" # newest\n"gpt-6-1-sol" = "medium" # stable\n"gpt-6-1-sol-2026-03-01" = "max"\n';
    await withConfig(source, async (path) => {
      expect(migrateModelAssignments({ configPath: path })).toEqual({ ok: true });

      const migrated = await readFile(path, "utf8");
      expect(migrated).toContain('# keep\nnotes = """model = "claude-opus-4-7"\n"""');
      expect(migrated).toContain('model = " Vendor/Model-1.2 " # role');
      expect(migrated).toContain('model = "gpt-6.1-sol"');
      expect(migrated).toContain('model = "claude-sonnet-4"');
      expect(migrated).toContain('model = "claude-opus-4.6"');
      expect(Bun.TOML.parse(migrated)).not.toHaveProperty("model_efforts");
      expect(migrated).not.toMatch(/20260101|20260201|2026-03-01/);

      expect(migrateModelAssignments({ configPath: path })).toEqual({ ok: true });
      expect(await readFile(path, "utf8")).toBe(migrated);
    });
  });

  test("converts pins saved with a dotted parameter size only when the catalog names one model", async () => {
    const source = '[profiles.work.roles.chat]\nmodel = "qwen3.8b" # pinned\n\n[profiles.work.roles.reviewer]\nmodel = "llama-3.3.70b-instruct"\n\n[profiles.work.roles.explorer]\nmodel = "qwen3.5.0.8b"\n\n[profiles.work.roles.implementer]\nmodel = "glm-4.5v"\n\n[model_efforts]\n"qwen3.8b" = "high"\n"llama-3.3.70b-instruct" = "low"\n"llama-3.3-70b-instruct" = "max"\n';
    const catalog = new Map(["qwen3-8b", "llama-3.3-70b-instruct", "qwen3.5-0.8b", "glm-4.5v"].map((model) => [model, [model]]));
    await withConfig(source, async (path) => {
      expect(await migrateLegacyModelSpellings({ configPath: path }, catalog)).toEqual({ ok: true, rewritten: true });

      const migrated = await readFile(path, "utf8");
      expect(migrated).toContain('model = "qwen3-8b" # pinned');
      expect(Bun.TOML.parse(migrated)).toEqual({
        profiles: { work: { roles: { chat: { model: "qwen3-8b" }, explorer: { model: "qwen3.5-0.8b" }, implementer: { model: "glm-4.5v" }, reviewer: { model: "llama-3.3-70b-instruct" } } } },
      });
      expect(await migrateLegacyModelSpellings({ configPath: path }, catalog)).toEqual({ ok: true, rewritten: false });
      expect(await readFile(path, "utf8")).toBe(migrated);
    });
  });

  test.each([
    ["two catalog models share its dotted former spelling", "m-1.2.3b", new Map<string, string[]>([["m-1-2.3b", []], ["m-1.2-3b", []]])],
    ["two catalog models serve its former wire", "deepseek-v4-flash", new Map<string, string[]>([["deepseek-v4-flash-0420", ["deepseek-v4-flash"]], ["deepseek-v4.1-flash-1017", ["deepseek-v4-flash"]]])],
    // A model that no signed-in account lists arrives without wires, and it still names the pin.
    ["it is itself a catalog model that another model's wire spells", "deepseek-v4-pro", new Map<string, string[]>([["deepseek-v4-pro-0813", ["deepseek-v4-pro"]], ["deepseek-v4-pro", []]])],
  ])("leaves a pin alone when %s", async (_name, model, catalog) => {
    const source = `[profiles.work.roles.chat]\nmodel = "${model}"\n`;
    await withConfig(source, async (path) => {
      expect(await migrateLegacyModelSpellings({ configPath: path }, catalog)).toEqual({ ok: true, rewritten: false });
      expect(await readFile(path, "utf8")).toBe(source);
    });
  });

  test("converts OpenCode Go pins saved under a free wire to the model that now owns the wire", async () => {
    const source = '[profiles.work.roles.chat]\nmodel = "beam-free"\n\n[profiles.work.roles.reviewer]\nmodel = "minimax-m3.1-flash-free"\n\n[profiles.work.roles.explorer]\nmodel = "space-bunny"\n';
    const catalog = new Map([
      ["beam-1.0-501b-a23b", ["beam-free"]],
      ["minimax-m3.1-flash", ["minimax-m3.1-flash", "minimax-m3.1-flash-free"]],
      ["space-bunny", ["space-bunny"]],
    ]);
    await withConfig(source, async (path) => {
      expect(await migrateLegacyModelSpellings({ configPath: path }, catalog)).toEqual({ ok: true, rewritten: true });
      expect(Bun.TOML.parse(await readFile(path, "utf8"))).toEqual({
        profiles: { work: { roles: { chat: { model: "beam-1.0-501b-a23b" }, explorer: { model: "space-bunny" }, reviewer: { model: "minimax-m3.1-flash" } } } },
      });
    });
  });

  test("retires semantic model effort forms without changing profile role efforts", async () => {
    const fixtures = [
      '[model_efforts] # remembered\n"gpt-6-luna" = "high"\n',
      '["model_efforts"]\n"gpt-6-luna" = "high"\n',
      'model_efforts = { "gpt-6-luna" = "high" }\n',
      'model_efforts."gpt-6-luna" = "high"\n',
    ];
    const siblings = '[profiles.personal.roles.chat]\nmodel = "gpt-6-luna"\neffort = "low"\n[profiles.other.roles.explorer]\neffort = "medium"\n';
    for (const source of fixtures) {
      await withConfig(`${source}${siblings}`, async (path) => {
        expect(migrateModelAssignments({ configPath: path })).toEqual({ ok: true });
        const migrated = await readFile(path, "utf8");
        expect(migrated).toBe(siblings);
        expect(migrateModelAssignments({ configPath: path })).toEqual({ ok: true });
        expect(await readFile(path, "utf8")).toBe(migrated);
      });
    }
  });

  test("appends an absent setting without changing multiline string bytes", async () => {
    const source = 'notes = """before \\"""\ntheme = "inside"\nafter"""\n';
    expect(() => Bun.TOML.parse(source)).not.toThrow();
    await withConfig(source, async (path) => {
      expect(updateThemeSelection("aura", { configPath: path })).toEqual({ ok: true });
      expect(await readFile(path, "utf8")).toBe(`${source}theme = "aura"\n`);
    });
  });

  test("resets modal-owned config values without changing roles", async () => {
    await withConfig('theme = "aura"\nshow_thinking = true\ndiff_colors = "standard"\nproactive_compaction_threshold = 500000\nfeatures = ["skills"]\n\n[profiles.personal.roles.chat]\nmodel = "gpt-5.4-mini"\n\n[updates]\nauto_install = false\n\n[web_search]\nprovider = "exa"\n', async (path) => {
      expect(resetModalSettings({ configPath: path })).toEqual({ ok: true });

      const text = await readFile(path, "utf8");
      const config = loadConfig(path, {}).config;
      expect(config.theme).toBe(DEFAULT_THEME_SELECTION);
      expect(config.show_thinking).toBe(false);
      expect(config.diff_colors).toBe("theme");
      expect(config.proactive_compaction_threshold).toBe(DEFAULT_PROACTIVE_COMPACTION_THRESHOLD);
      expect(config.web_search.provider).toBe("chatgpt");
      expect(text).toContain('[profiles.personal.roles.chat]\nmodel = "gpt-5.4-mini"');
      expect(text).toContain('features = ["skills"]');
      expect(text).toContain("auto_install = false");
    });
  });

  test("persists and resets the Write syntax theme at the TOML root", async () => {
    await withConfig("", async (path) => {
      const writer = PERSISTED_SETTING_WRITERS.get("writeSyntaxTheme");
      if (writer === undefined) throw new Error("expected Write syntax theme writer");
      expect(writer("vesper", { configPath: path })).toEqual({ ok: true });
      expect(await readFile(path, "utf8")).toContain('write_syntax_theme = "vesper"');
      expect(loadConfig(path, {}).config.write_syntax_theme).toBe("vesper");

      expect(resetModalSettings({ configPath: path })).toEqual({ ok: true });
      expect(loadConfig(path, {}).config.write_syntax_theme).toBe("nord");
    });
  });

  test("persists proactive compaction threshold as a bare TOML root number before sections", async () => {
    await withConfig('[profiles.personal.roles.chat]\nmodel = "gpt-5.4-mini"\n', async (path) => {
      updateProactiveCompactionThreshold(300_000, { configPath: path });

      const text = await readFile(path, "utf8");
      expect(text).toContain("proactive_compaction_threshold = 300000");
      expect(text).not.toContain('proactive_compaction_threshold = "300000"');
      expect(text.indexOf("proactive_compaction_threshold = 300000")).toBeLessThan(text.indexOf("[profiles.personal.roles.chat]"));
      expect(loadConfig(path, {}).config.proactive_compaction_threshold).toBe(300_000);
    });
  });

  test("rejects proactive compaction thresholds below the safe floor as a typed failure without writing", async () => {
    await withConfig("proactive_compaction_threshold = 270000\n", async (path) => {
      // The runtime write reaches us from a live TUI handler, so an invalid value
      // is a typed failure value -- not a throw into the reactive handler -- and
      // the failed write leaves the file untouched.
      const result = updateProactiveCompactionThreshold(MIN_PROACTIVE_COMPACTION_THRESHOLD - 1, { configPath: path })
      expect(result.ok).toBe(false)
      if (result.ok) throw new Error("expected a failed write")
      expect(result.error).toBeInstanceOf(ConfigWriteError)
      expect(result.error._tag).toBe("ConfigWriteError")
      expect(result.error.message.length).toBeGreaterThan(0)
      expect(await readFile(path, "utf8")).toBe("proactive_compaction_threshold = 270000\n")
    })
  })

  test("persists a zero threshold as the proactive compaction opt-out", async () => {
    await withConfig("", async (path) => {
      expect(updateProactiveCompactionThreshold(0, { configPath: path })).toEqual({ ok: true })
      expect(loadConfig(path, {}).config.proactive_compaction_threshold).toBe(0)
    })
  })


  test("patches profile caps without disturbing comments, attribution, or roles", () => {
    const source = "# account\n[profiles.work]\ngit_ai_attribution = true # keep\n\n[profiles.work.roles.review]\nmodel = \"gpt-5.4-mini\"\n";
    const patched = patchProfileProviderSetting(source, "work", "github_copilot", "monthly_credit_cap", 0);
    expect(patched).toContain("# account");
    expect(patched).toContain("git_ai_attribution = true # keep");
    expect(patched).toContain('[profiles.work.roles.review]\nmodel = "gpt-5.4-mini"');
    expect(Bun.TOML.parse(patched)).toMatchObject({ profiles: { work: { providers: { github_copilot: { monthly_credit_cap: 0 } } } } });
  });

  test("persists profile Git AI attribution without disturbing role overlays", async () => {
    const source = '[profiles."work profile".roles.review]\nmodel = "gpt-5.4-mini"\n';
    const enabled = patchProfileBoolean(source, "work profile", profileBooleanSettingDefinition("gitAiAttribution"), true);

    expect(enabled).toContain('[profiles."work profile"]\ngit_ai_attribution = true');
    expect(enabled).toContain('[profiles."work profile".roles.review]\nmodel = "gpt-5.4-mini"');
    expect(Bun.TOML.parse(enabled)).toMatchObject({ profiles: { "work profile": { git_ai_attribution: true, roles: { review: { model: "gpt-5.4-mini" } } } } });

    const disabled = patchProfileBoolean(enabled, "work profile", profileBooleanSettingDefinition("gitAiAttribution"), false);
    expect(disabled).toBe(source);
  });

  test("prunes only an otherwise-empty profile overlay when attribution is disabled", () => {
    expect(patchProfileBoolean("[profiles.work]\ngit_ai_attribution = true\n", "work", profileBooleanSettingDefinition("gitAiAttribution"), false)).toBe("");
    expect(patchProfileBoolean("[profiles.other]\ngit_ai_attribution = true\n", "work", profileBooleanSettingDefinition("gitAiAttribution"), false)).toBe("[profiles.other]\ngit_ai_attribution = true\n");
  });

  test("does not seed or recognize the retired root Copilot cap", async () => {
    await withConfig("[providers.github_copilot]\nmonthly_credit_cap = 1200\n", async (path) => {
      expect(seedConfigDefaults({ configPath: path })).toEqual({ ok: true });
      expect(loadConfig(path, {}).config.profiles).toEqual({});
      expect(await readFile(path, "utf8")).toContain("monthly_credit_cap = 1200");
    });
  });


  test("preserves authored TOML forms when updating a semantic setting", async () => {
    const fixtures = [
      ['web_search.provider = "chatgpt" # choice\nshow_thinking = true\n', 'web_search.provider = "exa" # choice\nshow_thinking = true\n'],
      ['web_search = { provider = "chatgpt", timeout = 7 }\n', 'web_search = { provider = "exa", timeout = 7 }\n'],
      ['["web_search"]\n\'provider\' = "chatgpt"\n', '["web_search"]\n\'provider\' = "exa"\n'],
    ] as const;
    for (const [source, expected] of fixtures) {
      await withConfig(source, async (path) => {
        const writer = PERSISTED_SETTING_WRITERS.get("webSearchProvider");
        if (writer === undefined) throw new Error("expected web search provider writer");
        expect(writer("exa", { configPath: path })).toEqual({ ok: true });
        expect(await readFile(path, "utf8")).toBe(expected);
      });
    }
  });


  test("refuses competing semantic authorities without writing", async () => {
    const source = 'web_search.provider = "exa"\n\n[web_search]\nprovider = "chatgpt"\n';
    await withConfig(source, async (path) => {
      const writer = PERSISTED_SETTING_WRITERS.get("webSearchProvider");
      if (writer === undefined) throw new Error("expected web search provider writer");
      expect(writer("exa", { configPath: path }).ok).toBe(false);
      expect(await readFile(path, "utf8")).toBe(source);
    });
  });


  test.skipIf(!POSIX_FAILURE_STAGING)("fsyncs the config directory after rename", async () => {
    const fs = await import("node:fs")
    await withConfig('[roles.chat]\nmodel = "gpt-5.4-mini"\n', async (path) => {
      const original = fs.fsyncSync
      let syncedDirectory = false
      const fsync = spyOn(fs, "fsyncSync").mockImplementation((fd) => {
        if (fs.fstatSync(fd).isDirectory()) syncedDirectory = true
        return original(fd)
      })
      try {
        expect(updateShowThinking(false, { configPath: path })).toEqual({ ok: true })
        expect(syncedDirectory).toBe(true)
      } finally {
        fsync.mockRestore()
      }
    })
  })

  test("composes settings updates from an empty file", async () => {
    await withConfig("", async (path) => {
      updateShowThinking(false, { configPath: path });
      updateDiffColors("standard", { configPath: path });
      updateProactiveCompactionThreshold(300_000, { configPath: path });

      const text = await readFile(path, "utf8");
      expect(text).toContain("show_thinking = false");
      expect(text).toContain('diff_colors = "standard"');
      expect(text).toContain("proactive_compaction_threshold = 300000");
      expect(text).not.toContain('show_thinking = "false"');

      const config = loadConfig(path, {}).config;
      expect(config.show_thinking).toBe(false);
      expect(config.diff_colors).toBe("standard");
      expect(config.proactive_compaction_threshold).toBe(300_000);
    });
  });

  test("TOML with legacy openai_auth/openai_email fields parses without error", async () => {
    await withConfig('openai_auth = "chatgpt"\nopenai_email = "person@example.com"\n', async (path) => {
      const { config } = loadConfig(path, {});
      expect("openai_auth" in config).toBe(false);
      expect("openai_email" in config).toBe(false);
    });
  });

  test("a retired intro_hints_seen_version key loads silently and leaves the tabs hint visible", async () => {
    await withConfig('intro_hints_seen_version = "0.9.0"\n', async (path) => {
      const { config, warnings } = loadConfig(path, {});
      expect(warnings).toEqual([]);
      expect(config.tabs_hint_dismissed).toBe(false);
    });
  });

  for (const summarize of [true, false]) test(`retired compaction settings (summarize_compaction = ${summarize}) and roles load and accept settings writes silently`, async () => {
    await withConfig([
      `summarize_compaction = ${summarize}`,
      "",
      "[roles.compactor]",
      'model = "gpt-5.4-mini"',
      "",
      "[roles.summarizer]",
      'model = "gpt-5.4-mini"',
      "",
      "[profiles.work.roles.compactor]",
      'model = "gpt-5.4-mini"',
      "",
      "[profiles.work.roles.summarizer]",
      'model = "gpt-5.4-mini"',
      "",
    ].join("\n"), async (path) => {
      const { config, warnings } = loadConfig(path, {});
      expect(warnings).toEqual([]);
      expect("summarize_compaction" in config).toBe(false);
      expect(config).not.toHaveProperty("roles");
      expect(config.profiles.work?.roles.compactor).toBeUndefined();
      expect(config.profiles.work?.roles.summarizer).toBeUndefined();
      expect(updateShowThinking(true, { configPath: path })).toEqual({ ok: true });
      const reloaded = loadConfig(path, {});
      expect(reloaded.warnings).toEqual([]);
      expect(reloaded.config.show_thinking).toBe(true);
      expect("summarize_compaction" in reloaded.config).toBe(false);
      expect(reloaded.config).not.toHaveProperty("roles");
    });
  });

  test("persists updates.auto_install in its own section", async () => {
    await withConfig('show_thinking = true\n\n[roles.chat]\nmodel = "gpt-5.4-mini"\n', async (path) => {
      expect(updateAutoInstall(false, { configPath: path })).toEqual({ ok: true });

      const text = await readFile(path, "utf8");
      expect(text).toContain("[updates]\nauto_install = false");
      expect(text).not.toContain('auto_install = "false"');
      expect(occurrences(text, "[updates]")).toBe(1);
      expect(loadConfig(path, {}).config.updates.auto_install).toBe(false);

      expect(updateAutoInstall(true, { configPath: path })).toEqual({ ok: true });
      expect(occurrences(await readFile(path, "utf8"), "[updates]")).toBe(1);
      expect(loadConfig(path, {}).config.updates.auto_install).toBe(true);
    });
  });

  test("auto-install defaults to true when the config states nothing", async () => {
    await withConfig("show_thinking = true\n", async (path) => {
      expect(loadConfig(path, {}).config.updates.auto_install).toBe(true);
    });
  });

  test("seeds updates.auto_install as true and never overwrites an explicit false", async () => {
    await withConfig("", async (path) => {
      expect(seedConfigDefaults({ configPath: path })).toEqual({ ok: true });
      expect(await readFile(path, "utf8")).toContain("[updates]\nauto_install = true");
      expect(loadConfig(path, {}).config.updates.auto_install).toBe(true);
    });
    await withConfig("[updates]\nauto_install = false\n", async (path) => {
      expect(seedConfigDefaults({ configPath: path })).toEqual({ ok: true });
      expect(occurrences(await readFile(path, "utf8"), "auto_install")).toBe(1);
      expect(loadConfig(path, {}).config.updates.auto_install).toBe(false);
    });
  });

});

describe("auth project profile persistence", () => {
  test("round-trips quoted and escaped project roots across repeated writes and renames", async () => {
    await withConfig("", async (path) => {
      const projectRoot = 'C:\\work\\project "quoted"';
      expect(setAuthProjectProfile(projectRoot, "stable-id", { configPath: path })).toEqual({ ok: true });
      expect(setAuthProjectProfile(projectRoot, "stable-id", { configPath: path })).toEqual({ ok: true });

      const parsed = Bun.TOML.parse(await readFile(path, "utf8"));
      expect(parsed).toEqual({ auth: { project_profiles: { [projectRoot]: "stable-id" } } });
    });
  });
});


describe("the commit point of a settings write", () => {
  test.skipIf(!POSIX_FAILURE_STAGING)("reports a committed change whose durability failed, and leaves the new text in the file", async () => {
    const fs = await import("node:fs")
    await withConfig("show_thinking = true\n", async (path) => {
      const original = fs.fsyncSync
      // The one sync that fails is the publication's own: the directory is
      // synced while the file already holds the new text, so the rename landed
      // and the change is visible. Later syncs of the lock protocol succeed, so
      // this case is the durability gap alone.
      let failed = false
      const fsync = spyOn(fs, "fsyncSync").mockImplementation((fd) => {
        const published = fs.fstatSync(fd).isDirectory() && fs.readFileSync(path, "utf8").includes("show_thinking = false")
        if (published && !failed) {
          failed = true
          throw new Error("directory sync boom")
        }
        return original(fd)
      })
      try {
        const result = updateShowThinking(false, { configPath: path })
        expect(result.ok).toBe(true)
        if (!result.ok) throw new Error("expected a committed write")
        expect(result.durabilityError?.message).toContain("directory sync boom")
      } finally {
        fsync.mockRestore()
      }
      expect(await readFile(path, "utf8")).toContain("show_thinking = false")
      expect(loadConfig(path, {}).config.show_thinking).toBe(false)
    })
  })
})

describe("the private config boundary", () => {
  const originalUmask = process.umask(0o022);

  afterEach(() => {
    process.umask(originalUmask);
  });

  for (const umask of [0o000, 0o022]) {
    test(`writes the config 0600 inside a 0700 directory under umask ${umask.toString(8).padStart(3, "0")}`, async () => {
      const home = await mkdtemp(join(tmpdir(), "flywheel-config-modes-"));
      try {
        process.umask(umask);
        const userDataRoot = join(home, ".flywheel");
        expect(seedConfigDefaults({ userDataRoot })).toEqual({ ok: true });

        if (POSIX_FILE_MODES) expect(statSync(userDataRoot).mode & 0o777).toBe(0o700);
        if (POSIX_FILE_MODES) expect(statSync(join(userDataRoot, "flywheel.toml")).mode & 0o777).toBe(0o600);
      } finally {
        await rm(home, { recursive: true, force: true });
      }
    });
  }

  test("refuses a config file that is a symlink, and writes nothing through it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "flywheel-config-link-"));
    try {
      const outside = join(dir, "outside.toml");
      writeFileSync(outside, "show_thinking = true\n");
      const configPath = join(dir, "flywheel.toml");
      symlinkSync(outside, configPath);

      const result = updateShowThinking(false, { configPath });
      expect(result.ok).toBe(false);
      expect(await readFile(outside, "utf8")).toBe("show_thinking = true\n");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("refuses a config directory that is a symlink, and writes nothing through it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "flywheel-config-dir-link-"));
    try {
      const outside = join(dir, "outside");
      mkdirSync(outside);
      symlinkSync(outside, join(dir, "linked"));

      const result = updateShowThinking(false, { configPath: join(dir, "linked", "flywheel.toml") });
      expect(result.ok).toBe(false);
      expect(await readFile(join(outside, "flywheel.toml"), "utf8").catch(() => "absent")).toBe("absent");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("keeps config secrets out of a failed write error", async () => {
    await withConfig('[providers.anthropic]\napi_key = "sk-ant-secret-value"\n', async (path) => {
      const result = updateProactiveCompactionThreshold(MIN_PROACTIVE_COMPACTION_THRESHOLD - 1, { configPath: path });
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected a failed write");
      expect(result.error.message).not.toContain("sk-ant-secret-value");
    });
  });
});
