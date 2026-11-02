# masked-registration: seeded defect rationale

The fixture seeds the masked-partial-registration defect class: a new registry entry is wired into one production consumer but not the other, and the change ships with a test that is green for a reason that has nothing to do with production wiring. Unlike a plainly missing feature, nothing here fails loudly. The suite passes before and after the diff, so the only way to catch the gap is to read where the registry is consumed and what the new test actually exercises.

The project tree is the pre-diff state and the diff is read against it, so a reviewer sees the second consumer's wiring exactly as the diff leaves it.

## missing-registration-site (backfill.ts)

The validator registry in registry.ts has two production consumers. Live ingest (ingest.ts) resolves validators per event, so adding payoutSettledValidator to PRODUCTION_VALIDATORS fully wires that path. The nightly backfill (backfill.ts) carries its own registration point: BACKFILLED_KINDS names the kinds the job replays from the provider archive, and runBackfill silently pushes any other kind into the skipped bucket by design, because the archive also carries kinds the service never consumes. The diff extends the kind union, the validator set, and the registry array, but never touches BACKFILLED_KINDS. The result is a silent production gap: live ingest accepts payout.settled events, and the recovery path that heals webhook outages drops them without any error. The skip-by-design branch is what keeps the gap quiet; a stricter backfill would have thrown on the unknown kind.

## self-registering-test-masks-gap (payout.test.ts)

The added test is the masking mechanism. It calls createValidatorRegistry([payoutSettledValidator]) to build a local registry that contains the new entry by construction, then asserts lookup and validation against that local registry. It never imports PRODUCTION_VALIDATORS, never calls ingestEvent, and never calls runBackfill. Its first assertion even reads like a registration check, which makes a skim conclude that registration is covered. Because the test supplies the entry it then finds, it passes in any tree where the validator object merely exists, including a tree where the diff registered nothing at all. A green run therefore proves nothing about either production consumer, and the un-wired backfill path stays invisible to the suite.

The pre-existing registry.test.ts exercises both production consumers through the production registry for the original kinds only, so it also stays green after the diff. Both catch criteria are satisfiable by reading the diff and the tree; neither requires executing the tests.
