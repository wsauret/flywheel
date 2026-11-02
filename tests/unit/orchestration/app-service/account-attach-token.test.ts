import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { Worker } from "node:worker_threads"
import { Redacted } from "effect"

import { readOrCreateAccountAttachToken } from "../../../../src/orchestration/app-service/account-attach-token.js"
import { accountServeDir, accountServeTokenPath } from "../../../../src/infra/paths.js"
import { temporaryDirectories } from "../../../helpers/directories.js"

const tempDir = temporaryDirectories()

/** Rounds of the race: each round is a fresh root that the peers reach
 *  together. The race caught a creator that made the path first and wrote the
 *  token in a second step in about 3 of each 100 rounds, so 300 rounds catch
 *  it in nearly every run. */
const RACE_ROUNDS = 300
const CREATORS = 3

function results(worker: Worker): Promise<string[]> {
  return new Promise((resolve, reject) => {
    worker.once("message", (message: string[]) => resolve(message))
    worker.once("error", reject)
  })
}

describe("account attach token", () => {
  test("creates one owner-only token and keeps it redacted in memory", () => {
    const userDataRoot = tempDir("flywheel-account-token-")

    const first = readOrCreateAccountAttachToken(userDataRoot, "installed")
    const second = readOrCreateAccountAttachToken(userDataRoot, "installed")
    const stored = readFileSync(accountServeTokenPath(userDataRoot, "installed"), "utf8").trim()

    expect(Redacted.value(first)).toBe(stored)
    expect(Redacted.value(second)).toBe(stored)
    expect(JSON.stringify({ token: first })).not.toContain(stored)
    if (process.platform !== "win32") expect(statSync(accountServeTokenPath(userDataRoot, "installed")).mode & 0o777).toBe(0o600)
    expect(readdirSync(accountServeDir(userDataRoot, "installed"))).toEqual(["serve.token"])
  })

  test("names only a whole token at its path, so creators that race all read one token and a reader that waits for the file reads it whole", async () => {
    const parent = tempDir("flywheel-account-token-race-")
    const roots = Array.from({ length: RACE_ROUNDS }, (_, round) => join(parent, `root-${round}`))
    const roles = [...Array.from({ length: CREATORS }, () => "create" as const), "observe" as const]
    const peers = roles.map((role) => new Worker(new URL("fixtures/account-attach-token-peer.ts", import.meta.url), {
      workerData: { roots, role },
    }))
    let seen: string[][]
    try {
      seen = await Promise.all(peers.map(results))
    } finally {
      await Promise.all(peers.map((peer) => peer.terminate()))
    }

    const wrong = roots.flatMap((root, round) => {
      const stored = readFileSync(accountServeTokenPath(root, "installed"), "utf8").trim()
      return seen.flatMap((rounds, peer) => rounds[round] === stored ? [] : [`round ${round}, ${roles[peer]} peer ${peer}: ${rounds[round]?.length === 43 ? "another token" : JSON.stringify(rounds[round])}`])
    })
    expect(wrong).toEqual([])
    expect(roots.filter((root) => readdirSync(accountServeDir(root, "installed")).length !== 1)).toEqual([])
  })
})
