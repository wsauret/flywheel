import { expect, test } from "bun:test";
import { PaymentDeclined } from "../src/payments";
import { postNewPermit } from "../src/routes";
import { MemoryPermitRepo } from "./memory-permit-repo";

test("a declined card buys no permit", async () => {
  const permits = new MemoryPermitRepo();
  const response = await postNewPermit(
    { permits, payments: { charge: async () => { throw new PaymentDeclined(); } }, newId: () => "p-9" },
    { residentId: "r-1" },
    { zone: "A", plate: "AV12 KDP", cardToken: "tok", expiresOn: "2027-06-30" },
  );
  expect(response.status).toBe(402);
  expect(permits.permits.size).toBe(0);
});
