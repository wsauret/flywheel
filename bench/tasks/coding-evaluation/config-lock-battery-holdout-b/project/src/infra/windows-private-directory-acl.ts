import { dlopen, FFIType, ptr, type Pointer, toArrayBuffer } from "bun:ffi";
import { trustedProbeLaunch } from "./process-container.js";

const SID_TIMEOUT_MS = 2_000;
const ACL_TIMEOUT_MS = 2_000;
const SID_PATTERN = /\bS-\d-\d+(?:-\d+)+\b/;


export interface WindowsPrivateDirectoryAclCommandResult {
  readonly success: boolean;
  readonly stdout: string;
}

export interface WindowsPrivateDirectoryAclOperations {
  readonly platform: NodeJS.Platform;
  readonly nativeAcl: () => WindowsPrivateDirectoryAclPort;
}

interface WindowsPrivateDirectoryAclVerifierOperations {
  readonly platform: NodeJS.Platform;
  readonly run: (argv: readonly string[], timeoutMs: number) => WindowsPrivateDirectoryAclCommandResult;
}

export type WindowsPrivateDirectoryAclPort = (directoryPath: string) => void;
export type WindowsPrivateDirectoryAclAsyncPort = (directoryPath: string) => Promise<void>;

/** Bind only when a Windows root is admitted. The copied ACL outlives the OS descriptor. */
function nativeAcl(): WindowsPrivateDirectoryAclPort {
  const advapi32 = dlopen("advapi32.dll", {
    OpenProcessToken: { args: [FFIType.ptr, FFIType.u32, FFIType.ptr], returns: FFIType.i32 },
    GetTokenInformation: { args: [FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.u32, FFIType.ptr], returns: FFIType.i32 },
    ConvertSidToStringSidW: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
    ConvertStringSecurityDescriptorToSecurityDescriptorW: { args: [FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
    GetSecurityDescriptorDacl: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
    GetNamedSecurityInfoW: { args: [FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.u32 },
    GetSecurityDescriptorControl: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
    SetNamedSecurityInfoW: { args: [FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.u32 },
  });
  let acl: Buffer;
  try {
    const kernel32 = dlopen("kernel32.dll", {
      GetCurrentProcess: { args: [], returns: FFIType.ptr },
      CloseHandle: { args: [FFIType.ptr], returns: FFIType.i32 },
      lstrlenW: { args: [FFIType.ptr], returns: FFIType.i32 },
      LocalFree: { args: [FFIType.ptr], returns: FFIType.ptr },
      GetLastError: { args: [], returns: FFIType.u32 },
    });
    try {
      const token = new BigUint64Array(1);
      const sidString = new BigUint64Array(1);
      let sid: string;
      try {
        if (advapi32.symbols.OpenProcessToken(kernel32.symbols.GetCurrentProcess(), 8, ptr(token)) === 0) {
          // oxlint-disable-next-line unicorn/throw-new-error -- boundary: GetLastError reads a Win32 error code, not an error constructor
          const code = kernel32.symbols.GetLastError();
          throw new Error(`Cannot open current process token (Windows error ${code})`);
        }
        // SAFETY: OpenProcessToken returned this owned handle; CloseHandle below releases it.
        // oxlint-disable-next-line typescript/consistent-type-assertions -- boundary: an address returned by the Windows security API
        const handle = Number(token[0]) as Pointer;
        const length = Buffer.alloc(4);
        const result = advapi32.symbols.GetTokenInformation(handle, 1, null, 0, ptr(length));
        // oxlint-disable-next-line unicorn/throw-new-error -- boundary: GetLastError reads a Win32 error code, not an error constructor
        const sizeError = kernel32.symbols.GetLastError();
        if (result !== 0 || sizeError !== 122) throw new Error(`Cannot size current process token (Windows error ${sizeError})`);
        const user = Buffer.alloc(length.readUInt32LE(0));
        if (advapi32.symbols.GetTokenInformation(handle, 1, ptr(user), user.length, ptr(length)) === 0) {
          // oxlint-disable-next-line unicorn/throw-new-error -- boundary: GetLastError reads a Win32 error code, not an error constructor
          const code = kernel32.symbols.GetLastError();
          throw new Error(`Cannot read current process token (Windows error ${code})`);
        }
        // SAFETY: TOKEN_USER starts with a SID pointer owned by the live user buffer.
        // oxlint-disable-next-line typescript/consistent-type-assertions -- boundary: an address returned by the Windows security API
        const sidAddress = Number(user.readBigUInt64LE(0)) as Pointer;
        if (advapi32.symbols.ConvertSidToStringSidW(sidAddress, ptr(sidString)) === 0) {
          // oxlint-disable-next-line unicorn/throw-new-error -- boundary: GetLastError reads a Win32 error code, not an error constructor
          const code = kernel32.symbols.GetLastError();
          throw new Error(`Cannot convert current account SID (Windows error ${code})`);
        }
        // SAFETY: conversion allocated a terminated UTF-16 string; copy it before LocalFree releases it.
        // oxlint-disable-next-line typescript/consistent-type-assertions -- boundary: an address returned by the Windows security API
        const address = Number(sidString[0]) as Pointer;
        sid = Buffer.from(toArrayBuffer(address, 0, kernel32.symbols.lstrlenW(address) * 2)).toString("utf16le");
      } finally {
        // SAFETY: only successful native allocations populate these slots; each is released exactly once.
        // oxlint-disable-next-line typescript/consistent-type-assertions -- boundary: an address returned by the Windows security API
        if (sidString[0]) kernel32.symbols.LocalFree(Number(sidString[0]) as Pointer);
        // SAFETY: a successful OpenProcessToken populated this owned handle; it is released once here.
        // oxlint-disable-next-line typescript/consistent-type-assertions -- boundary: a handle returned by the Windows security API
        if (token[0]) kernel32.symbols.CloseHandle(Number(token[0]) as Pointer);
      }
      const descriptor = new BigUint64Array(1);
      const sddl = Buffer.from(`D:P(A;OICI;FA;;;${sid})\0`, "utf16le");
      if (advapi32.symbols.ConvertStringSecurityDescriptorToSecurityDescriptorW(ptr(sddl), 1, ptr(descriptor), null) === 0) {
        // oxlint-disable-next-line unicorn/throw-new-error -- boundary: GetLastError reads a Win32 error code, not an error constructor
        const code = kernel32.symbols.GetLastError();
        throw new Error(`Cannot construct private directory ACL (Windows error ${code})`);
      }
      // SAFETY: the successful conversion returned this descriptor address; LocalFree below owns its release.
      // oxlint-disable-next-line typescript/consistent-type-assertions -- boundary: an address returned by the Windows security API
      const securityDescriptor = Number(descriptor[0]) as Pointer;
      try {
        const present = new Int32Array(1);
        const dacl = new BigUint64Array(1);
        const defaulted = new Int32Array(1);
        if (advapi32.symbols.GetSecurityDescriptorDacl(securityDescriptor, ptr(present), ptr(dacl), ptr(defaulted)) === 0) {
          // oxlint-disable-next-line unicorn/throw-new-error -- boundary: GetLastError reads a Win32 error code, not an error constructor
          const code = kernel32.symbols.GetLastError();
          throw new Error(`Cannot read private directory ACL (Windows error ${code})`);
        }
        // SAFETY: this DACL belongs to the live descriptor constructed above; its declared bytes are copied before that descriptor is freed.
        // oxlint-disable-next-line typescript/consistent-type-assertions -- boundary: an address returned by the Windows security API
        const address = Number(dacl[0]) as Pointer;
        const size = new DataView(toArrayBuffer(address, 0, 8)).getUint16(2, true);
        acl = Buffer.from(new Uint8Array(toArrayBuffer(address, 0, size)));
      } finally {
        kernel32.symbols.LocalFree(securityDescriptor);
      }
      return (directoryPath) => {
        const name = Buffer.from(`${directoryPath}\0`, "utf16le");
        const currentDescriptor = new BigUint64Array(1);
        const currentDacl = new BigUint64Array(1);
        const readCode = advapi32.symbols.GetNamedSecurityInfoW(ptr(name), 1, 4, null, null, ptr(currentDacl), null, ptr(currentDescriptor));
        if (readCode !== 0) throw new Error(`Cannot inspect private directory ${directoryPath} (Windows error ${readCode})`);
        // SAFETY: a successful read allocated this descriptor; LocalFree owns its release after comparison.
        // oxlint-disable-next-line typescript/consistent-type-assertions -- boundary: an address returned by the Windows security API
        const descriptorAddress = Number(currentDescriptor[0]) as Pointer;
        let exact = false;
        try {
          const control = Buffer.alloc(2);
          const revision = new Uint32Array(1);
          if (advapi32.symbols.GetSecurityDescriptorControl(descriptorAddress, ptr(control), ptr(revision)) === 0) {
            // oxlint-disable-next-line unicorn/throw-new-error -- boundary: GetLastError reads a Win32 error code, not an error constructor
            const code = kernel32.symbols.GetLastError();
            throw new Error(`Cannot inspect private directory control ${directoryPath} (Windows error ${code})`);
          }
          if (currentDacl[0] && (control.readUInt16LE(0) & 0x1000) !== 0) {
            // SAFETY: this DACL belongs to the live descriptor; compare its declared bytes before LocalFree releases it.
            // oxlint-disable-next-line typescript/consistent-type-assertions -- boundary: an address returned by the Windows security API
            const address = Number(currentDacl[0]) as Pointer;
            const size = new DataView(toArrayBuffer(address, 0, 8)).getUint16(2, true);
            exact = size === acl.length && Buffer.from(toArrayBuffer(address, 0, size)).equals(acl);
          }
        } finally {
          kernel32.symbols.LocalFree(descriptorAddress);
        }
        if (exact) return;
        // Exact replacement removes explicit foreign root grants. Windows propagates
        // inheritable entries; independently protected descendants remain independent.
        const code = advapi32.symbols.SetNamedSecurityInfoW(ptr(name), 1, 0x8000_0004, null, null, ptr(acl), null);
        if (code !== 0) throw new Error(`Cannot protect private directory ${directoryPath} (Windows error ${code})`);
      };
    } catch (error) {
      kernel32.close();
      throw error;
    }
  } catch (error) {
    advapi32.close();
    throw error;
  }
}


const defaultOperations: WindowsPrivateDirectoryAclOperations = {
  platform: process.platform,
  nativeAcl,
};

const defaultVerifierOperations: WindowsPrivateDirectoryAclVerifierOperations = {
  platform: process.platform,
  run(argv, timeoutMs) {
    try {
      const launch = trustedProbeLaunch(argv);
      const result = Bun.spawnSync([...launch.argv], {
        stdout: "pipe",
        stderr: "ignore",
        timeout: timeoutMs,
        env: launch.env,
        windowsHide: launch.windowsHide,
      });
      return { success: result.success, stdout: new TextDecoder().decode(result.stdout) };
    } catch {
      return { success: false, stdout: "" };
    }
  },
};

/** Protect every admitted Windows root for the current account. Identity or ACL errors throw; other platforms do nothing. */
export function createWindowsPrivateDirectoryAclPort(
  overrides: Partial<WindowsPrivateDirectoryAclOperations> = {},
): WindowsPrivateDirectoryAclPort {
  const operations: WindowsPrivateDirectoryAclOperations = { ...defaultOperations, ...overrides };
  let apply: WindowsPrivateDirectoryAclPort | undefined;
  return (directoryPath) => {
    if (operations.platform !== "win32") return;
    if (apply === undefined) {
      apply = operations.nativeAcl();
    }
    apply(directoryPath);
  };
}

/** Protect every admitted root with the native current-account ACL. Identity or ACL errors reject. */
export function createWindowsPrivateDirectoryAclAsyncPort(
  overrides: Partial<WindowsPrivateDirectoryAclOperations> = {},
): WindowsPrivateDirectoryAclAsyncPort {
  const apply = createWindowsPrivateDirectoryAclPort(overrides);
  return async (directoryPath) => {
    apply(directoryPath);
  };
}

/** The principals one icacls listing grants to, lowercased. The first line
 *  carries the directory path before its entry and the rest are indented
 *  continuations. An entry whose shape this reader does not recognize yields no
 *  principals at all, so an unreadable listing is never read as private. */
function aclPrincipals(listing: string, directoryPath: string): readonly string[] {
  const principals: string[] = [];
  for (const raw of listing.split(/\r?\n/)) {
    const line = raw.startsWith(directoryPath) ? raw.slice(directoryPath.length) : raw;
    const entry = line.trim();
    if (entry === "" || /^(Successfully processed|Failed processing)/i.test(entry)) continue;
    const rights = entry.lastIndexOf(":(");
    if (rights === -1) return [];
    principals.push(entry.slice(0, rights).toLowerCase());
  }
  return principals;
}

/** Whether a directory admits its owner and nobody else.
 *
 *  This is the Windows counterpart of a POSIX mode carrying no group or other
 *  bits. Windows keeps no mode bits and reports no owning uid, so the ACL is
 *  the only privacy a caller can prove there. Every answer fails closed: an
 *  unresolved SID, a refused listing, or an entry this reader cannot parse all
 *  report the directory as not private.
 *
 *  An inherited entry is not by itself a leak, so rights are not inspected;
 *  what matters is that no principal other than the owner appears at all. */
export function windowsDirectoryIsOwnerOnly(
  directoryPath: string,
  overrides: Partial<WindowsPrivateDirectoryAclVerifierOperations> = {},
): boolean {
  const operations: WindowsPrivateDirectoryAclVerifierOperations = { ...defaultVerifierOperations, ...overrides };
  if (operations.platform !== "win32") return false;
  const identity = operations.run(["whoami", "/user"], SID_TIMEOUT_MS);
  const account = operations.run(["whoami"], SID_TIMEOUT_MS);
  if (!identity.success || !account.success) return false;
  const owner = new Set(
    [identity.stdout.match(SID_PATTERN)?.[0], account.stdout.trim()]
      .filter((name): name is string => name !== undefined && name !== "")
      .map((name) => name.toLowerCase()),
  );
  if (owner.size === 0) return false;
  const listing = operations.run(["icacls", directoryPath], ACL_TIMEOUT_MS);
  if (!listing.success) return false;
  const principals = aclPrincipals(listing.stdout, directoryPath);
  return principals.length > 0 && principals.every((principal) => owner.has(principal));
}

export const applyWindowsPrivateDirectoryAcl = createWindowsPrivateDirectoryAclPort();
export const applyWindowsPrivateDirectoryAclAsync = createWindowsPrivateDirectoryAclAsyncPort();