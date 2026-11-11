# elegance-flag-gate: seeded defect rationale

## feature-gate-shallow-wrapper (feature-gate.ts, checkout-page.ts, search-page.ts)

`FeatureGate.isOn(feature, userId)` returns `this.flags.isEnabled(feature, userId)` and does nothing else. It renames one method and adds a type, a constructor dependency, and a construction step for every caller. Its doc comment gives a reason that does not hold: `FlagStore` already does not know how flags are delivered (rules arrive through `load`), and a page that wants a narrower dependency can take `Pick<FlagStore, "isEnabled">` without a new class. Nothing in the change uses the wrapper for a second implementation, a test double, caching, or a policy. The elegant shape keeps the pages on `FlagStore.isEnabled` and adds only the express-shipping line.

The class looks deliberate on a skim: it has a doc comment that sounds like dependency inversion, and both pages were moved to it consistently.

The rest of the change is intended: the express-shipping flag check is the feature, and the flag names are the config service's identifiers.
