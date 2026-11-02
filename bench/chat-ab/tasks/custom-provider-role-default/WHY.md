# custom-provider-role-default

Fix commit: `92a20a5fd825b86027eb1f99ef0546c7ab9458b7` fix(models): give every role a default model when only a custom provider is configured

Base commit: `9566f479561ba85f83d73907f1451b672e3ae741` (the parent of the fix)

## The bug

A user whose only provider is a `[custom_providers.<id>]` endpoint in flywheel.toml can assign the chat model by hand, but every role without an assignment fails with "No assignable models were returned by provider listing". Custom provider models carry no catalog metadata, and tier resolution in `src/orchestration/config/model-tiers.ts` ignored every model without metadata, so it had no candidate for an unassigned role.

## The requirement

When no catalog-ranked model is available, every unassigned role (agent roles and workflow step roles) must default to the user's custom models, starting with the first model in the order the user listed them in config. Explicit role assignments stay. Users of catalog providers keep the same defaults. A model that the catalog describes as unable to call tools stays ineligible.

The reference fix is one design among several that meet this: it collects the models without metadata and appends them, in the order the listing returns them (which is the config order), after every described model in the unranked fallback list. Other passing designs include a fallback that reads the custom provider registry in config order, or custom provider metadata attached at listing time with config ordering.

## Why it is a fair task

The error text leads to `model-tiers.ts`, but the cause is not at the throw. The solver must follow role resolution from the listed custom models into the family catalog and understand how tiers, ranks, and the unranked fallback interact. The fix must keep the ranked order for catalog providers, must honor the config order of the custom models, and must still refuse a model described as unable to call tools.

## Acceptance

`acceptance/custom-provider-role-default.test.ts` builds the user's setup through the same boundaries production uses: it parses a `custom_providers` config section, installs it the way config loading does, lists models through the model listing client and the provider catalog resolver, and resolves roles from the enabled models and metadata that this produces. It does not depend on where the fix lives.

1. A custom-only config with three models listed in an order that is neither sorted nor reverse sorted, with `chat` assigned by hand: `chat` keeps its assignment, and every other default role plus a workflow step role resolves to the first listed model.
2. A second custom-only config with different models: every role resolves to that config's first listed model.
3. Regression guard: for five catalog listings, role resolution gives every default role and a step role the fixed models recorded from the base, both for the catalog listing alone and for the same listing plus the custom models in the family the product lists them under (openai on the base). The listings and their recorded defaults (powerful, mid, cheap roles) are: the openai fixture (`gpt-5.5`, `gpt-5.4`, `gpt-5-nano`); the google fixture, which has no openai catalog models, so the custom models are alone in their family (`gemini-2.5-pro`, `gemini-2.5-pro`, `gemini-2.5-flash`); `gpt-5.5` alone, which leaves the mid and cheap price tiers empty (`gpt-5.5` for every role); the anthropic, openai, and google fixtures together (`claude-opus-4.6`, `claude-sonnet-4.6`, `claude-haiku-4.5`); and `gpt-6-preview` alone, an openai model that the catalog describes as able to call tools but that has no rate card (pricing `{ status: "unavailable", reason: "missing-rate-card" }`), so it is in no price tier (`gpt-6-preview` for every role). The test adds the `gpt-6-preview` metadata to the catalog options and the mixed options next to the shared fixture metadata. The reference fix gives the same defaults. The fixed tables catch a fix that changes catalog defaults for everyone, which a comparison against the solver's own catalog-only result cannot catch. The google and `gpt-5.5` listings catch a fix that puts the custom models ahead of a catalog model only because a price tier or a family has no catalog model, which is not "when Flywheel knows nothing better". The `gpt-6-preview` listing catches a fix that puts the custom models ahead of a described but unpriced catalog model in the unranked fallback. The catalog knows that model, so Flywheel knows something better than the custom models.
4. Regression guard: when the only listed model is described as unable to call tools on text, role resolution either rejects or assigns that model to no role. The test goes through `resolveRoles` and does not depend on the error text.

Tests 3 and 4 pass on the base by design. Models with new names are used in each case because the base registry treats a reordering of the same model set as no change.

The fixture `userDataRoot` uses the nonexistent root `/scratch/flywheel-test` instead of a literal `/tmp` path, per the repository test rules.

## Validation

The sandbox was built from `task.json` (git archive of the listed paths at the base, `sandbox.patch` sets the bunfig test root to `.`, baseline commit, `bun install`). The base has no `.env.test`, so the path list leaves it out.

Overlay command: `bun --conditions=browser bench/chat-ab/check-task.ts custom-provider-role-default --overlay 92a20a5fd825b86027eb1f99ef0546c7ab9458b7:. --overlay-files src/orchestration/config/model-tiers.ts`

- Base: 2 pass, 2 fail (both custom-only cases throw "No assignable models were returned by provider listing").
- Base plus the fix commit's `src` change: 4 pass, 0 fail.
- Recorded runs `baseline-r0` and `baseline-r1` (two different designs): 4 pass, 0 fail each.
- Mutants checked by hand: sorting the custom models alphabetically fails tests 1 and 2; admitting models described as unable to call tools into the fallback fails test 4.
- Mutant: emptying every ranked tier and returning all eligible models in listing order (custom roles pass, but every catalog role gets the first listed catalog model) fails test 3.
- Mutant: catching the tier failure in role resolution and taking the first available model of any kind fails test 4.
- Mutant (reviewer): the reference fix plus filling every price tier that has no catalog model in a family with the custom models in listing order. It passes the openai fixture listing, but gives `mistral-coder` to google-listing roles and to the mid and cheap roles of the `gpt-5.5` listing. It fails test 3 (3 of 4).
- Mutant: the reference fix plus, in cross-family role resolution, returning the first custom model when no family has a catalog model at the requested price tier, before the walk to the neighboring tiers. It also passes the openai fixture listing and fails test 3 on the google and `gpt-5.5` listings (3 of 4).
- Mutant: the reference fix with the models without metadata placed before, not after, the described unpriced models in the unranked fallback list. It passes tests 1, 2, and 4 and the four priced listings, and gives `mistral-coder` to every role of the `gpt-6-preview` listing. It fails test 3 (3 of 4).

## Design variant

- The shared model-selection fallback owns the decision for both agent roles and workflow step roles, rather than separate role-specific exceptions.
- Models without catalog information are last-resort candidates in listing order, not candidates with invented rankings or price tiers.
- Eligible catalog models remain ahead of undescribed custom models even when a requested price tier is empty or a catalog model has no price.
- Missing catalog information does not disqualify a custom model, but known lack of tool support still disqualifies a model.
- Explicit role assignments and effort defaults remain unchanged. Verification follows configuration loading, model listing, and role selection, and covers custom-only setups, workflow roles, mixed providers, and tool-support restrictions.
