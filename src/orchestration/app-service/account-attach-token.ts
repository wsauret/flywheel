import { closeSync, constants, existsSync, linkSync, openSync, readFileSync, rmSync, writeSync } from "node:fs"
import { dirname } from "node:path"
import { Redacted } from "effect"

import { newAccountAttachCredential } from "../../protocol/account-attach.js"
import type { ServeLane } from "../../infra/cli-subprocess.js"
import { accountServeTokenPath } from "../../infra/paths.js"
import { ensurePrivateFile, ensurePrivateRootDirectory, PRIVATE_FILE_MODE } from "../../infra/private-path.js"

/** Reads or creates a lane's account-socket admission token. The token path
 *  only ever names a whole token, so a client and the service that start
 *  together, or a harness that waits for the file, never read a token that a
 *  creator has not finished writing. Plain text exists only at the file
 *  serialization boundary. */
export function readOrCreateAccountAttachToken(userDataRoot: string, lane: ServeLane): Redacted.Redacted<string> {
  const tokenPath = accountServeTokenPath(userDataRoot, lane)
  ensurePrivateRootDirectory(dirname(tokenPath))
  if (!existsSync(tokenPath)) publishNewToken(tokenPath)
  ensurePrivateFile(tokenPath)
  const token = readFileSync(tokenPath, "utf8").trim()
  if (!/^[A-Za-z0-9_-]{43}$/u.test(token)) throw new Error("Account attach token is malformed")
  return Redacted.make(token)
}

/** Writes a new token to a draft of this creator's own beside the token path,
 *  then links the draft at the path. The link fails when the path already
 *  exists, so the first creator's token is the one every creator reads. The
 *  draft sits in the private directory, so on Windows it carries that
 *  directory's owner-only ACL, and the link is the same file with the same
 *  ACL. */
function publishNewToken(tokenPath: string): void {
  const draft = `${tokenPath}.${crypto.randomUUID()}.draft`
  try {
    const fd = openSync(draft, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, PRIVATE_FILE_MODE)
    try {
      writeSync(fd, `${newAccountAttachCredential()}\n`)
    } finally {
      closeSync(fd)
    }
    try {
      linkSync(draft, tokenPath)
    } catch (error) {
      if (!isErrnoCode(error, "EEXIST")) throw error
    }
  } finally {
    rmSync(draft, { force: true })
  }
}

function isErrnoCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code
}
