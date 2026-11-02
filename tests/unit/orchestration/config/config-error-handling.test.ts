import { describe, it, expect, spyOn } from "bun:test";
import { POSIX_FAILURE_STAGING } from "../../../helpers/posix-failure-staging.js";
import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";
import { Log } from "../../../../src/infra/log";
import { loadConfig } from "../../../../src/orchestration/config/loader";
import { temporaryDirectories } from "../../../helpers/directories.js";

const FIXTURES_DIR = path.join(import.meta.dir, "../../../fixtures");
const temporaryDirectory = temporaryDirectories();

interface ConfigLoadErrorLike extends Error {
  code: string;
}

function isConfigLoadError(err: unknown): err is ConfigLoadErrorLike {
  return err instanceof Error && err.name === "ConfigLoadError" && "code" in err;
}

// ---------------------------------------------------------------------------
// Malformed TOML handling
// ---------------------------------------------------------------------------

describe("loadConfig: malformed TOML", () => {
  it("throws ConfigLoadError with PARSE_ERROR code for malformed TOML", () => {
    try {
      loadConfig(path.join(FIXTURES_DIR, "malformed.toml"), {});
      // Should not reach here
      expect(true).toBe(false);
    } catch (err) {
      expect(isConfigLoadError(err)).toBe(true);
      if (!isConfigLoadError(err)) throw err;
      expect(err.code).toBe("PARSE_ERROR");
      expect(err.message).toContain("malformed.toml");
      expect(err.message).toContain("line 1");
    }
  });

});

describe("loadConfig: parse diagnostics", () => {
  it("reports the proven TOML line without including source text", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "flywheel-parse-line-"));
    const tmpFile = path.join(tmpDir, "flywheel.toml");
    const sentinel = "PARSE_SOURCE_SENTINEL";
    fs.writeFileSync(tmpFile, `show_thinking = true\n${sentinel}\n`);
    try {
      loadConfig(tmpFile, {}, tmpDir);
      expect.unreachable();
    } catch (err) {
      expect(isConfigLoadError(err)).toBe(true);
      if (!isConfigLoadError(err)) throw err;
      expect(err.code).toBe("PARSE_ERROR");
      expect(err.message).toContain("line 2");
      expect(err.message).not.toContain(sentinel);
      expect(err.message.trimEnd().endsWith(`Configuration reference: ${path.join(tmpDir, "configuration.md")}`)).toBe(true);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// File read errors
// ---------------------------------------------------------------------------

describe("loadConfig: file read errors", () => {
  it("throws ConfigLoadError with FILE_NOT_FOUND code for missing file", () => {
    try {
      loadConfig("/nonexistent/flywheel.toml", {});
      expect(true).toBe(false);
    } catch (err) {
      expect(isConfigLoadError(err)).toBe(true);
      if (!isConfigLoadError(err)) throw err;
      expect(err.code).toBe("FILE_NOT_FOUND");
    }
  });

  it.skipIf(!POSIX_FAILURE_STAGING)("throws ConfigLoadError with FILE_READ_ERROR code for unreadable file", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "flywheel-test-"));
    const tmpFile = path.join(tmpDir, "unreadable.toml");
    fs.writeFileSync(tmpFile, "[roles.chat]\nmodel = 'test'");
    fs.chmodSync(tmpFile, 0o000);

    try {
      loadConfig(tmpFile, {});
      expect(true).toBe(false);
    } catch (err) {
      expect(isConfigLoadError(err)).toBe(true);
      if (!isConfigLoadError(err)) throw err;
      expect(err.code).toBe("FILE_READ_ERROR");
    } finally {
      // Cleanup
      fs.chmodSync(tmpFile, 0o644);
      fs.unlinkSync(tmpFile);
      fs.rmdirSync(tmpDir);
    }
  });
});

// ---------------------------------------------------------------------------
// Validation errors use ConfigLoadError
// ---------------------------------------------------------------------------

describe("loadConfig: validation errors use ConfigLoadError", () => {
  it("throws ConfigLoadError with VALIDATION code for invalid values", () => {
    try {
      loadConfig(undefined, { FLYWHEEL_QUEUE_MAX_STEPS: "many" });
      expect(true).toBe(false);
    } catch (err) {
      expect(isConfigLoadError(err)).toBe(true);
      if (!isConfigLoadError(err)) throw err;
      expect(err.code).toBe("VALIDATION");
      expect(err.message).toContain("Invalid environment overrides");
    }
  });
});

describe("loadConfig: strict diagnostics", () => {
  it("reports a malformed acknowledged release without changing the stored bytes", () => {
    const root = temporaryDirectory("release-version-config-");
    const file = path.join(root, "flywheel.toml");
    const source = 'acknowledged_release_version = "not-a-release"\n';
    fs.writeFileSync(file, source);
    expect(() => loadConfig(file, {}, root)).toThrow("acknowledged_release_version");
    expect(fs.readFileSync(file, "utf8")).toBe(source);
  });

  it("collects fatal issues in authored-path order without exposing values", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "flywheel-config-diagnostics-"));
    const tmpFile = path.join(tmpDir, "arbitrary.toml");
    const userDataRoot = path.join(tmpDir, "account");
    const secret = "CONFIG_SECRET_SENTINEL";
    fs.writeFileSync(tmpFile, [
      'diff_colors = "invalid"',
      'foreground_bash_hold_seconds = 0',
      'show_thinking = "yes"',
      'unknown_root = true',
      '[mcp.servers.bad]',
      'command = "serve"',
      'url = "https://example.test"',
      `[mcp.servers.bad.env]`,
      `TOKEN = "${secret}"`,
    ].join("\n"));
    try {
      loadConfig(tmpFile, {}, userDataRoot);
      expect.unreachable();
    } catch (err) {
      expect(isConfigLoadError(err)).toBe(true);
      if (!isConfigLoadError(err)) throw err;
      expect(err.code).toBe("VALIDATION");
      expect(err.message).not.toContain(secret);
      expect(err.message).toContain('diff_colors: found "invalid"');
      expect(err.message).toContain('foreground_bash_hold_seconds: found 0');
      expect(err.message).toContain('show_thinking: found "yes"');
      expect(err.message).toContain('foreground_bash_hold_seconds');
      expect(err.message).toContain('show_thinking');
      expect(err.message).not.toContain('unknown_root');
      expect(err.message).toContain('mcp.servers.bad');
      expect(err.message.indexOf("diff_colors")).toBeLessThan(err.message.indexOf("foreground_bash_hold_seconds"));
      expect(err.message.trimEnd().endsWith(`Configuration reference: ${path.join(userDataRoot, "configuration.md")}`)).toBe(true);
      expect(err.message.match(/Configuration reference:/g)).toHaveLength(1);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("deduplicates unmapped diagnostics from tolerated unknown keys", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "flywheel-config-unmapped-"));
    const tmpFile = path.join(tmpDir, "flywheel.toml");
    fs.writeFileSync(tmpFile, "unknown_one = true\nunknown_two = true\n");
    try {
      const result = loadConfig(tmpFile, {}, tmpDir);
      expect(result.warnings).toHaveLength(2);
      expect(result.diagnostics).toEqual([{ kind: "document", reason: "unmapped-setting" }]);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("accepts dynamic records and normalizes retired roots before strict decoding", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "flywheel-config-retired-"));
    const tmpFile = path.join(tmpDir, "flywheel.toml");
    fs.writeFileSync(tmpFile, 'disabled_modules = []\n[queue]\nmax_steps = 7\n[keybindings]\n"ctrl+x" = "quit"\n');
    try {
      const result = loadConfig(tmpFile, {}, tmpDir);
      expect(result.config.modules.length).toBeGreaterThan(0);
      expect(result.config.workflow.max_attempts).toBe(7);
      expect(result.config.keybindings["ctrl+x"]).toBe("quit");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("treats custom-provider semantics and unknown entry fields as warnings", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "flywheel-provider-diagnostics-"));
    const tmpFile = path.join(tmpDir, "flywheel.toml");
    try {
      fs.writeFileSync(tmpFile, '[custom_providers.bad]\nbase_url = "not-a-url"\nmodels = ["model"]\n');
      const warnings = loadConfig(tmpFile, {}, tmpDir).warnings;
      expect(warnings.some((warning) => warning.includes("base_url must be an http(s) URL"))).toBe(true);
      expect(warnings.join("\n")).not.toContain("not-a-url");
      fs.writeFileSync(tmpFile, '[custom_providers.bad]\nbase_url = "https://example.test"\nmodels = ["model"]\nextra = true\n');
      const tolerated = loadConfig(tmpFile, {}, tmpDir);
      expect(tolerated.warnings.some((warning) => warning.includes("custom_providers.bad.extra"))).toBe(true);
      expect(tolerated.config.custom_providers.bad?.base_url).toBe("https://example.test");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Warning visibility
// ---------------------------------------------------------------------------

describe("loadConfig: warnings reach the global log", () => {
  it("logs one closed diagnostic per warning set without authored identifiers", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "flywheel-test-"));
    const tmpFile = path.join(tmpDir, "flywheel.toml");
    const sentinel = "zz-warning-probe-secret";
    fs.writeFileSync(tmpFile, [
      `[profiles.personal.roles.${sentinel}]`,
      'model = "gpt-5.4"',
      "",
      `[profiles.personal.roles."step.${sentinel}"]`,
      'model = "gpt-5.4"',
      'provider = "anthropic_api"',
    ].join("\n"));
    const warn = spyOn(Log.create({ service: "config" }), "warn");
    try {
      const { warnings } = loadConfig(tmpFile, {});
      expect(warnings).toHaveLength(3);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(warn.mock.calls)).not.toContain(sentinel);
      expect(warn.mock.calls[0]).toEqual([
        "Configuration values were ignored or normalized",
        { code: "config-normalized", warningCount: 3 },
      ]);

      warn.mockClear();
      loadConfig(tmpFile, {});
      expect(warn.mock.calls).toBeEmpty();

      fs.writeFileSync(tmpFile, "show_thinking = true\n");
      loadConfig(tmpFile, {});
      fs.writeFileSync(tmpFile, [
        `[profiles.personal.roles.${sentinel}]`,
        'model = "gpt-5.4"',
        "",
        `[profiles.personal.roles."step.${sentinel}"]`,
        'model = "gpt-5.4"',
        'provider = "anthropic_api"',
      ].join("\n"));
      loadConfig(tmpFile, {});
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
