import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto"
import { readdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { basename, dirname, join } from "node:path"

import { acquireLock, releaseLock } from "../../../infra/ownership-file-lock.js"
import { ensurePrivateRootDirectoryAsync, PRIVATE_FILE_MODE } from "../../../infra/private-path.js"
import { renameThroughSharing } from "../../../infra/windows-file-replacement.js"

const TOKEN_PATTERN = /^[0-9a-f]{48}$/
const STAGING_SUFFIX = /^\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.tmp$/

/** Generate a new 192-bit token encoded as hexadecimal. */
export function generateToken(): string {
  return randomBytes(24).toString("hex")
}

/** The project's browser token: the one at `path` when it holds a token,
 *  otherwise a new one written there owner-only, in a directory this creates
 *  owner-only when it is absent. The token belongs to the project, not to one
 *  runtime process or one serve lane, so the link a browser stored keeps
 *  opening the project across restarts and whichever lane serves it. A file
 *  that does not hold a token, whatever else it holds, is replaced rather
 *  than trusted.
 *
 *  Both lanes can start a project at once, so a token is written only under
 *  the cross-process lock `<path>.lock`, after the file is read again under
 *  it: a token another start published while this one waited is adopted,
 *  never replaced. A valid token is read without the lock. The new token is
 *  written whole to a private staging name and renamed into place, so no
 *  reader ever sees a partly written file. A staging file that a start which
 *  ended mid-write left is removed by the next start that writes. Rejects
 *  when the lock stays held through its retry ladder or the file system
 *  refuses a step. */
export async function loadOrCreateToken(path: string): Promise<string> {
  const stored = await readToken(path)
  if (stored !== undefined) return stored
  await ensurePrivateRootDirectoryAsync(dirname(path))
  const lock = await acquireLock(`${path}.lock`)
  try {
    return await readToken(path) ?? await publishToken(path)
  } finally {
    releaseLock(lock)
  }
}

/** Write a new token at `path`. The caller holds the token's lock, so every
 *  staging file beside `path` belongs to a start that ended mid-write. */
async function publishToken(path: string): Promise<string> {
  const name = basename(path)
  const directory = dirname(path)
  for (const entry of await readdir(directory)) {
    if (entry.startsWith(name) && STAGING_SUFFIX.test(entry.slice(name.length))) await rm(join(directory, entry), { force: true })
  }
  const token = generateToken()
  const staged = `${path}.${randomUUID()}.tmp`
  await writeFile(staged, `${token}\n`, { mode: PRIVATE_FILE_MODE, flag: "wx" })
  try {
    // A Windows reader of the old file, such as a virus scanner, refuses the
    // replacing rename until it lets go.
    if (process.platform === "win32") renameThroughSharing(staged, path)
    else await rename(staged, path)
  } finally {
    await rm(staged, { force: true })
  }
  return token
}

async function readToken(path: string): Promise<string | undefined> {
  try {
    const stored = (await readFile(path, "utf8")).trim()
    return TOKEN_PATTERN.test(stored) ? stored : undefined
  } catch {
    // Absent: the first start for this project.
    return undefined
  }
}

/** Authorize a presented token against the runtime's own using padded
 *  timing-safe equality. The runtime's token is never empty, so an absent or
 *  empty presentation is a refusal, never a match. */
export function authorizeToken(provided: string | undefined, expected: string): boolean {
  if (typeof provided !== "string" || provided.length === 0) return false
  const providedBytes = Buffer.from(provided, "utf8")
  const expectedBytes = Buffer.from(expected, "utf8")
  const byteLength = Math.max(providedBytes.length, expectedBytes.length)
  return (
    timingSafeEqual(padSecretBytes(providedBytes, byteLength), padSecretBytes(expectedBytes, byteLength)) &&
    providedBytes.length === expectedBytes.length
  )
}

function padSecretBytes(bytes: Buffer, length: number): Buffer {
  if (bytes.length === length) return bytes
  const padded = Buffer.alloc(length)
  bytes.copy(padded)
  return padded
}
