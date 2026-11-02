import { describe, expect, test } from "bun:test";
import { engineShell, type ShellProbe } from "../../../../../src/orchestration/modules/provider-claude-agent-sdk/engine-environment.js";

const WINDOWS_PATH = "C:\\Tools\\Git\\cmd;C:\\Windows\\System32";

/** A machine that holds exactly `files`, and `git` at `git` on the PATH that the engine reads. */
function machine(files: readonly string[], git?: string): ShellProbe {
  return {
    exists: (path) => files.includes(path),
    which: (command, path) => (command === "git" && path === WINDOWS_PATH ? git ?? null : null),
  };
}
const windows = { platform: "win32", hostEnvironment: { PATH: WINDOWS_PATH } } as const;

describe("the shell that the engine names", () => {
  test("on Windows is bash when Git Bash is at a fixed install path", () => {
    expect(engineShell(windows, machine(["C:\\Program Files\\Git\\bin\\bash.exe"]))).toBe("bash");
    expect(engineShell(windows, machine(["C:\\Program Files (x86)\\Git\\bin\\bash.exe"]))).toBe("bash");
  });

  test("on Windows is bash when the bin folder two levels above the engine's git holds bash.exe", () => {
    expect(engineShell(windows, machine(["C:\\Tools\\Git\\bin\\bash.exe"], "C:\\Tools\\Git\\cmd\\git.exe"))).toBe("bash");
  });

  test("on Windows is PowerShell when the engine finds no Git Bash", () => {
    expect(engineShell(windows, machine([]))).toBe("PowerShell");
    expect(engineShell(windows, machine([], "C:\\Tools\\Git\\cmd\\git.exe"))).toBe("PowerShell");
  });

  test("on macOS and Linux is the canonical reminder's, so it states none", () => {
    const everything = machine(["C:\\Program Files\\Git\\bin\\bash.exe"], "C:\\Tools\\Git\\cmd\\git.exe");
    expect(engineShell({ platform: "darwin", hostEnvironment: { PATH: WINDOWS_PATH } }, everything)).toBeUndefined();
    expect(engineShell({ platform: "linux", hostEnvironment: { PATH: WINDOWS_PATH } }, everything)).toBeUndefined();
  });
});
