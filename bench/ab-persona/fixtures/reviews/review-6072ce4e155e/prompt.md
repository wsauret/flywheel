Review this completed change.

CHANGE (uncommitted; other agents also edit this tree, so review only these paths with `git diff -- <path>`; the new test file is untracked, read it directly):
src/infra/llm/provider-error-copy.ts
src/orchestration/agent-runtime/llm/provider-availability-types.ts
src/orchestration/subscription-spend-consent/admission-capture.ts
src/orchestration/agent-runtime/factory.ts
src/orchestration/agent-runtime/llm/client-factory.ts
src/orchestration/agent-runtime/llm/failover-client.ts
tests/unit/infra/llm/provider-error-copy.test.ts
tests/unit/orchestration/agent-runtime/llm/failover-client-failover.test.ts
tests/unit/orchestration/subscription-spend-consent/admission-capture.test.ts (new)
tests/unit/orchestration/agent-runtime/llm/client-factory-subscription-consent.test.ts
tests/unit/orchestration/agent-runtime/llm/client-factory.test.ts
tests/unit/orchestration/agent-runtime/llm/client-factory-account-binding.test.ts
tests/unit/orchestration/agent-runtime/llm/candidate-owner-regressions.test.ts
docs/product-intent/model-access.md (PI-MODEL-006 sentence)

PROJECT CONTEXT PATHS:
docs/product-intent/model-access.md (PI-MODEL-006, PI-MODEL-018)
docs/architecture-intent/README.md
docs/guides/elegance.md

ASSIGNED CLAIMS:
1. "A headless service has not read the ChatGPT account, so its published state has no snapshot and the resolver answers false" (headless pool uses monitor:false, src/orchestration/headless/headless-profile-runtime.ts:48-65). Verify whether headless ever publishes a snapshot with resetCredits (e.g. an allowance factory or capture that triggers a check).
2. "The hint sentence appears in the copy `message` and therefore in TUI notices, web notices, workflow step failures (providerErrorProse), and headless output." Verify the message field reaches those registers.
3. "The only source is the in-memory publication; no durable read was added."

DESIGN CONTEXT:
- Design intent (fixed): carried in your request context (approved unit B: banked-reset hint, interactive clients only).
- implementation design (revisable): a `bankedResetFor` resolver captured in captureSubscriptionAdmission from `lease.service.snapshot()`, threaded through RequestAdmission and ProviderChainDeps to exhaustedChainError; exhaustedProvidersCopy rows gain `bankedReset?: boolean`; sentence "<Provider> has a banked reset. Open Usage (/usage) to apply it." appended to message for quota-cause rows.
- patterns: existing resolvers subscriptionSpendAuthorizationFor / subscriptionAllowanceFor.
- constraints: no prediction whether the reset helps; title unchanged; no durable read per request; no headless-specific code.
- recorded deviations: (1) resolver does not compare the snapshot generation with the service's current generation, matching usage-projection.ts:267-268; (2) added new test file admission-capture.test.ts because no test owned captureSubscriptionAdmission generally; (3) SubscriptionAdmissionCapture.bankedResetFor is required, so four fixtures got `bankedResetFor: () => false`; (4) requestAdmissionFromCaptures now takes the whole SubscriptionAdmissionCapture.

Check the change against the Design intent and the authorities in PROJECT CONTEXT PATHS as well as for defects. A contradiction with an authority is drift; cite its file and line. Classify each recorded deviation and each discrepancy you find as consistent with the Design intent or as drift, with evidence; a deviation from implementation design alone is not drift. Report the classification and do not decide whether a deviation is acceptable.

Use code-scope locations: <repo-relative-path> or <repo-relative-path>:<line>.
Investigate ambiguous, incomplete, or unverified evidence with targeted commands or mechanism verification before reporting it. If evidence remains unavailable, name the checks attempted, the missing proof, and the concrete failure mode. Do not write files. Return prose findings, one block each with Title, Severity, Location, Failure, and Fix, or state No findings.

Before assessing your domain, read the project context paths that bear on this change. Mandatory elegance applies to every domain.

Output discipline: prose findings with Title, Severity, Location, Failure, Fix; concrete locations; Failure as `<Principle name>. <Intent>. <Observation>. <Reasoning>.`; concrete Fix; keep UNVERIFIED tags on unresolved runtime claims; the Design intent binds you; hardening findings name a reachable trigger or cap at P3.