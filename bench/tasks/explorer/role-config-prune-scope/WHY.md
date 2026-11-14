# Why this task exists

This question asks what the model picker's configuration cleanup deletes. A comment and an intent statement about pruning against a complete registry read as a model-listing check, but the cleanup compares role ids only, and a custom persona whose file is rejected drops out of that registry. The answer key lives only in `manifest.json` and this file, which the trial cannot read: its corpus is the pin, restricted to `src, AGENTS.md, docs/architecture.md, docs/architecture-intent, docs/product-intent, docs/terminology.md`.

## Verification at the pinned tree

Every reference below is `path:line` at commit `74d097f9c661f2e3b1e01c1731d69b6aa8dc2039`, with a snippet that occurs on that line or range. The snippets were checked mechanically against the pinned extract.

### Fact `role-id-membership`

The cleanup compares only role ids against the set of registered persona role ids; it never reads a model value or a provider listing.

- `src/orchestration/config/writer.ts:64-67`: `roleIds?: ReadonlySet<RoleId>;`
- `src/orchestration/config/writer.ts:417`: `if (roleId && validity.roleIds && !validity.roleIds.has(roleId)) {`

### Fact `runs-on-listing`

The cleanup runs on every model-assignment listing, guarded by a present validity set, enabled persistence, and a profile.

- `src/orchestration/config/model-assignments.ts:50`: `await pruneStaleConfigSections(deps);`
- `src/orchestration/config/model-assignments.ts:233-234`: `if (!deps.configValidity || deps.persistConfig === false`

### Fact `broken-persona-absent`

The registered set comes from the persona revision; a persona whose file is rejected has no valid candidate, so it gets no agent entry and its role id is absent from the set.

- `src/orchestration/app-service/model-assignment-service.ts:81`: `roleIds: personaRoleIds(revision.personas),`
- `src/infra/definition-resolution.ts:36`: `candidates.find((candidate) => candidate.kind === "valid")`
- `src/workflows/agents/registry.ts:256`: `const agents = new Map(resolutions.flatMap`

### Fact `section-removed`

A saved role section whose id is absent from the set is removed, and the file is rewritten.

- `src/orchestration/config/writer.ts:268-274`: `if (batch.validity) next = patchPrunedConfig(next`

### Fact `exempt-sections`

Some sections survive although their id is not a registered persona: retired brief seats, the agent roles, the default roles, and the auxiliary roles.

- `src/orchestration/config/writer.ts:418`: `if (retiredBriefSeatWorkflow(roleId) !== undefined) return true;`
- `src/orchestration/config/writer.ts:419`: `if (AGENT_ROLE_IDS.includes(roleId)) return true;`
- `src/orchestration/config/writer.ts:420`: `if (roleId in DEFAULT_ROLES) return true;`
- `src/orchestration/config/writer.ts:422`: `if (AUX_ROLE_IDS.includes(roleId)) return true;`

### Fact `unlisted-model-kept`

A saved model that the provider listing lacks is never deleted: the picker keeps it and shows it as the saved model.

- `src/orchestration/config/model-assignments.ts:79`: `...(savedModel && !isModelTierReference(savedModel)`

### Trap `prunes-unlisted-models`

Wrong answer: The picker deletes saved models that the provider's listing no longer returns.

Why a shallow trace reaches it: A comment and the runtime intent describe pruning against a complete registry, which reads like a model listing.

Misleading evidence:

- `src/orchestration/config/model-assignments.ts:33`: `The prune reads only the complete installed registry`

Refuted by:

- `src/orchestration/config/writer.ts:417`: `if (roleId && validity.roleIds && !validity.roleIds.has(roleId)) {`
- `src/orchestration/config/model-assignments.ts:79`: `...(savedModel && !isModelTierReference(savedModel)`

### Trap `broken-persona-kept`

Wrong answer: A persona whose file is broken stays registered, so its saved model setting is kept.

Why a shallow trace reaches it: The registry says a skipped persona is not silent for a workflow.

Misleading evidence:

- `src/workflows/agents/registry.ts:96`: `A skipped persona is not silent for a workflow.`

Refuted by:

- `src/workflows/agents/registry.ts:256`: `const agents = new Map(resolutions.flatMap`
- `src/infra/definition-resolution.ts:36`: `candidates.find((candidate) => candidate.kind === "valid")`
