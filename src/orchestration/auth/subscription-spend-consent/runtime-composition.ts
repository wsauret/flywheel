import type { AuthProfileAccess } from "../../../infra/providers/auth/store/auth-profile-store.js";
import { createSubscriptionSpendConsentStore } from "../../../infra/providers/auth/subscription/subscription-spend-consent-store.js";
import type { SubscriptionUsageService } from "../provider-observations/subscription-usage-service.js";
import type { AccessProviderDefinition } from "../../../infra/providers/llm/access/access-provider.js";
import { createSubscriptionSpendConsentService, type SubscriptionSpendConsentService } from "./subscription-spend-consent-service.js";

/** Composes consent for a resolved profile's verified identities and declared paid modes. */
export function createSubscriptionSpendConsentRuntime(options: {
  readonly profileId: string;
  readonly access: AuthProfileAccess;
  readonly usage: Pick<SubscriptionUsageService, "generation" | "snapshot" | "currentAccounts">;
  readonly providers: readonly AccessProviderDefinition[];
  readonly providerPresentation?: (providerId: string) => { readonly providerDisplayName: string; readonly billingUrl?: string };
}): SubscriptionSpendConsentService {
  return createSubscriptionSpendConsentService({
    profileId: options.profileId,
    usage: options.usage,
    paidModes: (providerId) => {
      const provider = options.providers.find((definition) => definition.id === providerId);
      return provider?.billing === "subscription" ? provider.paidModes ?? [] : [];
    },
    consent: createSubscriptionSpendConsentStore({ profileId: options.profileId, access: options.access, currentAccounts: options.usage.currentAccounts }),
    ...(options.providerPresentation === undefined ? {} : { providerPresentation: options.providerPresentation }),
  });
}
