// Vendored and adapted from https://github.com/K-Mistele/anti-slop, a fork of
// https://github.com/dmmulroy/anti-slop, MIT License, Copyright (c) 2026 Dillon Mulroy.
// THIRD-PARTY-NOTICES.md carries the license text.
import { eslintCompatPlugin } from "@oxlint/plugins";

import { maxTernaryDepthRule } from "./rules/max-ternary-depth.ts";
import { noChainedTypeAssertionsRule } from "./rules/no-chained-type-assertions.ts";
import { noConditionalSpreadRule } from "./rules/no-conditional-spread.ts";
import { noKnownValueWideningRule } from "./rules/no-known-value-widening.ts";
import { noModuleMockingRule } from "./rules/no-module-mocking.ts";
import { noObjectParametersRule } from "./rules/no-object-parameters.ts";
import { noReduceAccumulatorCopyRule } from "./rules/no-reduce-accumulator-copy.ts";
import { noReflectApplyRule } from "./rules/no-reflect-apply.ts";
import { noReflectGetRule } from "./rules/no-reflect-get.ts";
import { noReprovideAmbientServiceRule } from "./rules/no-reprovide-ambient-service.ts";
import { noForbiddenTermInSymbolNamesRule } from "./rules/no-shape-in-symbol-names.ts";
import { noUnknownParametersRule } from "./rules/no-unknown-parameters.ts";
import { noUnknownReturnsRule } from "./rules/no-unknown-returns.ts";
import { noUnknownTypeAliasesRule } from "./rules/no-unknown-type-aliases.ts";
import { noWidenThenAssertRule } from "./rules/no-widen-then-assert.ts";

/** Generic Oxlint rules that reject low-evidence and low-signal implementation patterns. */
const antiSlopPlugin = eslintCompatPlugin({
	meta: { name: "anti-slop" },
	rules: {
		"max-ternary-depth": maxTernaryDepthRule,
		"no-chained-type-assertions": noChainedTypeAssertionsRule,
		"no-conditional-spread": noConditionalSpreadRule,
		"no-known-value-widening": noKnownValueWideningRule,
		"no-module-mocking": noModuleMockingRule,
		"no-object-parameters": noObjectParametersRule,
		"no-reduce-accumulator-copy": noReduceAccumulatorCopyRule,
		"no-reflect-apply": noReflectApplyRule,
		"no-reflect-get": noReflectGetRule,
		"no-reprovide-ambient-service": noReprovideAmbientServiceRule,
		"no-shape-in-symbol-names": noForbiddenTermInSymbolNamesRule,
		"no-unknown-parameters": noUnknownParametersRule,
		"no-unknown-returns": noUnknownReturnsRule,
		"no-unknown-type-aliases": noUnknownTypeAliasesRule,
		"no-widen-then-assert": noWidenThenAssertRule,
	},
});

export default antiSlopPlugin;
