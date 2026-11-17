// Vendored from https://github.com/K-Mistele/anti-slop (src/effect), MIT License,
// Copyright (c) 2026 Dillon Mulroy. THIRD-PARTY-NOTICES.md carries the license text.
import { eslintCompatPlugin } from "@oxlint/plugins";

import { noManualEffectErrorTagRule } from "./rules/no-manual-effect-error-tag.ts";
import { noOrDieInServiceConstructionRule } from "./rules/no-ordie-in-service-construction.ts";
import { noServiceParametersRule } from "./rules/no-service-parameters.ts";
import { noTestCodeInSrcRule } from "./rules/no-test-code-in-src.ts";
import { preferTaggedErrorHandlingRule } from "./rules/prefer-tagged-error-handling.ts";
import { preferYieldServiceRule } from "./rules/prefer-yield-service.ts";
import { requireCauseWhenNarrowingRule } from "./rules/require-cause-when-narrowing.ts";

/** Oxlint rules for Effect service and Layer architecture. */
const antiSlopEffectPlugin = eslintCompatPlugin({
	meta: { name: "anti-slop-effect" },
	rules: {
		"no-manual-effect-error-tag": noManualEffectErrorTagRule,
		"no-ordie-in-service-construction": noOrDieInServiceConstructionRule,
		"no-service-parameters": noServiceParametersRule,
		"no-test-code-in-src": noTestCodeInSrcRule,
		"prefer-tagged-error-handling": preferTaggedErrorHandlingRule,
		"prefer-yield-service": preferYieldServiceRule,
		"require-cause-when-narrowing": requireCauseWhenNarrowingRule,
	},
});

export default antiSlopEffectPlugin;
