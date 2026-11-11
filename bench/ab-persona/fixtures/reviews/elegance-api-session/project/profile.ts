import type { ApiClient } from "./api-client.ts";

export interface Profile {
  displayName: string;
}

export async function loadProfile(api: ApiClient): Promise<Profile> {
  const body = await api.get("/me");
  if (typeof body !== "object" || body === null || !("display_name" in body) || typeof body.display_name !== "string") {
    throw new Error("Profile response has no display_name");
  }
  return { displayName: body.display_name };
}
