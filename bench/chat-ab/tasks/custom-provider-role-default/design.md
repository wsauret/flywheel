I use only a custom OpenAI-compatible endpoint with several models listed in my configuration. Chat works when I pick its model myself, but unassigned agent roles and workflow steps fail because my models have no catalog information. I want those roles to get usable defaults without assigning each one by hand.

Handle this in the shared model-selection fallback, so agent roles and workflow steps follow the same rule. Keep models without catalog information as last-resort candidates, in the order I listed them. Do not invent rankings or put them into price tiers.

Keep the existing selection rules for catalog models. Try eligible catalog models before custom models without catalog information, even when the requested price tier is empty or a catalog model has no price. Missing catalog information must not disqualify a custom model, but a model known to lack tool support must remain ineligible.

Keep my explicit role assignments and existing effort defaults unchanged. With only my custom endpoint available, every unassigned role must use the first model I listed. Verify this through configuration loading, model listing, and role selection. Run the relevant tests for custom-only setups, workflow roles, mixed providers, and tool-support restrictions.
