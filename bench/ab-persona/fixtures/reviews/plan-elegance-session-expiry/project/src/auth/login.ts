import { createSession, type SessionRepo } from "./sessions";

export interface Credentials {
  verify(username: string, password: string): Promise<string | undefined>;
}

/** POST /login with { username, password }. Sets the session cookie. */
export async function handleLogin(request: Request, credentials: Credentials, repo: SessionRepo, now: number = Date.now()): Promise<Response> {
  const body: unknown = await request.json().catch(() => undefined);
  const input = typeof body === "object" && body !== null ? { ...body } : {};
  const username = "username" in input && typeof input.username === "string" ? input.username : "";
  const password = "password" in input && typeof input.password === "string" ? input.password : "";
  const userId = await credentials.verify(username, password);
  if (userId === undefined) return Response.json({ error: "Wrong username or password" }, { status: 401 });
  const session = await createSession(repo, userId, now);
  return new Response(null, { status: 204, headers: { "set-cookie": `sid=${session.id}; HttpOnly; Secure; SameSite=Lax; Path=/` } });
}
