// Vendored from https://github.com/K-Mistele/anti-slop (src/martinfowler), MIT License,
// Copyright (c) 2026 Dillon Mulroy. THIRD-PARTY-NOTICES.md carries the license text.
import { eslintCompatPlugin } from "@oxlint/plugins";

import { mysteriousNameRule } from "./rules/mysterious-name.ts";

/** Oxlint rules named after the code smells in Martin Fowler's *Refactoring* (2nd ed., chapter 3). */
const antiSlopMartinFowlerPlugin = eslintCompatPlugin({
	meta: { name: "anti-slop-martinfowler" },
	rules: {
		"mysterious-name": mysteriousNameRule,
	},
});

export default antiSlopMartinFowlerPlugin;
