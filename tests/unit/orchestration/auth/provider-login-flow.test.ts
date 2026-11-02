import { describe, expect, test } from "bun:test";

import type { AccessProviderAccountIdentity, AccessProviderDefinition, ExternalAccount, ExternalLoginPorts } from "../../../../src/infra/llm/access-provider.js";
import { logoutProfileExternalLogins, providerLoginFlow } from "../../../../src/orchestration/auth/auth-actions.js";
import { SHIPPED_MODULES } from "../../../../src/orchestration/modules.js";
import { fileTemporaryDirectory } from "../../../helpers/directories.js";
import { refusingLauncher } from "../../../helpers/launcher-fake.js";

/** The login flow a client is shown is a fold over the enabled definitions:
 *  a provider that declares OAuth answers with the flow its definition
 *  declares, and an API-key provider answers nothing, so the method a client
 *  offers and the actions behind it cannot drift apart. */

const providerDefinitions = SHIPPED_MODULES.flatMap((module) =>
  module.contributions.flatMap((contribution) => (contribution.domain === "providers" ? [contribution.value.definition] : [])));

describe("provider login flow", () => {
  test("every first-party OAuth provider answers with its declared flow", () => {
    for (const definition of providerDefinitions) {
      if (definition.auth.kind !== "oauth") continue;
      const flow = providerLoginFlow(definition.id);
      expect(flow, `OAuth provider ${definition.id} declares no login flow`).toBeDefined();
      expect(flow?.flow, `Provider ${definition.id} declares auth flow ${definition.auth.flow} but answers a ${flow?.flow} login`).toBe(definition.auth.flow);
    }
  });

  test("no API-key provider answers with an OAuth flow", () => {
    for (const definition of providerDefinitions) {
      if (definition.auth.kind !== "api_key") continue;
      expect(providerLoginFlow(definition.id), `API-key provider ${definition.id} must not answer an OAuth login flow`).toBeUndefined();
    }
  });

  test("an unknown id answers nothing", () => {
    expect(providerLoginFlow("no-such-provider")).toBeUndefined();
  });

  test("an external login answers a browser flow that runs its program and settles the account the program then holds", async () => {
    const authDir = fileTemporaryDirectory("flywheel-external-login-");
    const held: ExternalAccount[] = [{ accountId: "uuid-a", identity: "a@example.com", configDir: "/scratch/a" }];
    const logins: { readonly previous: ExternalAccount | undefined; readonly ports: ExternalLoginPorts }[] = [];
    const base = providerDefinitions.find(({ billing }) => billing === "subscription");
    if (base === undefined) throw new Error("expected a subscription provider");
    const external: AccessProviderDefinition = {
      ...base,
      id: "external_login",
      auth: {
        kind: "external",
        program: "Example CLI",
        statusRank: 0,
        accounts: () => held,
        problems: () => [],
        observe: () => () => {},
        awaitLogin: async () => "declined",
        loginQuestions: () => [],
        answerLogin: () => undefined,
        settleLogin: () => {},
        login: async (_authDir, ports, previous) => {
          logins.push({ previous, ports });
          const account = previous ?? { accountId: "uuid-b", identity: "b@example.com", configDir: "/scratch/b" };
          if (previous === undefined) held.push(account);
          return account;
        },
        logout: async () => {},
        logoutProfile: async () => {},
      },
    };
    const settled: AccessProviderAccountIdentity[] = [];
    const options = {
      authDir,
      profileId: "work",
      resolveKey: async () => undefined,
      openBrowser: async () => true,
      launcher: refusingLauncher,
      settle: async (account: AccessProviderAccountIdentity) => { settled.push(account); },
    };

    const flow = providerLoginFlow("external_login", [external]);
    expect(flow?.flow).toBe("browser");
    if (flow?.flow !== "browser") return;
    await flow.login(options);
    expect(await flow.reconnect("uuid-a", options)).toBe(true);
    await expect(flow.reconnect("uuid-gone", options)).rejects.toThrow("no longer holds this account");

    expect(logins.map(({ previous, ports }) => ({ previous: previous?.accountId, launcher: ports.launcher }))).toEqual([
      { previous: undefined, launcher: refusingLauncher },
      { previous: "uuid-a", launcher: refusingLauncher },
    ]);
    expect(settled).toEqual([
      { kind: "subscription", providerId: "external_login", instanceId: "uuid-b" },
      { kind: "subscription", providerId: "external_login", instanceId: "uuid-a" },
    ]);
  });

  test("a profile's removal ends the external logins inside it, and one program's failure leaves the others to end", async () => {
    const authDir = fileTemporaryDirectory("flywheel-external-profile-");
    const base = providerDefinitions.find(({ billing }) => billing === "subscription");
    if (base === undefined) throw new Error("expected a subscription provider");
    const ended: { readonly providerId: string; readonly authDir: string }[] = [];
    const external = (id: string, fails: boolean): AccessProviderDefinition => ({
      ...base,
      id,
      auth: {
        kind: "external",
        program: "Example CLI",
        statusRank: 0,
        accounts: () => [],
        problems: () => [],
        observe: () => () => {},
        awaitLogin: async () => "declined",
        loginQuestions: () => [],
        answerLogin: () => undefined,
        settleLogin: () => {},
        login: () => Promise.reject(new Error("no login")),
        logout: async () => {},
        logoutProfile: async (directory, ports) => {
          expect(ports.launcher).toBe(refusingLauncher);
          ended.push({ providerId: id, authDir: directory });
          if (fails) throw new Error("the program did not end its login");
        },
      },
    });

    await logoutProfileExternalLogins(authDir, refusingLauncher, [external("external_a", true), base, external("external_b", false)]);

    expect(ended).toEqual([{ providerId: "external_a", authDir }, { providerId: "external_b", authDir }]);
  });
});
