import { expect, test } from "bun:test";
import { handleRemoveUser, handleSetRole } from "../src/admin/routes";

const users = { remove: async (id: string) => id === "u1", setRole: async (id: string) => id === "u1" };

test("removing an unknown user is 404", async () => {
  expect((await handleRemoveUser("u9", { actorId: "a1", users })).status).toBe(404);
});

test("an invalid role is 400", async () => {
  const request = new Request("http://console/admin/users/u1/role", { method: "PUT", body: JSON.stringify({ role: "owner" }) });
  expect((await handleSetRole("u1", request, { actorId: "a1", users })).status).toBe(400);
});
