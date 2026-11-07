import { chmodSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { RuntimeOAuthCredential } from "../../../../src/infra/auth/auth-context.js"
import type { AccessProviderDefinition } from "../../../../src/infra/llm/access-provider.js"
import { applyWindowsPrivateDirectoryAcl } from "../../../../src/infra/windows-private-directory-acl.js"
import { accessProviderRegistry } from "../../../../src/orchestration/agent-runtime/llm/access-provider-registry.js"
import { composeFirstPartyModules } from "../../../../src/orchestration/modules.js"

/** A stage prepared the way the snapshot reader demands: private to this
 *  account. POSIX states that with the directory mode; Windows keeps no mode
 *  bits, so the owner-only ACL is what an operator applies and what the reader
 *  verifies there. */
export function privateStage(parent: string): string {
  const stage = mkdtempSync(join(parent, "flywheel-auth-bundle-"))
  if (process.platform === "win32") applyWindowsPrivateDirectoryAcl(stage)
  else chmodSync(stage, 0o700)
  return stage
}

export function fixture(content: string, mode = 0o600) {
  const directory = privateStage(tmpdir())
  const path = join(directory, "auth.json")
  writeFileSync(path, content)
  chmodSync(path, mode)
  return { directory, path }
}

export const PROVIDERS = accessProviderRegistry(composeFirstPartyModules()).selection.definitions

/** The installed providers, with ChatGPT's host rotation replaced so that a test decides what the provider answers. */
export function withChatGptRefresh(refresh: (credential: RuntimeOAuthCredential) => Promise<RuntimeOAuthCredential>): readonly AccessProviderDefinition[] {
  return PROVIDERS.map((provider) => provider.id === "chatgpt" && provider.auth.kind === "oauth" ? { ...provider, auth: { ...provider.auth, refresh } } : provider)
}
