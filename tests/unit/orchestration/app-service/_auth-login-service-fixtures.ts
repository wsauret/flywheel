import { Redacted } from "effect";

import { createAuthLoginService } from "../../../../src/orchestration/app-service/auth-login-service.js";
import type { ProviderOAuthLogin } from "../../../../src/orchestration/auth/auth-actions.js";
import { defaultModuleState } from "../../../../src/orchestration/config/module-descriptor.js";
import type { ModulePolicy } from "../../../../src/orchestration/config/module-policy.js";
import type { AuthOperationNotice, AuthProviderStatus } from "../../../../src/protocol/auth-status-protocol-types.js";
import { refusingLauncher } from "../../../helpers/launcher-fake.js";

export function provider(overrides: Partial<AuthProviderStatus> = {}): AuthProviderStatus {
  const base: AuthProviderStatus = {
    providerId: "github_copilot",
    kind: "subscription",
    source: "oauth",
    expired: true,
    modelCapable: true,
    loginMethod: "device-code",
    statusRank: 0,
    group: "model",
    accounts: [],
    displayName: "Copilot Subscription",
  };
  return { ...base, ...overrides };
}

export function account(instanceId: string): AuthProviderStatus["accounts"][number] {
  return {
    instanceId,
    accountCorrelationId: `opaque-${instanceId}`,
    identity: `${instanceId}@example.com`,
    displayLabel: instanceId,
    expired: true,
    source: "oauth",
  };
}

/** The service only ever logs from these, so a recorder would assert nothing
 *  these tests are about. */
export const silentLog = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

/** Every publication the service makes: the progress or the end of a long
 *  login, or a plain refresh after a disconnect or rename. */
type Publish = (notice?: AuthOperationNotice) => Promise<void>

export function service(
  providers: readonly AuthProviderStatus[],
  loginFlows: ReadonlyMap<string, ProviderOAuthLogin> = new Map(),
  publish: Publish = async () => {},
  authDirectory = "/scratch/does-not-matter",
  settleCatalog: () => Promise<void> = async () => {},
  admit: ModulePolicy["admit"] = async (request) => ({ ok: true, grant: { ...defaultModuleState(), ...request } }),
  openBrowser: (url: string) => Promise<boolean> = async () => true,
) {
  return createAuthLoginService({
    resolveProfile: (profileId) => profileId === undefined || profileId === "default" ? { id: "default", directory: authDirectory } : undefined,
    resolveKey: async (value: string) => Redacted.make(value),
    launcher: refusingLauncher,
    openBrowser,
    refresh: () => publish(),
    publishNotice: (notice) => publish(notice),
    settleCatalog: () => settleCatalog,
    admit,
    providers: async () => providers,
    loginFlows: (providerId) => loginFlows.get(providerId),
    log: silentLog,
  });
}
