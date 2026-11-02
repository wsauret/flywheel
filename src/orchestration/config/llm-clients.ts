import type { FirstPartyModuleComposition } from "../modules.js";
/**
 * Process-shared LLM metadata clients.
 *
 * Model listings are account-bound generations. The models.dev catalog is
 * account-independent, and each account root keeps one client for the process
 * lifetime because the client archives the catalog under that root. A
 * production process serves one account, so it holds one models client.
 */

import { captureSubscriptionCredentials } from "../../infra/auth/auth-context.js";
import { loadAuthStoreWithDiagnostics } from "../../infra/auth/auth-store.js";
import { createModelListingClient, type ModelListingClient } from "../../infra/llm/model-listing.js";
import { createModelsClient, type ModelsClient } from "../../infra/llm/models.js";
import { modelsSnapshotFile } from "../../infra/paths.js";
import { accessProviderRegistry } from "../agent-runtime/llm/access-provider-registry.js";
import { credentialSlotClassifier } from "../auth/credential-slot-classifier.js";

const listingClients = new Map<string, ModelListingClient>();
/** Catalog discovery diagnostics already recorded in this process. It
 *  outlives the listing generations an auth change replaces, so an unchanged
 *  unresolved set records once per process. */
const diagnosedDiscoveries = new Map<string, string>();
const modelsClients = new Map<string, ModelsClient>();

/** Returns the process-shared listing generation for one account, auth profile, and enabled provider identity.
 * Callers must normalize legacy credential lineages before the first catalog read. */
export function getSharedModelListingClient(userDataRoot: string, authDir: string, composition: FirstPartyModuleComposition): ModelListingClient {
  const providerIdentity = composition.contributions
    .filter((contribution) => contribution.domain === "providers")
    .map((contribution) => contribution.id)
    .sort()
    .join("\0");
  const key = `${userDataRoot}\0${authDir}\0${providerIdentity}`;
  let client = listingClients.get(key);
  if (client) return client;
  const registry = accessProviderRegistry(composition);
  const classifySlot = credentialSlotClassifier(composition);
  client = createModelListingClient({
    providers: registry.selection,
    authDir,
    classifySlot,
    modelsClient: getSharedModelsClient(userDataRoot),
    captureSubscriptions: () => captureSubscriptionCredentials(
      registry.selection.definitions,
      { kind: "persisted", authDir, classifySlot, report: false },
    ),
    captureCredentialLineages: () => loadAuthStoreWithDiagnostics(authDir, undefined, classifySlot, false).credentialLineages,
    diagnosedDiscoveries,
  });
  listingClients.set(key, client);
  return client;
}

/** Returns the process-shared models.dev client that archives under `userDataRoot`. */
export function getSharedModelsClient(userDataRoot: string): ModelsClient {
  const snapshotFile = modelsSnapshotFile(userDataRoot);
  let client = modelsClients.get(snapshotFile);
  if (client) return client;
  client = createModelsClient(snapshotFile);
  modelsClients.set(snapshotFile, client);
  return client;
}

/** Invalidates first-party listing generations without discarding process-owned public metadata. */
export function clearSharedModelListingClients(authDirectory?: string): void {
  if (authDirectory === undefined) {
    listingClients.clear();
    return;
  }
  const segment = `\0${authDirectory}\0`;
  for (const key of listingClients.keys()) {
    if (key.includes(segment)) listingClients.delete(key);
  }
}

/** Resets all process-shared clients. Production refresh paths must not call this. */
export function resetSharedLlmClients(): void {
  listingClients.clear();
  modelsClients.clear();
}
