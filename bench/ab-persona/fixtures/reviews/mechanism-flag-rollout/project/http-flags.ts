import type { FetchFlags, FlagSet } from "./types.ts";

/** Fetch flags from the flag service. Rejects on a non-2xx status or a body
 *  that is not a flag set, so a bad response never reaches the client. */
export function httpFetchFlags(baseUrl: string, fetchImpl: typeof fetch): FetchFlags {
  return async () => {
    const response = await fetchImpl(`${baseUrl}/flags`);
    if (!response.ok) throw new Error(`flag service answered ${response.status}`);
    const body = (await response.json()) as Partial<FlagSet>;
    if (typeof body.revision !== "number" || typeof body.flags !== "object" || body.flags === null) {
      throw new Error("flag service returned a malformed flag set");
    }
    return { revision: body.revision, flags: body.flags };
  };
}
