// Vendored and adapted from https://github.com/dmmulroy/anti-slop, MIT License,
// Copyright (c) 2026 Dillon Mulroy. THIRD-PARTY-NOTICES.md carries the license text.
import { definePlugin } from "@oxlint/plugins";

import { noChainedTypeAssertionsRule } from "./rules/no-chained-type-assertions.ts";
import { noKnownValueWideningRule } from "./rules/no-known-value-widening.ts";
import { noModuleMockingRule } from "./rules/no-module-mocking.ts";
import { noObjectParametersRule } from "./rules/no-object-parameters.ts";
import { noReflectApplyRule } from "./rules/no-reflect-apply.ts";
import { noReflectGetRule } from "./rules/no-reflect-get.ts";
import { noForbiddenTermInSymbolNamesRule } from "./rules/no-shape-in-symbol-names.ts";
import { noUnknownReturnsRule } from "./rules/no-unknown-returns.ts";
import { noUnknownTypeAliasesRule } from "./rules/no-unknown-type-aliases.ts";
import { noWidenThenAssertRule } from "./rules/no-widen-then-assert.ts";

/** Generic Oxlint rules that reject low-evidence and low-signal implementation patterns. */
const antiSlopPlugin = definePlugin({
	meta: { name: "anti-slop" },
	rules: {
		"no-chained-type-assertions": noChainedTypeAssertionsRule,
		"no-known-value-widening": noKnownValueWideningRule,
		"no-module-mocking": noModuleMockingRule,
		"no-object-parameters": noObjectParametersRule,
		"no-reflect-apply": noReflectApplyRule,
		"no-reflect-get": noReflectGetRule,
		"no-shape-in-symbol-names": noForbiddenTermInSymbolNamesRule,
		"no-unknown-returns": noUnknownReturnsRule,
		"no-unknown-type-aliases": noUnknownTypeAliasesRule,
		"no-widen-then-assert": noWidenThenAssertRule,
	},
});

export default antiSlopPlugin;
