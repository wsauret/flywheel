import { describe, expect, test } from "bun:test";
import { dlopen, FFIType } from "bun:ffi";
import { statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { osAccount } from "../../../src/infra/os-account.js";

const FAKE_HOME = "/scratch/cell-home";
const FAKE_USER = "cell-user";

/** Sets variables in the process's native environment, which `process.env` assignments do not reach, so a lookup
 *  that reads the environment sees what a process started with them sees. Returns the restore. */
function setNativeEnvironment(variables: { readonly [name: string]: string }): () => void {
  const set = nativeSetter();
  const saved = Object.keys(variables).map((name) => [name, process.env[name]] as const);
  for (const [name, value] of Object.entries(variables)) set(name, value);
  return () => {
    for (const [name, value] of saved) set(name, value);
  };
}

function nativeSetter(): (name: string, value: string | undefined) => void {
  if (process.platform === "win32") {
    const { symbols } = dlopen("kernel32.dll", { SetEnvironmentVariableW: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 } });
    const wide = (text: string) => Buffer.from(`${text}\0`, "utf16le");
    return (name, value) => { symbols.SetEnvironmentVariableW(wide(name), value === undefined ? null : wide(value)) };
  }
  const { symbols } = dlopen(process.platform === "darwin" ? "libSystem.B.dylib" : "libc.so.6", {
    setenv: { args: [FFIType.cstring, FFIType.cstring, FFIType.i32], returns: FFIType.i32 },
    unsetenv: { args: [FFIType.cstring], returns: FFIType.i32 },
  });
  const c = (text: string) => Buffer.from(`${text}\0`);
  return (name, value) => { if (value === undefined) symbols.unsetenv(c(name)); else symbols.setenv(c(name), c(value), 1) };
}

describe("the OS account", () => {
  test("names the account's own home and user although the environment names another home, as in a benchmark cell", () => {
    const restore = setNativeEnvironment(process.platform === "win32"
      ? { HOME: FAKE_HOME, USERPROFILE: FAKE_HOME, USERNAME: FAKE_USER }
      : { HOME: FAKE_HOME, USER: FAKE_USER, LOGNAME: FAKE_USER });
    let account;
    try {
      account = osAccount();
    } finally {
      restore();
    }

    expect(account.home).not.toBe(FAKE_HOME);
    expect(account.user).not.toBe(FAKE_USER);
    expect(account.user.length).toBeGreaterThan(0);
    expect(isAbsolute(account.home) && statSync(account.home).isDirectory()).toBe(true);
  });

  test("reads the account database once for the process, because a process keeps its user id", () => {
    expect(osAccount()).toBe(osAccount());
  });
});
