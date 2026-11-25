import { createHash } from "node:crypto"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { privateTemporaryRoot } from "../../../../infra/platform/files/private-temporary-root.js"
import { gateHookHandler, type GateHookHandler } from "./hook-command.js"

/** Where the step gate of one login listens, and the id that its hook queries carry (ARCH-PROVIDERS-087). */
export interface LoginGateAddress {
  readonly address: string
  readonly gateId: string
}

/**
 * The step gate address of the login directory `loginDir` in this process, so the hook that the login's `hooks.json`
 * names stays the same across service restarts (plan P15). Only the one process that owns the login writes that hook
 * (`withLoginOwnership`), and the hook also names that process's executable, so the address may depend on the
 * process's temporary directory: no engine of another process reads it. A Unix socket path must stay short, so the
 * socket is named by a digest of the directory in this user's private `fw-agy-<uid>` temporary root, never in the
 * login directory; on Windows it is a named pipe. The digest is also the gate id. Throws when the temporary root
 * belongs to another user (`privateTemporaryRoot`).
 */
export function loginGateAddress(loginDir: string): LoginGateAddress {
  const gateId = createHash("sha256").update(loginDir).digest("hex").slice(0, 16)
  const address = process.platform === "win32" ? String.raw`\\.\pipe\fw-agy-${gateId}` : join(privateTemporaryRoot(tmpdir(), "fw-agy"), `${gateId}.sock`)
  return { address, gateId }
}

/** The PreInvocation hook of the login directory `loginDir`, which asks the login's step gate. */
export function loginGateHook(loginDir: string): GateHookHandler {
  const { address, gateId } = loginGateAddress(loginDir)
  return gateHookHandler({ address, loginGateId: gateId })
}
