import { IngestClient } from "./ingest-client.ts";
import { RetryingTransport } from "./retrying-transport.ts";
import { FetchTransport } from "./transport.ts";

/** Stations upload over flaky cellular links, so idempotent calls retry. */
export function createIngestClient(baseUrl: string): IngestClient {
  return new IngestClient(new RetryingTransport(new FetchTransport(baseUrl)));
}
