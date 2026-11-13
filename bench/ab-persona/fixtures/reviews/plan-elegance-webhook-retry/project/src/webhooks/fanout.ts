import { deliverWebhook, type Endpoint, type RelayEvent } from "./dispatcher";

export interface DeliveryOutcome {
  readonly url: string;
  readonly ok: boolean;
}

/** Delivers one event to every subscribed endpoint; one endpoint's failure does not stop the others. */
export async function fanOut(endpoints: readonly Endpoint[], event: RelayEvent, fetcher: typeof fetch = fetch): Promise<DeliveryOutcome[]> {
  return Promise.all(endpoints.map(async (endpoint) => {
    try {
      await deliverWebhook(endpoint, event, fetcher);
      return { url: endpoint.url, ok: true };
    } catch {
      return { url: endpoint.url, ok: false };
    }
  }));
}
