# plan-quality-store-refunds: seeded defect rationale

## store-credit-destination-missing (summary, phase-1/t1, phase-1/t2, phase-2/t1)

REQUEST.md lists three destinations as a numbered list: the original payment method, a gift card, and store credit on the customer's account. The plan's summary restates the request with two of them and every task follows that narrower reading. Nothing in the plan excludes store credit or gives a reason, and the code makes the third destination easy to build: `addStoreCredit` in src/customers/credit.ts exists and `Sale.customerId` tells when a sale was made to an account. The plan cannot deliver the request as written, so this is a coverage gap. The summary's phrase "as REQUEST.md asks" makes the omission easy to miss on a skim.

## returns-import-caller-missed (phase-1/t2, phase-2/t1, key_files)

Phase-1/t2 makes the new destination parameter of `refundSale` required, "so that every caller states where the money goes", and phase-2 updates the till route. The key_files entry for src/till/routes.ts calls it "the caller of refundSale". There is a second caller: `importReturns` in src/jobs/returns-import.ts, which README.md describes as the nightly job that refunds web-shop returns, and tests/returns-import.test.ts exercises it. After phase 1 that call has three arguments where four are required, so the project stops type-checking, and the job needs `{ kind: "original" }` to keep refunding cards. The new `RefundDeps` fields also reach the job's construction. The plan neither updates the job nor lists it.

## What is intended

- The required parameter itself is a sound choice; the defect is the missed caller, not the signature.
- A gift-card refund of a cash sale is allowed on purpose: no card refund takes place.
- tests/routes.test.ts is a new file; postRefund has no test today.
- The refund record already has a `destination` field, so the end-of-day report needs no schema change; the constraint states this correctly.
