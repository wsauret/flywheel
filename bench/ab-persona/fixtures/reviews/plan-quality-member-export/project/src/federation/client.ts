export class FederationError extends Error {}

export interface FederationClient {
  /** Upload one member CSV. Throws FederationError when the registry does not accept it. */
  uploadMembers(csv: string): Promise<void>;
}

export function httpFederationClient(baseUrl: string, apiKey: () => string): FederationClient {
  return {
    async uploadMembers(csv) {
      const response = await fetch(`${baseUrl}/registry/members`, {
        method: "POST",
        headers: { "content-type": "text/csv", authorization: `Bearer ${apiKey()}` },
        body: csv,
      });
      if (!response.ok) throw new FederationError(`The registry answered ${response.status}`);
    },
  };
}
