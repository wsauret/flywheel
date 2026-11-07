# custom-provider-role-default

Reference: `reference.patch`, the fix against the bugged sandbox. It returns `src` to the base commit.

Base commit: `85c69871d53e3f1dba2532773dd7db38a93c41b3`, a public commit of `main` that holds the fix. `sandbox.patch` puts the defect back. The defect first shipped before the source became public, and its original fix was "fix(models): give every role a default model when only a custom provider is configured".

## The bug

A user whose only provider is a `[custom_providers.<id>]` endpoint in flywheel.toml can assign the chat model by hand, but every role without an assignment fails with "No assignable models were returned by provider listing". Custom provider models carry no catalog metadata, and tier resolution in `src/orchestration/config/model-tiers.ts` (`buildFamilyCatalog`) skips every model without metadata, so it has no candidate for an unassigned role.

## The requirement

When no catalog model is available, every unassigned role (agent roles and workflow step roles) must default to one of the user's custom models. Explicit role assignments stay. Users of catalog providers keep the same defaults. A model that the catalog describes as unable to call tools stays ineligible.

The original task required the first model in config order. The product no longer orders that way: the unranked fallback orders every model by release date, newest first, then by model id. A custom model has no release date, so the custom model with the lowest id wins (`alpha-coder` in test 1, `beta-local` in test 2). The user message asks for that existing order, and the acceptance asserts the exact model. The reference fix appends the models without metadata to the unranked fallback list, which the existing release-date and id sort orders. Other passing designs include a fallback that reads the custom provider registry, or custom provider metadata attached at listing time.

## Why it is a fair task

The error text leads to `model-tiers.ts`, but the cause is not at the throw. The solver must follow role resolution from the listed custom models into the family catalog and understand how tiers, ranks, and the unranked fallback interact. The fix must keep the ranked order for catalog providers and must still refuse a model described as unable to call tools.

## Acceptance

`acceptance/custom-provider-role-default.test.ts` builds the user's setup through the same boundaries production uses: it parses a `custom_providers` config section, installs it the way config loading does, lists models through the model listing client and the provider catalog resolver, and resolves roles for the `test` profile from the enabled models and metadata that this produces. It does not depend on where the fix lives.

1. A custom-only config with three models, with `chat` assigned by hand in `profiles.test.roles`: `chat` keeps its assignment, every other default role plus the workflow step role `brief.plan` resolves to `alpha-coder`, the first custom model in the unranked order, and the advisor keeps its default effort.
2. A second custom-only config with different models: every role resolves to `beta-local`, the first of that config's models in the unranked order.
3. Regression guard: for five catalog listings, role resolution gives every default role and the step role the fixed models recorded from the base, both for the catalog listing alone and for the same listing plus the custom models in the family the product lists them under (openai). The listings are the openai fixture; the google fixture, which has no openai catalog models, so the custom models are alone in their family; `gpt-5.5` alone, which leaves the mid and cheap price tiers empty; the anthropic, openai, and google fixtures together; and `gpt-6-preview` alone, an openai model that the catalog describes as able to call tools but that has no rate card, so it is in no price tier. The fixed tables catch a fix that changes catalog defaults for everyone. The google and `gpt-5.5` listings catch a fix that puts the custom models ahead of a catalog model only because a price tier or a family has no catalog model. The `gpt-6-preview` listing catches a fix that puts the custom models ahead of a described but unpriced catalog model in the unranked fallback.
4. Regression guard: when the only listed model is described as unable to call tools on text, role resolution either rejects or assigns that model to no role. The test goes through `resolveRoles` and does not depend on the error text.

Tests 3 and 4 pass on the bugged tree by design. The recorded defaults of test 3 come from the base commit; they differ from the earlier fixture's tables because the role set and the tier rules changed since then.

The fixture `userDataRoot` uses the nonexistent root `/scratch/flywheel-test` instead of a literal `/tmp` path, per the repository test rules.

## Validation

The sandbox is built from `task.json`: a git archive of the listed paths at the base, then `sandbox.patch`, `bun install`, and a baseline commit. `sandbox.patch` sets the bunfig test root to `.`. It removes the collection of models without metadata in `buildFamilyCatalog`, together with the comment that states the fix, and it removes the unit tests that assert the fix (`config-models-roles.test.ts`: the two tests about custom provider models without metadata; `model-tiers.test.ts`: the unpriced custom model test and the undescribed part of the unranked ordering test), so the unit suite passes on the bugged tree as it did before the fix.

- Bugged tree: 2 pass, 2 fail (both custom-only cases throw "No assignable models were returned by provider listing").
- Bugged tree plus `reference.patch`: 4 pass, 0 fail:

```
bun --env-file=.env.test --conditions=browser bench/chat-ab/check-task.ts custom-provider-role-default --apply-diff bench/chat-ab/tasks/custom-provider-role-default/reference.patch
```

## Design variant

- The shared model-selection fallback owns the decision for both agent roles and workflow step roles, rather than separate role-specific exceptions.
- Models without catalog information are last-resort candidates, not candidates with invented rankings or price tiers.
- Eligible catalog models remain ahead of undescribed custom models even when a requested price tier is empty or a catalog model has no price.
- Missing catalog information does not disqualify a custom model, but known lack of tool support still disqualifies a model.
- Explicit role assignments and effort defaults remain unchanged. Verification follows configuration loading, model listing, and role selection, and covers custom-only setups, workflow roles, mixed providers, and tool-support restrictions.
