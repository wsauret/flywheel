import { expect, test } from "bun:test";
import { MemberStore } from "../src/members";

test("an officer's edit moves updatedAt; the payment sync's status write does not", () => {
  let now = new Date("2027-04-01T10:00:00Z");
  const store = new MemberStore(() => now);
  store.create({ id: "m-1", name: "Jo Park", email: "jo@example.com", membershipType: "adult" });
  now = new Date("2027-04-02T10:00:00Z");
  expect(store.update("m-1", { membershipType: "family" }).updatedAt).toEqual(now);
  const edited = now;
  now = new Date("2027-04-03T10:00:00Z");
  const lapsed = store.setStatus("m-1", "lapsed");
  expect(lapsed.status).toBe("lapsed");
  expect(lapsed.updatedAt).toEqual(edited);
});
