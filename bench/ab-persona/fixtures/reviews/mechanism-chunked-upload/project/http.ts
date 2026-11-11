export interface HttpRequest {
  method: "GET" | "POST" | "PUT";
  url: string;
  body?: Uint8Array | string;
}

export interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

export type Transport = (request: HttpRequest) => Promise<HttpResponse>;

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const GATEWAY_STATUSES = new Set([502, 503, 504]);
const GATEWAY_ATTEMPTS = 3;

/** Send one request. Gateway failures are retried here, at the transport, so
 *  every caller gets the same treatment without wiring its own loop. */
export async function send(transport: Transport, request: HttpRequest): Promise<HttpResponse> {
  for (let attempt = 1; ; attempt++) {
    const response = await transport(request);
    if (response.status < 400) return response;
    if (!GATEWAY_STATUSES.has(response.status) || attempt >= GATEWAY_ATTEMPTS) {
      throw new HttpError(response.status, `${request.method} ${request.url} failed with ${response.status}`);
    }
  }
}
