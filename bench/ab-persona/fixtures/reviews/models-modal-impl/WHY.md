# models-modal-impl: seeded defect rationale

## Provenance

`diff.patch` is the real Flywheel commit `5a917f28d` ("improve the models modal") over its parent `c6e8ee2d2`, with six mutations applied to the new side. The manifest pins `c6e8ee2d2`, so the harness archives the parent tree and the reviewer reads the diff against the codebase the change was written for.

Every file of the real commit under `src/` and `tests/` is included. The two Raindrop submodule pointer additions under `inspiration/` are left out, because a gitlink carries no reviewable content and the sandbox does not archive that directory. The commit's changes under `docs/` are left out too: they were maintainer plans and research notes that are not published, and no seeded defect is in them. The two file renames (`raindrop-inspiration-audit` to `raindrop-audit`) are preserved as renames.

No test needed adjustment. The mutated tree runs the unit suite with exactly the same result set as the unmutated commit, so no seeded defect is exposed by a failing assertion. Two tests (`register-summaries.test.ts`, `USER_FACING_IDS`) already fail at `5a917f28d` itself because the commit renames the `raindrop-inspiration-audit` workflow without updating the expected id list. That failure is genuine upstream content, not a seeded defect, and is not scored.

The mutations sit in the code the change already touches, so each one reads as part of the feature work. Four of the six need a file outside the changed hunks to convict: `writer.ts` and `model-assignments.ts` for the pruning defect, `create-dialog-modals.tsx` for the frozen scope toggle, `model-assignment-service.ts` for the snapshot refresh, and `model-modal.tsx` plus `listModelOptionsForSlot` for the step-agent group id.

## assignable-steps-user-invocable-filter (src/orchestration/workflow-registry-queries.ts)

The real change excludes skills from `getAssignableSteps` because skills run inline under the chat model and own no assignment slot. The mutation adds a second conjunct, `step["user-invocable"]`, with a comment that makes it sound like the same rule.

It is not the same rule. `user-invocable` says whether a user can start the step from the slash palette; it says nothing about whether the step runs under a model. Workflow-internal steps run as queue steps under `step.<id>`, and this roster is where those slots come from: `create-dialog-modals.tsx` passes `getAssignableSteps()` as `deps.steps`, `use-model-modal` turns it into `selectionSlots` with `buildRoleSlots`, and those slots ride the `modelAssignments` query into `listModelAssignments`. There `pruneStaleConfigSections` builds `ConfigValidity.roleIds` from `deps.slots`, and `patchPrunedConfig` in `writer.ts` deletes every `[roles."step.<id>"]` section outside that set. `stepDefinitionIds` is never populated by any caller, so nothing rescues the section. Opening the models modal therefore deletes the user's saved model and effort for every workflow-internal step, and those steps also disappear from Workflow Overrides.

## step-agent-role-precedence (src/orchestration/config/role-selection.ts)

`resolveSlotRole` resolved a step-agent slot as `roles.get(slot.roleId) ?? roles.get(agentRole) ?? step-worker`: most specific first. The mutation swaps the first two, justified by the fact that agent roles are now top-level rows.

The promotion changed where a row is drawn, not what a role id means. `step.<definitionId>.agent.<role>` is still the narrower assignment, and it is the one the modal writes when a user edits a subagent row inside a step. With the global persona role answering first, every config-side reader that goes through `resolveSlotRole` (`listModelAssignments`, `listEffortOptionsForSlot`, `ensureConcreteRoleAssignments`) reports the global value, while `resolveSubagentRole`, ten lines above and unchanged, still prefers the step-scoped slot at run time. The modal shows one model, the subagent runs on another, and a per-step override looks like it never saved.

## inherit-effort-options-model (src/orchestration/config/model-assignments.ts)

`listEffortOptionsForSlot` receives `model === null` exactly when the user picked the Inherit row, and an inheriting slot runs on the step-worker's model. The original computed `effectiveModel = model ?? stepWorker.model`. The mutation reorders the locals and computes `model ?? resolved.model`, which reads plausibly next to the `current: !raw.effort` inherit row.

`resolved` is the slot's currently resolved role, which for a slot with an explicit model is the model the user is in the middle of abandoning. The effort tiers therefore come from `effortOptionsForModel` for the wrong model: a slot leaving a model that declares `xhigh`/`max` can save an effort the inherited model does not support, and a slot leaving a narrower model loses tiers the inherited model does support. The inherit row label still reads `Inherit Steps: <step-worker effort>`, so the list contradicts its own header.

## scope-toggle-frozen-at-hook-creation (src/tui/model-modal/use-model-modal.ts)

`scopeToggleAvailable` was `createMemo(() => deps.foregroundSessionId?.() !== undefined)`. The mutation reads the accessor once into `hasForegroundSession` and returns it from a plain function, with a comment about avoiding work per render.

`useModelModal` is constructed once by `createDialogModals` while the shell mounts, before any session tab is in the foreground, so the captured value is `false` for the process lifetime. `toggleScope` returns early, so `g` never switches scope; `scopeHelp` never renders the hint; and `modelModalState().scopeToggleAvailable` is permanently false. Meanwhile `openModelsModal` still reads `deps.foregroundSessionId?.()` live and opens in session scope, so the modal announces session scope with no way back to defaults. This is the store-value-copied-into-a-local failure the project's reactivity rules name directly: state drives the view, the view never snapshots state.

## group-id-excludes-step-agents (src/tui/model-modal/model-modal-helpers.ts)

The real change reduced `groupIdForSlot` to `isStepSlot(slot) ? "steps" : undefined`. The mutation excludes step-agent slots from the steps group, reasoning that subagent rows follow their now top-level agent role.

Step-agent slots are still step slots everywhere else. `listModelOptionsForSlot` renders a selectable Inherit row for every `isStepSlot` slot, and `buildModelModalGroupItems` still nests subagent rows under their step inside the steps group. Three readers break at once in `use-model-modal.ts`: `saveEffort`'s guard `if (model === null && !groupIdForSlot(slot)) return` silently swallows the Inherit choice for a subagent row, with no toast and no error; `returnViewForSlot` and `itemsForSlot` return the user to the top-level list instead of the Workflow Overrides group after an edit, placing the cursor by an index computed against the wrong list; and `modalTitle` drops the group segment that exists precisely because subagent labels are not unique ("Reviewer" appears under many steps).

## session-save-skips-snapshot-refresh (src/tui/model-modal/use-model-modal.ts)

`saveEffort` refreshed the foreground role projection with `if (scope === "session" || mirrored)`. The mutation keeps only `mirrored`, which looks like a simplification because a compound write is the case that touches both surfaces.

`mirrored` is set only by the `defaults-and-session` branch of `saveEffort` in `model-assignment-service.ts`; a session-scope save returns `{ label }` with no `mirrored` field, so `result.mirrored ?? false` is false. The one scope whose write changes the live tab's roles is now the one scope that never calls `onSnapshotChanged`, so the prompt bar and footer keep rendering the previous model until the tab is reloaded.
