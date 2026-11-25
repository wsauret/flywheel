import { CString, dlopen, FFIType, ptr, read, type Pointer } from "bun:ffi";
import { bindLibc } from "./libc.js";

/** The OS account this process runs as. */
export interface OsAccount {
  /** The account's own home directory, as the account database records it. */
  readonly home: string;
  /** The account's login name. */
  readonly user: string;
}

/** The account of this process, once a read succeeded. */
let account: OsAccount | undefined;

/**
 * Reads the OS account of this process from the account database, never from the environment. A process can run
 * with a `HOME` or `USER` of its own, such as a benchmark cell, and a caller that must name the real account, such
 * as the user that names the Claude CLI's keychain item, reads it here. Bun's `os.userInfo()` and `os.homedir()`
 * return `HOME` and `USER` from the environment, so neither can serve here.
 *
 * On macOS and Linux it reads the `passwd` entry of the real user id (`getpwuid`), which covers directory-service
 * and NSS accounts too. On Windows it reads the profile directory and the user name of the process token
 * (`GetUserProfileDirectoryW`, `GetUserNameW`), which do not read `USERPROFILE` or `USERNAME`. Throws when the
 * account database has no entry for the process, as in a container that runs an unnamed user id.
 *
 * A process keeps its user id, so the first successful read serves every later call and the C library loads once.
 */
export function osAccount(): OsAccount {
  account ??= process.platform === "win32" ? windowsAccount() : posixAccount();
  return account;
}

/** The offset of `pw_dir` in `struct passwd` on 64-bit targets. Darwin puts `pw_change` and `pw_class` before
 *  `pw_gecos`; glibc and musl do not. `pw_name` is first on both. */
const PW_DIR_OFFSET = process.platform === "darwin" ? 48 : 32;

function posixAccount(): OsAccount {
  const libc = bindLibc({ getpwuid: { args: [FFIType.u32], returns: FFIType.ptr } });
  if (libc === undefined) throw new Error(`This platform (${process.platform}) has no C library that reads the account database`);
  const uid = process.getuid?.() ?? 0;
  const entry = libc.getpwuid(uid);
  if (entry === null) throw new Error(`The account database has no entry for user id ${uid}`);
  // SAFETY: getpwuid returned a live entry whose string fields are terminated C strings; both are copied before
  // any other account database call can reuse the entry.
  return { user: cString(read.ptr(entry, 0)), home: cString(read.ptr(entry, PW_DIR_OFFSET)) };
}

function cString(address: number): string {
  // SAFETY: the address is a string field of the entry getpwuid returned, read before any other account call.
  // oxlint-disable-next-line typescript/consistent-type-assertions -- boundary: an address read from a libc account entry
  return String(new CString(address as Pointer));
}

/** `TOKEN_QUERY`, the access that both token reads need. */
const TOKEN_QUERY = 8;
/** `UNLEN` and `MAX_PATH` with room to spare; a larger value fails with a stated error rather than truncating. */
const WIDE_BUFFER_CHARACTERS = 1024;

function windowsAccount(): OsAccount {
  const kernel32 = dlopen("kernel32.dll", {
    GetCurrentProcess: { args: [], returns: FFIType.ptr },
    CloseHandle: { args: [FFIType.ptr], returns: FFIType.i32 },
    GetLastError: { args: [], returns: FFIType.u32 },
  });
  const advapi32 = dlopen("advapi32.dll", {
    OpenProcessToken: { args: [FFIType.ptr, FFIType.u32, FFIType.ptr], returns: FFIType.i32 },
    GetUserNameW: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
  });
  const userenv = dlopen("userenv.dll", { GetUserProfileDirectoryW: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 } });
  try {
    // oxlint-disable-next-line unicorn/throw-new-error -- boundary: GetLastError reads a Win32 error code, not an error constructor
    const failed = (call: string) => new Error(`${call} failed (Windows error ${kernel32.symbols.GetLastError()})`);
    const wideCall = (call: string, fill: (buffer: Buffer, size: Uint32Array) => number): string => {
      const buffer = Buffer.alloc(WIDE_BUFFER_CHARACTERS * 2);
      const size = new Uint32Array([WIDE_BUFFER_CHARACTERS]);
      if (fill(buffer, size) === 0) throw failed(call);
      // GetUserProfileDirectoryW does not promise to report the length it wrote, so the string ends at its NUL.
      const [text = ""] = buffer.toString("utf16le").split("\0", 1);
      return text;
    };
    const token = new BigUint64Array(1);
    if (advapi32.symbols.OpenProcessToken(kernel32.symbols.GetCurrentProcess(), TOKEN_QUERY, ptr(token)) === 0) throw failed("OpenProcessToken");
    // SAFETY: OpenProcessToken returned this owned handle; the finally below releases it once.
    // oxlint-disable-next-line typescript/consistent-type-assertions -- boundary: a handle returned by the Windows security API
    const handle = Number(token[0]) as Pointer;
    try {
      return {
        home: wideCall("GetUserProfileDirectoryW", (buffer, size) => userenv.symbols.GetUserProfileDirectoryW(handle, ptr(buffer), ptr(size))),
        user: wideCall("GetUserNameW", (buffer, size) => advapi32.symbols.GetUserNameW(ptr(buffer), ptr(size))),
      };
    } finally {
      kernel32.symbols.CloseHandle(handle);
    }
  } finally {
    userenv.close();
    advapi32.close();
    kernel32.close();
  }
}
