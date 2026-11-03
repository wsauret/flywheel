import { defineConfig, type DummyRuleMap } from "oxlint";
import core from "ultracite/oxlint/core";

const solidRecommendedRules = {
  "solid/jsx-no-duplicate-props": "error",
  "solid/jsx-no-undef": "error",
  "solid/jsx-uses-vars": "error",
  "solid/no-unknown-namespaces": "error",
  "solid/no-innerhtml": "error",
  "solid/jsx-no-script-url": "error",
  "solid/no-destructure": "error",
  "solid/prefer-for": "error",
  "solid/components-return-once": "warn",
  "solid/reactivity": "warn",
  "solid/event-handlers": "warn",
  "solid/imports": "warn",
  "solid/no-react-deps": "warn",
  "solid/no-react-specific-props": "warn",
  "solid/self-closing-comp": "warn",
  "solid/style-prop": "off",
} as const;

const flywheelSourceRules = {
  "flywheel/no-barrel-file": "error",
  "flywheel/no-record": "error",
  "flywheel/no-shouty-constants": "error",
  "flywheel/require-suppression-reason": "error",
} as const;

// Vendored from dmmulroy/anti-slop (scripts/oxlint-plugin-anti-slop). Rules
// that reject low-evidence TypeScript patterns; enabled set is clean today.
const antiSlopRules = {
  "anti-slop/no-chained-type-assertions": "error",
  "anti-slop/no-known-value-widening": "error",
  "anti-slop/no-module-mocking": "error",
  "anti-slop/no-object-parameters": "error",
  "anti-slop/no-reflect-apply": "error",
  "anti-slop/no-reflect-get": "error",
  "anti-slop/no-shape-in-symbol-names": "error",
  "anti-slop/no-unknown-returns": "error",
  "anti-slop/no-unknown-type-aliases": "error",
  "anti-slop/no-widen-then-assert": "error",
} as const;

const antiSlopDisabledRules = Object.fromEntries(
  Object.keys(antiSlopRules).map((rule) => [rule, "off"] as const),
) satisfies DummyRuleMap;

const flywheelEffectRules = {
  "flywheel/no-effect-escape-hatch": "error",
  "flywheel/no-schema-class": "error",
  "flywheel/no-unsupported-effect-api": "error",
  "flywheel/prefer-schema-inferred-types": "error",
} as const;

const permanentlyDisabledRules = {
  // Owned by a stronger Flywheel-specific gate.
  "oxc/no-barrel-file": "off", // flywheel/no-barrel-file owns both export-star forms with focused tests.
  "typescript/no-non-null-assertion": "off", // lint:safety owns the SAFETY-comment policy.

  // Broad rules that conflict with Flywheel's architecture or domain language.
  "default-case": "off", // Exhaustive switches should fail structurally, not via default branches.
  "no-await-in-loop": "off", // Queue/provider code intentionally sequences async work.
  "no-bitwise": "off", // Terminal/protocol code legitimately uses byte and bit operations.
  "no-eq-null": "off", // `eqeqeq: smart` permits the deliberate `x == null` nullish check.
  "typescript/no-namespace": "off", // Process-global singleton APIs use namespace exports intentionally.
  "promise/avoid-new": "off", // Promise constructors are legitimate at callback/Effect bridge edges.
  "promise/param-names": "off", // Parameter names are convention, not a semantic Flywheel invariant.
  "promise/prefer-await-to-callbacks": "off", // Callback APIs exist at external bridge edges.
  "promise/prefer-await-to-then": "off", // `.then` is sometimes the cleanest bridge form.
  "promise/prefer-catch": "off", // Catch placement is part of bridge/error-channel design.
  "unicorn/no-thenable": "off", // `then` is a Flywheel workflow schema term, not a thenable bug.
  "unicorn/throw-new-error": "off", // Effect's `Schema.TaggedError<E>()(...)` class factory ends in Error, and `Error()` equals `new Error()`.

  // JSDoc is not Flywheel's source of truth for API contracts.
  "jsdoc/check-tag-names": "off",
  "jsdoc/empty-tags": "off",
} as const;

const temporarilyDisabledRules = {
  // Style/declaration-shape backlog. These may ultimately become permanent
  // policy-offs, but they should first be audited instead of blessed upfront.
  "arrow-body-style": "off",
  "func-name-matching": "off",
  "func-names": "off",
  "func-style": "off",
  "no-inline-comments": "off",
  "no-negated-condition": "off",
  "no-nested-ternary": "off",
  "no-plusplus": "off",
  "no-useless-return": "off",
  "prefer-destructuring": "off",
  "prefer-template": "off",
  "sort-keys": "off",
  "sort-vars": "off",
  "import/consistent-type-specifier-style": "off",
  "import/first": "off",
  "import/newline-after-import": "off",
  "typescript/array-type": "off",
  "typescript/consistent-type-definitions": "off",
  "typescript/consistent-type-imports": "off",
  "typescript/method-signature-style": "off",
  "typescript/parameter-properties": "off",
  "unicorn/catch-error-name": "off",
  "unicorn/consistent-existence-index-check": "off",
  "unicorn/consistent-function-scoping": "off",
  "unicorn/escape-case": "off",
  "unicorn/import-style": "off",
  "unicorn/no-array-reduce": "off",
  "unicorn/no-negated-condition": "off",
  "unicorn/no-nested-ternary": "off",
  "unicorn/numeric-separators-style": "off",
  "unicorn/prefer-at": "off",
  "unicorn/prefer-code-point": "off",
  "unicorn/prefer-spread": "off",
  "unicorn/switch-case-braces": "off",
  "unicorn/text-encoding-identifier-case": "off",

  // Backlog: enable after fixing/suppressing current findings. These have some
  // code-quality value, but current violations would block adoption without a
  // focused cleanup slice.
  "curly": "off",
  "no-labels": "off",
  "no-regex-spaces": "off",
  "no-use-before-define": "off",
  "prefer-named-capture-group": "off",
  "require-unicode-regexp": "off",
  "class-methods-use-this": "off",
  "import/no-named-as-default-member": "off",
  "max-classes-per-file": "off",
  "no-empty-function": "off",
  "require-await": "off",
  "typescript/no-inferrable-types": "off",
  "typescript/no-invalid-void-type": "off",
  "typescript/prefer-for-of": "off",
  "unicorn/custom-error-definition": "off",
  "unicorn/no-array-method-this-argument": "off",
  "unicorn/no-array-sort": "off",
  "unicorn/no-await-expression-member": "off",
  "unicorn/no-hex-escape": "off",
  "unicorn/no-immediate-mutation": "off",
  "unicorn/no-object-as-default-parameter": "off",
  "unicorn/no-useless-undefined": "off",
  "unicorn/no-zero-fractions": "off",
  "unicorn/prefer-array-find": "off",
  "unicorn/prefer-import-meta-properties": "off",
  "unicorn/prefer-math-min-max": "off",
  "unicorn/prefer-string-replace-all": "off",
  "unicorn/prefer-ternary": "off",
} as const;

// Reactivated one rule per commit. Each catches real issues (not pure style),
// is fixed by manual edits, and lands as its own revertible commit.
const reactivatedCorrectnessRules = {
  "unicorn/prefer-string-slice": "error", // `String#slice` over the legacy `substring`/`substr` footguns.
  "typescript/no-dynamic-delete": "error", // `delete obj[expr]` deoptimizes object shape; use Reflect.deleteProperty.
  "no-inner-declarations": "error", // Function declarations in nested blocks (try/namespace) hoist surprisingly.
  "no-shadow": "error", // Shadowing an outer binding hides it and breeds subtle bugs.
  // Sole owner of unused-variable detection: tsconfig sets neither noUnusedLocals
  // nor noUnusedParameters and there is no Biome. The `^_` patterns preserve the
  // codebase's underscore-prefix convention (oxlint's default, which is reset the
  // moment any options object is supplied). ignoreRestSiblings: extracting a named
  // field alongside `...rest` to omit it from the rest object is intentional, not dead.
  "no-unused-vars": [
    "error",
    {
      argsIgnorePattern: "^_",
      varsIgnorePattern: "^_",
      caughtErrorsIgnorePattern: "^_",
      ignoreRestSiblings: true,
    },
  ],
} satisfies DummyRuleMap;

export default defineConfig({
  extends: [core],
  jsPlugins: [
    "eslint-plugin-solid",
    { name: "flywheel", specifier: "./scripts/oxlint-plugin-flywheel.js" },
    { name: "anti-slop", specifier: "./scripts/oxlint-plugin-anti-slop/index.ts" },
  ],
  rules: {
    ...flywheelSourceRules,
    ...antiSlopRules,
    ...permanentlyDisabledRules,
    ...temporarilyDisabledRules,
    ...reactivatedCorrectnessRules,
    // Initial cyclomatic ceiling keeps the stream adapters guarded while the
    // lone agent-loop state-machine exception is isolated below. The cleanup
    // target is to lower this global max to 30.
    complexity: ["error", { max: 60 }],
    eqeqeq: ["error", "smart"],
    // Index signatures are the sanctioned replacement under flywheel/no-record;
    // the core default prefers Record and would fight the ban.
    "typescript/consistent-indexed-object-style": ["error", "index-signature"],
    // "never" bans `as Type` and angle-bracket assertions; `as const` stays legal.
    // Casts that survive the burn-down carry a one-line `-- boundary:` suppression.
    "typescript/consistent-type-assertions": ["error", { assertionStyle: "never" }],
    "no-console": "warn",
  },
  overrides: [
    ...(core.overrides ?? []),
    {
      files: [
        "src/tui/**/*.{ts,tsx}",
        "src/orchestration/**/*.ts",
        "tests/fixtures/oxlint-solid-*.tsx",
      ],
      rules: solidRecommendedRules,
    },
    {
      files: ["src/infra/**/*.ts", "src/workflows/**/*.ts", "src/orchestration/**/*.ts"],
      rules: flywheelEffectRules,
    },
    {
      files: ["tests/**/*.{ts,tsx}", "vscode/src/**/*.test.{ts,tsx}"],
      rules: {
        "class-methods-use-this": "off",
        "max-classes-per-file": "off",
        "node/global-require": "off",
        "no-empty": "off",
        "no-extend-native": "off",
        "no-empty-function": "off",
        "no-promise-executor-return": "off",
        "require-yield": "off",
        "unicorn/custom-error-definition": "off",
        "unicorn/no-immediate-mutation": "off",
        "unicorn/prefer-module": "off",
        "unicorn/prefer-response-static-json": "off",
        "unicorn/prefer-structured-clone": "off",
        "flywheel/no-tmp-literal-path": "error",
        // Bun registers a test file's cases when the module first evaluates.
        // An import of another test file runs that file's cases a second time
        // or takes them away from it, depending on which files share the
        // `bun test` process, so the suite total changes with the shard count.
        "no-restricted-imports": ["error", {
          patterns: [{
            regex: "\\.test(\\.[cm]?[jt]sx?)?$",
            message: "Import a helper module, not a test file. A test file registers its cases in the process that loads it first.",
          }],
        }],
      },
    },
    {
      files: [
        "src/infra/code-mode/**/*.ts",
        "tests/unit/infra/code-mode/{callbacks,codemode,enumeration,parity,promise,signature,stdlib,tool-paths}.test.ts",
        "tests/unit/infra/code-mode/*-test262.test.ts",
      ],
      // Preserve the donor snapshot. These demonstrated style and structure rules would otherwise reshape vendored code.
      rules: {
        complexity: "off",
        eqeqeq: "off",
        "flywheel/no-barrel-file": "off",
        ...antiSlopDisabledRules,
        "flywheel/no-record": "off",
        "import/no-duplicates": "off",
        "import/no-self-import": "off",
        "no-console": "off",
        "no-duplicate-imports": "off",
        "no-empty": "off",
        "no-shadow": "off",
        "no-template-curly-in-string": "off",
        "prefer-exponentiation-operator": "off",
        radix: "off",
        "typescript/ban-types": "off",
        "typescript/consistent-generic-constructors": "off",
        "typescript/consistent-indexed-object-style": "off",
        "typescript/consistent-type-assertions": "off",
        "typescript/no-empty-object-type": "off",
        "typescript/no-extraneous-class": "off",
        "typescript/no-import-type-side-effects": "off",
        "typescript/no-this-alias": "off",
        "unicorn/new-for-builtins": "off",
        "unicorn/no-array-for-each": "off",
        "unicorn/no-array-reverse": "off",
        "unicorn/no-new-array": "off",
        "unicorn/no-this-assignment": "off",
        "unicorn/no-useless-collection-argument": "off",
        "unicorn/no-useless-fallback-in-spread": "off",
        "unicorn/prefer-math-trunc": "off",
        "unicorn/prefer-native-coercion-functions": "off",
        "unicorn/prefer-number-properties": "off",
        "unicorn/prefer-string-slice": "off",
      },
    },
    {
      // A command-line verb writes to the terminal, in the composition root
      // and in a module's `cli/` home alike (ARCH-STRUCTURE-022).
      files: ["src/cli/**/*.{ts,tsx}", "src/orchestration/modules/*/cli/**/*.{ts,tsx}", "scripts/**/*.{ts,tsx}", "bench/**/*.{ts,tsx}", "tests/unit/cli/**/*.{ts,tsx}", "tests/unit/orchestration/modules/*/cli/**/*.{ts,tsx}", "tests/release/**/*.{ts,tsx}", "vscode/scripts/**/*.{ts,tsx}", "webview/preview/**/*.{ts,tsx}"],
      rules: {
        "no-console": "off",
      },
    },
    {
      files: ["vscode/**/*.{ts,tsx}", "webview/editor/**/*.{ts,tsx}"],
      rules: {
        // VS Code's Webview.postMessage and acquireVsCodeApi().postMessage take
        // no targetOrigin parameter; the rule guards window.postMessage only.
        // The editor shell under webview/editor/ is the acquireVsCodeApi side.
        "unicorn/require-post-message-target-origin": "off",
      },
    },
    {
      files: ["src/orchestration/agent-runtime/agent-loop.ts"],
      rules: {
        // Turn-boundary state machine: queued-input steering, compaction,
        // budget-exhaust finals, stream outcomes, tool batch finalize, todo
        // nudges, and handoff bookkeeping. Lower this with the agent-loop
        // extraction work rather than broadening the global threshold.
        complexity: ["error", { max: 85 }],
      },
    },
  ],
});
