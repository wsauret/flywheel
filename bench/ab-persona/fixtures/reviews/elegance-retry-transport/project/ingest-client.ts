import type { HttpResponse, Transport } from "./transport.ts";

export interface Reading {
  sensor: string;
  value: number;
  takenAt: number;
}

export class IngestError extends Error {
  constructor(readonly status: number, what: string) {
    super(`${what} failed with status ${status}`);
  }
}

/** Client of the weather-station ingest service. */
export class IngestClient {
  constructor(private readonly transport: Transport) {}

  /** Store a batch of readings. The batch id makes the PUT idempotent: the
   *  service replaces a batch it already has instead of adding it twice. */
  async putBatch(stationId: string, batchId: string, readings: readonly Reading[]): Promise<void> {
    const response = await this.transport.send({
      method: "PUT",
      path: `/stations/${encodeURIComponent(stationId)}/batches/${encodeURIComponent(batchId)}`,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(readings),
    });
    expectOk(response, `Upload of batch ${batchId}`);
  }

  async stationName(stationId: string): Promise<string> {
    const response = await this.transport.send({ method: "GET", path: `/stations/${encodeURIComponent(stationId)}`, headers: {} });
    expectOk(response, `Lookup of station ${stationId}`);
    const body: unknown = JSON.parse(response.body);
    if (typeof body !== "object" || body === null || !("name" in body) || typeof body.name !== "string") {
      throw new Error(`Station ${stationId} has no name in the response`);
    }
    return body.name;
  }

  /** Raise an operator alert. Each POST creates a new alert. */
  async raiseAlert(stationId: string, message: string): Promise<void> {
    const response = await this.transport.send({
      method: "POST",
      path: `/stations/${encodeURIComponent(stationId)}/alerts`,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message }),
    });
    expectOk(response, `Alert for station ${stationId}`);
  }
}

function expectOk(response: HttpResponse, what: string): void {
  if (response.status < 200 || response.status >= 300) throw new IngestError(response.status, what);
}
