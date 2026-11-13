import type { Role, UserDirectory } from "./users";

export interface AdminContext {
  readonly actorId: string;
  readonly users: UserDirectory;
}

/** DELETE /admin/users/:id */
export async function handleRemoveUser(userId: string, context: AdminContext): Promise<Response> {
  if (!(await context.users.remove(userId))) return Response.json({ error: "Unknown user" }, { status: 404 });
  return new Response(null, { status: 204 });
}

/** PUT /admin/users/:id/role with body { "role": "member" | "admin" } */
export async function handleSetRole(userId: string, request: Request, context: AdminContext): Promise<Response> {
  const body: unknown = await request.json().catch(() => undefined);
  const role = typeof body === "object" && body !== null && "role" in body ? body.role : undefined;
  if (role !== "member" && role !== "admin") return Response.json({ error: "role must be member or admin" }, { status: 400 });
  if (!(await context.users.setRole(userId, role satisfies Role))) return Response.json({ error: "Unknown user" }, { status: 404 });
  return new Response(null, { status: 204 });
}
