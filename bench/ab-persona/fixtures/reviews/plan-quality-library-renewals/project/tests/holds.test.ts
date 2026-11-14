import { expect, test } from "bun:test";
import { isOnHold } from "../src/holds";
import { memoryHolds } from "./fakes";

test("a waiting hold counts until its last day; a lapsed hold does not", async () => {
  const store = memoryHolds([{ itemId: "i-1", patronId: "p-2", placedOn: "2027-05-01", expiresOn: "2027-05-10" }]);
  expect(await isOnHold(store, "i-1", "2027-05-10")).toBe(true);
  expect(await isOnHold(store, "i-1", "2027-05-11")).toBe(false);
  expect(await isOnHold(store, "i-2", "2027-05-01")).toBe(false);
});
