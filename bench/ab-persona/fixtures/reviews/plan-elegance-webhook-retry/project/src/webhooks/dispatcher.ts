export interface Endpoint {
  readonly url: string;
  readonly secret: string;
}

export interface RelayEvent {
  readonly id: string;
  readonly type: string;
  readonly payload: unknown;
}

export class WebhookStatusError extends Error {
  constructor(readonly status: number) {
    super(`Webhook endpoint returned ${status}`);
  }
}

async function signature(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  return Buffer.from(mac).toString("hex");
}

/** One delivery attempt. Throws WebhookStatusError for a non-2xx answer; a network failure rejects from fetch. */
export async function deliverWebhook(endpoint: Endpoint, event: RelayEvent, fetcher: typeof fetch = fetch): Promise<void> {
  const body = JSON.stringify(event);
  const response = await fetcher(endpoint.url, {
    method: "POST",
    headers: { "content-type": "application/json", "x-relay-signature": await signature(endpoint.secret, body), "x-relay-event-id": event.id },
    body,
  });
  if (!response.ok) throw new WebhookStatusError(response.status);
}
