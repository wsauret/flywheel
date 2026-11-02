import { openExternalUrl } from "../../../infra/open-external-url.js"
import type { LauncherScope } from "../../../infra/process-supervisor.js"
import type { McpOAuthAuthorization } from "./oauth.js"

export interface McpAuthenticationManager {
  authorize(server: string): Promise<McpOAuthAuthorization>
  credentialUpdated(server: string): Promise<void>
}

export interface McpAuthenticationService {
  authenticate(server: string): Promise<void>
}

/** Owns one interactive authorization from live manager lookup through credential refresh. */
export function createMcpAuthenticationService(options: {
  readonly manager: McpAuthenticationManager
  readonly launcher: LauncherScope
  readonly openUrl?: (launcher: LauncherScope, url: string) => Promise<boolean>
}): McpAuthenticationService {
  const openUrl = options.openUrl ?? openExternalUrl
  return {
    async authenticate(server): Promise<void> {
      const authorization = await options.manager.authorize(server)
      try {
        if (!await openUrl(options.launcher, authorization.url)) throw new Error("Browser handoff failed")
        await authorization.complete()
      } finally {
        await authorization.close()
      }
      await options.manager.credentialUpdated(server)
    },
  }
}
