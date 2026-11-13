import { expect, test } from "bun:test";
import { isExpired, SESSION_TTL_MS } from "../src/auth/sessions";

test("a session expires twelve hours after it was created", () => {
  const session = { id: "s1", userId: "u1", createdAt: 1_000 };
  expect(isExpired(session, 1_000 + SESSION_TTL_MS - 1)).toBe(false);
  expect(isExpired(session, 1_000 + SESSION_TTL_MS)).toBe(true);
});
