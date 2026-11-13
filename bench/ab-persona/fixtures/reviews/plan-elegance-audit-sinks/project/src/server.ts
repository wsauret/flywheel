import { handleRemoveUser, handleSetRole, type AdminContext } from "./admin/routes";
import type { UserDirectory } from "./admin/users";
import { parseConfig } from "./config";

/** The composition root. The session proxy in front of the console sets x-actor-id on every admin request. */
export function startServer(env: Record<string, string | undefined>, users: UserDirectory) {
  const config = parseConfig(env);
  return Bun.serve({
    port: config.port,
    async fetch(request) {
      const context: AdminContext = { actorId: request.headers.get("x-actor-id") ?? "unknown", users };
      const url = new URL(request.url);
      const user = url.pathname.match(/^\/admin\/users\/([^/]+)$/);
      if (user?.[1] !== undefined && request.method === "DELETE") return handleRemoveUser(user[1], context);
      const role = url.pathname.match(/^\/admin\/users\/([^/]+)\/role$/);
      if (role?.[1] !== undefined && request.method === "PUT") return handleSetRole(role[1], request, context);
      return new Response("Not found", { status: 404 });
    },
  });
}
