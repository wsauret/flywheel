import { describe, it, expect } from "bun:test";
import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";
import { loadConfig } from "../src/orchestration/config/loader";

const FIXTURES_DIR = path.join(import.meta.dir, "fixtures");

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
      expect((err as ConfigLoadErrorLike).code).toBe("PARSE_ERROR");
      expect((err as ConfigLoadErrorLike).message).toContain("malformed.toml");
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
      expect((err as ConfigLoadErrorLike).code).toBe("FILE_NOT_FOUND");
    }
  });

  it("throws ConfigLoadError with FILE_READ_ERROR code for unreadable file", () => {
    // Create a file and make it unreadable
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "flywheel-test-"));
    const tmpFile = path.join(tmpDir, "unreadable.toml");
    fs.writeFileSync(tmpFile, "engine = 'claude'");
    fs.chmodSync(tmpFile, 0o000);

    try {
      loadConfig(tmpFile, {});
      expect(true).toBe(false);
    } catch (err) {
      expect(isConfigLoadError(err)).toBe(true);
      expect((err as ConfigLoadErrorLike).code).toBe("FILE_READ_ERROR");
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
      loadConfig(undefined, { FLYWHEEL_MAX_EVAL_CYCLES: "99" });
      expect(true).toBe(false);
    } catch (err) {
      expect(isConfigLoadError(err)).toBe(true);
      expect((err as ConfigLoadErrorLike).code).toBe("VALIDATION");
      expect((err as ConfigLoadErrorLike).message).toContain("Invalid configuration");
    }
  });
});

// ---------------------------------------------------------------------------
// Unknown key warnings
// ---------------------------------------------------------------------------

describe("loadConfig: unknown key warnings", () => {
  it("warns about unrecognized top-level keys (possible typos)", () => {
    const { warnings } = loadConfig(
      path.join(FIXTURES_DIR, "unknown-keys.toml"),
      {},
    );
    expect(warnings.some((w) => w.includes("skip_evalution"))).toBe(true);
    expect(warnings.some((w) => w.includes("tiemout_minutes"))).toBe(true);
  });

  it("does not warn about recognized keys", () => {
    const { warnings } = loadConfig(
      path.join(FIXTURES_DIR, "flywheel.toml"),
      {},
    );
    // No unknown key warnings for valid config
    expect(warnings.every((w) => !w.includes("Unrecognized"))).toBe(true);
  });
});
