import { dlopen, FFIType, ptr, type Pointer } from "bun:ffi";
import { join } from "node:path";

/** The keychain status bit that states the keychain is unlocked (`kSecUnlockStateStatus`). */
const UNLOCK_STATE = 1;

interface SecurityApi {
  status(keychain: Pointer, out: Pointer): number;
  open(path: Uint8Array, out: Pointer): number;
  release(reference: Pointer): void;
}

/** The Security framework calls, bound once; null where they cannot be bound. */
let securityApi: SecurityApi | null | undefined;

function bindSecurity(): SecurityApi | null {
  if (securityApi !== undefined) return securityApi;
  try {
    const security = dlopen("/System/Library/Frameworks/Security.framework/Security", {
      SecKeychainGetStatus: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
      SecKeychainOpen: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
    }).symbols;
    const coreFoundation = dlopen("/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation", {
      CFRelease: { args: [FFIType.ptr], returns: FFIType.void },
    }).symbols;
    securityApi = {
      status: (keychain, out) => security.SecKeychainGetStatus(keychain, out),
      open: (path, out) => security.SecKeychainOpen(path, out),
      release: (reference) => { coreFoundation.CFRelease(reference); },
    };
  } catch {
    securityApi = null;
  }
  return securityApi;
}

/** The login keychain of the macOS account whose home is `home`: the default keychain of that account unless the
 *  person chose another. */
export function loginKeychainPath(home: string): string {
  return join(home, "Library", "Keychains", "login.keychain-db");
}

/**
 * Whether the keychain file at `path` is unlocked, or undefined where that cannot be told: on another platform, or
 * when the call fails. It asks the keychain for its state only, through `SecKeychainGetStatus`, so it reads no item
 * and never asks the person anything. A command that searches a locked keychain, such as
 * `security find-generic-password`, can instead show the dialog that asks for the keychain's password.
 */
export function keychainUnlocked(path: string): boolean | undefined {
  if (process.platform !== "darwin") return undefined;
  const security = bindSecurity();
  if (security === null) return undefined;
  const reference = new BigUint64Array(1);
  if (security.open(new TextEncoder().encode(`${path}\0`), ptr(reference)) !== 0) return undefined;
  // SAFETY: SecKeychainOpen succeeded, so the slot holds the keychain reference it created; the finally below releases it once.
  // oxlint-disable-next-line typescript/consistent-type-assertions -- boundary: a reference returned by the Security framework
  const keychain = Number(reference[0]) as Pointer;
  try {
    const status = new Uint32Array(1);
    if (security.status(keychain, ptr(status)) !== 0) return undefined;
    const [state = 0] = status;
    return (state & UNLOCK_STATE) !== 0;
  } finally {
    security.release(keychain);
  }
}
