import type { FlywheelAppServiceDeps } from "../../src/orchestration/app-service/app-service.js"
import type { AuthLoginService } from "../../src/orchestration/app-service/auth-login-service.js"

/** The services the auth mutations reach, for a test that exercises other
 *  ones. An auth refresh settles and a profile change cancels any login, so
 *  those answer quietly; every other call throws. A test spreads this first
 *  and states the services it asserts on after it. */
export function authMutationDoubles(): Pick<FlywheelAppServiceDeps, "authLogin" | "authProfileSelection" | "scheduleCatalogRefresh"> {
  return {
    authProfileSelection: {
      mutate: async () => { throw new Error("Auth profile selection is not used in this test") },
      refresh: async () => { throw new Error("Auth profile selection is not used in this test") },
      previewDelete: async () => { throw new Error("Auth profile selection is not used in this test") },
      settle: async () => {},
    } satisfies FlywheelAppServiceDeps["authProfileSelection"],
    authLogin: {
      login: async () => { throw new Error("Provider login is not used in this test") },
      answerPrompt: async () => { throw new Error("Provider login is not used in this test") },
      completeBrowserLogin: () => { throw new Error("Provider login is not used in this test") },
      disconnect: async () => { throw new Error("Provider accounts are not used in this test") },
      rename: async () => { throw new Error("Provider accounts are not used in this test") },
      decline: async () => {},
      cancel: async () => {},
      dispose: () => {},
    } satisfies AuthLoginService,
    scheduleCatalogRefresh: async () => { throw new Error("Catalog discovery is not used in this test") },
  }
}
