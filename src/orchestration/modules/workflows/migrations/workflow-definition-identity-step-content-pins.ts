import type { ToolScoping } from "../../../../infra/workflow-types.js"

/** Frozen identity evidence of the last build before the step-content cutover.
 *
 *  That build recorded a workflow identity with `bindings` and
 *  `handoffRegistry` members. The cutover deletes the handoff registry and the
 *  workflow bindings, so the step-content identity migration cannot recompute
 *  the hashes that a paused run recorded. These tables hold them as plain
 *  history: the values are fixed as that build produced them, and a later edit
 *  to a step or an output contract must not move them.
 *
 *  Both hashes come from `hashDefinition` in `src/workflows/definition-hash.ts`:
 *  SHA-256 in lowercase hex over canonical JSON, where object keys sort by
 *  `localeCompare`, an `undefined` member drops, and arrays keep their order.
 *  A binding hash covers the canonical binding record, which is the authored
 *  binding decoded strictly with its defaults filled, plus its `bindingId`. A
 *  handoff entry hashes its `fields`, its `rules` (or `[]`), and its
 *  `artifactPathFields` (or `[]`) one at a time. */

/** One handoff type at the revision the last pre-cutover build installed. */
export interface LegacyHandoffContractPin {
  readonly name: string
  readonly contractRevision: number
  readonly fieldsSha256: string
  readonly rulesSha256: string
  readonly artifactPathFieldsSha256: string
}

/** One workflow binding as the last pre-cutover build recorded it. Its
 *  `toolScoping` is the scope that build read from the shipped file, which
 *  the file no longer states, because steps stopped reading the key. */
export interface LegacyBindingPin {
  readonly bindingId: string
  readonly skillId: string
  readonly handoff: string
  readonly toolScoping: ToolScoping
  readonly sha256: string
}

/** Every tool scope a shipped binding granted. */
const FULL: ToolScoping = { read: true, bash: true, search: true, list: true, write: true, edit: true, subagent: true }
const INSPECT: ToolScoping = { read: true, bash: true, search: true, list: true, write: false, edit: false, subagent: false }
const FIX: ToolScoping = { ...INSPECT, write: true, edit: true }
const MAP: ToolScoping = { ...FULL, edit: false }
const SEED: ToolScoping = { ...INSPECT, search: false, list: false }

/** Pins the identity entry of every installed handoff type at its last revision.
 *  Remove after 2027-04-30. */
export const LEGACY_HANDOFF_CONTRACTS: readonly LegacyHandoffContractPin[] = [
  { name: "work-handoff", contractRevision: 6, fieldsSha256: "deeb67d82fc0459d03fac36aac8ca4331ea93f0fe51e74adc9f3ac22372581b8", rulesSha256: "6926183f9debac3ad3dedaf097cdd8e067cb66b257050f08090ace75eb10555c", artifactPathFieldsSha256: "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945" },
  { name: "research-handoff", contractRevision: 1, fieldsSha256: "d20994a0abb052feb6402af16c8b8018ddc990e4cf305df35ca984424ae36600", rulesSha256: "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945", artifactPathFieldsSha256: "89eb7589bc17fde135b76afb54f5e633382cf1281eb3bab6b9fa8f2dec719daf" },
  { name: "spec-handoff", contractRevision: 7, fieldsSha256: "bbd9a3d9ef50a88fda1e678c02bf76967d1dd228ed9b39c62462ca53109d9597", rulesSha256: "6def0f6f815ae463c550cac1ac47541532f40a18d3a352c9e05b12255a2c4d65", artifactPathFieldsSha256: "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945" },
  { name: "review-handoff", contractRevision: 4, fieldsSha256: "b57842cba555ea283c29b61fccaba0597bb66ea5a4ea3acbf965f12a59afa5ba", rulesSha256: "05efe24f241a28b2f92080c690f18d3721c17ca3287d555c88cbfbec657a8cd7", artifactPathFieldsSha256: "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945" },
  { name: "debug-handoff", contractRevision: 5, fieldsSha256: "bec99e132a9843232e538ff55be9dab78e2faed71cf7e2f75b266b9f10ef1208", rulesSha256: "05efe24f241a28b2f92080c690f18d3721c17ca3287d555c88cbfbec657a8cd7", artifactPathFieldsSha256: "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945" },
  { name: "qa-surface-map-handoff", contractRevision: 1, fieldsSha256: "983725da0727864c2d9095e1c1418618dc06e532a7cafc5c5d1fde6c2f9130d2", rulesSha256: "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945", artifactPathFieldsSha256: "e0b0bd0e98c0d74461350da18c5e88f96b9437250c1a6f3c38cade5fa4c1e0a2" },
  { name: "qa-findings-handoff", contractRevision: 4, fieldsSha256: "b70c377fcb719156133341b9477a13ab16251a35680d0cb03f0f545d4b9223d8", rulesSha256: "05efe24f241a28b2f92080c690f18d3721c17ca3287d555c88cbfbec657a8cd7", artifactPathFieldsSha256: "ab24f9b683a582f6b912c7698fc82d106b988a68c6471011baafcc4f376d3e9d" },
  { name: "qa-contest-handoff", contractRevision: 4, fieldsSha256: "c64efdd9a659e45d3d490129e1e6f890d9a79e795b2f08f1a2e26c356fd1e656", rulesSha256: "05efe24f241a28b2f92080c690f18d3721c17ca3287d555c88cbfbec657a8cd7", artifactPathFieldsSha256: "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945" },
  { name: "definition-improvement-proposal", contractRevision: 2, fieldsSha256: "70f9b61bb42d7ef89186975d74e177c9a6356a38a8165a3ebe81db5aab758198", rulesSha256: "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945", artifactPathFieldsSha256: "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945" },
  { name: "inspiration-improvement-batch", contractRevision: 1, fieldsSha256: "8d86f97ebb489d793d5f7b48349e07d36df9d1af1c87f1a9aeb37aa12dfae10f", rulesSha256: "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945", artifactPathFieldsSha256: "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945" },
  { name: "reassessment-handoff", contractRevision: 1, fieldsSha256: "2c930a6994fe7ace7ddb2c48e06f55916a443fef851df99fb52df5f20da9ebde", rulesSha256: "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945", artifactPathFieldsSha256: "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945" },
]

/** Pins each binding of the six shipped workflows, keyed by workflow id: the
 *  bound skill, the handoff type, and the binding hash the identity recorded.
 *  Remove after 2027-04-30. */
export const LEGACY_WORKFLOW_BINDINGS = {
  implement: [
    { bindingId: "implement", skillId: "fly.implement", handoff: "work-handoff", toolScoping: FULL, sha256: "6f3ea30a86496de0da043a561d9c56d2bb5f707565a1bfb34f8b604281778aa3" },
    { bindingId: "spec-create", skillId: "fly.spec-create", handoff: "spec-handoff", toolScoping: FULL, sha256: "d5ebf6b66ecf928f290bc5992dceff95e05226eb4cc98e648b4c1f6a76afa36f" },
    { bindingId: "spec-review", skillId: "fly.spec-review", handoff: "spec-handoff", toolScoping: FULL, sha256: "2d8bddf232ed7bbfcfdbf23e4efdc0cc489ae4d31c7286b3e1a2ea6ccd9bbf87" },
  ],
  debug: [
    { bindingId: "fix", skillId: "debug.fix", handoff: "debug-handoff", toolScoping: FIX, sha256: "4d67a73e627c537bc8f1de47b82ecac2f7ac12780d56a699d74ef9eb40de67a4" },
    { bindingId: "investigate", skillId: "debug.investigate", handoff: "debug-handoff", toolScoping: INSPECT, sha256: "dd6a0d1978bcc3eeb30b325f872fadb81daa4e61381a4944943175f8c07e7bf9" },
    { bindingId: "verify", skillId: "debug.verify", handoff: "debug-handoff", toolScoping: INSPECT, sha256: "8e9ca7892dd78c87b34d5efa5b2844b8d339c5eb47ec81a7b2fe956ac14ff0f4" },
  ],
  qa: [
    { bindingId: "review-fixes", skillId: "qa.review-fixes", handoff: "qa-contest-handoff", toolScoping: MAP, sha256: "4044fba1a0beeb5e22ed2f9f68220f62d176b60ec1dc2be322157c2507089cda" },
    { bindingId: "surface-map", skillId: "qa.surface-map", handoff: "qa-surface-map-handoff", toolScoping: MAP, sha256: "df82f62acbbcdf5020857af9531e4ecce34b837ab0b9bf23fe6af4d50121276b" },
    { bindingId: "test-fix-surface", skillId: "qa.test-fix-surface", handoff: "qa-findings-handoff", toolScoping: FULL, sha256: "7eee69aa8ee3fffe28235e3ce555830bbce828d92869723c4af9a53b159e1fd4" },
  ],
  "bench-implement": [
    { bindingId: "implement", skillId: "fly.implement", handoff: "work-handoff", toolScoping: FULL, sha256: "6f3ea30a86496de0da043a561d9c56d2bb5f707565a1bfb34f8b604281778aa3" },
    { bindingId: "seed-plan", skillId: "bench.seed-plan", handoff: "spec-handoff", toolScoping: SEED, sha256: "33ec2cacd9c84aa0db85e9605bf9c188cd14f2d354af2a779e3dc66b5b3b2e2d" },
  ],
  "bench-plan": [
    { bindingId: "spec-create", skillId: "fly.spec-create", handoff: "spec-handoff", toolScoping: FULL, sha256: "d5ebf6b66ecf928f290bc5992dceff95e05226eb4cc98e648b4c1f6a76afa36f" },
  ],
  "raindrop-audit": [
    { bindingId: "raindrop-audit", skillId: "fly.raindrop-audit", handoff: "inspiration-improvement-batch", toolScoping: FULL, sha256: "b5f2e3ee1c0115a2201e758f7174a07886b3d9d54ad8cdd76bff75a88dce0380" },
  ],
} satisfies { readonly [workflowId: string]: readonly LegacyBindingPin[] }
