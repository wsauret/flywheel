export interface HttpRequest {
  method: "GET" | "PUT" | "POST";
  /** Path below the ingest service's base URL, for example "/stations/s1". */
  path: string;
  headers: Record<string, string>;
  body?: string;
}

export interface HttpResponse {
  status: number;
  /** Header names are lower case. */
  headers: Record<string, string>;
  body: string;
}

/** Sends one request. Rejects only when no response arrives (network
 *  failure); every HTTP status, including errors, resolves. */
export interface Transport {
  send(request: HttpRequest): Promise<HttpResponse>;
}

export class FetchTransport implements Transport {
  constructor(private readonly baseUrl: string) {}

  async send(request: HttpRequest): Promise<HttpResponse> {
    const response = await fetch(`${this.baseUrl}${request.path}`, {
      method: request.method,
      headers: request.headers,
      body: request.body,
    });
    return { status: response.status, headers: Object.fromEntries(response.headers), body: await response.text() };
  }
}
