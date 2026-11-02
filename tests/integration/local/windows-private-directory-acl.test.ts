import { expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { ensurePrivateRootDirectory } from "../../../src/infra/private-path.js"

const system32 = join(process.env.SystemRoot ?? "C:\\Windows", "System32")
const whoami = join(system32, "whoami.exe")
const icacls = join(system32, "icacls.exe")

function runCommand(argv: readonly string[]): string {
  const result = Bun.spawnSync([...argv], { stdout: "pipe", stderr: "pipe", windowsHide: true })
  const stderr = new TextDecoder().decode(result.stderr).trim()
  if (!result.success) throw new Error(`${argv[0]} failed with exit code ${result.exitCode}: ${stderr}`)
  return new TextDecoder().decode(result.stdout).trim()
}

function currentUserSid(): string {
  const sid = runCommand([whoami, "/user"]).match(/\bS-\d-\d+(?:-\d+)+\b/)?.[0]
  if (sid === undefined) throw new Error("whoami returned no user SID")
  return sid
}

/** Every name icacls can print for the current user. It resolves a SID to its
 *  account name when a mapping exists and prints the raw SID when none does, so
 *  an identity check accepts both forms. Windows account names do not compare
 *  by case. */
function currentUserAclPrincipals(): readonly string[] {
  return [runCommand([whoami]), currentUserSid()].map((name) => name.toLowerCase())
}

/** The principal an icacls entry grants to, without its rights. */
function entryPrincipal(entry: string): string {
  const separator = entry.lastIndexOf(":(")
  return (separator === -1 ? entry : entry.slice(0, separator)).toLowerCase()
}

function aclEntries(directory: string): readonly string[] {
  const entries: string[] = []
  for (const line of runCommand([icacls, directory]).split(/\r?\n/)) {
    if (line.trim() === "" || /^(Successfully processed|Failed processing)/i.test(line.trim())) continue
    const entry = line.startsWith(directory) ? line.slice(directory.length).trim() : line.trim()
    if (entry !== "") entries.push(entry)
  }
  return entries
}

test.skipIf(process.platform !== "win32")("applies owner-only ACLs to a root and its inherited descendant", () => {
  const workspace = mkdtempSync(join(tmpdir(), "flywheel private acl-"))
  const root = join(workspace, "private root")
  const descendant = join(root, "descendant")
  try {
    ensurePrivateRootDirectory(root)
    mkdirSync(descendant)

    const principals = currentUserAclPrincipals()
    const rootEntries = aclEntries(root)
    const descendantEntries = aclEntries(descendant)

    expect(rootEntries).toHaveLength(1)
    expect(principals).toContain(entryPrincipal(rootEntries[0] ?? ""))
    expect(rootEntries[0]).toContain("(OI)")
    expect(rootEntries[0]).toContain("(CI)")
    expect(rootEntries[0]).toContain("(F)")
    expect(rootEntries[0]).not.toContain("(I)")

    expect(descendantEntries).toHaveLength(1)
    expect(principals).toContain(entryPrincipal(descendantEntries[0] ?? ""))
    expect(descendantEntries[0]).toContain("(I)")
    expect(descendantEntries[0]).toContain("(F)")
  } finally {
    rmSync(workspace, { recursive: true, force: true })
  }
}, 60_000)