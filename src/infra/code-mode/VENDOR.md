# Vendored Code Mode Interpreter

Source: https://github.com/anomalyco/opencode, path `packages/codemode/src/`

License: MIT License, Copyright (c) 2025 opencode. `THIRD-PARTY-NOTICES.md` reproduces the license text.

Upstream commit: `4194d55522516f0abec3f0fc09ed3880e0351232`, the last commit that touched `packages/codemode` on or before the sync date. It changed only tests, so its `packages/codemode/src/` is the same as at `0df96ddeb0e5845a78a6eedd8ef6a02c0f18b77c`.

Sync date: 2026-08-08

The directory preserves the donor structure so that later synchronization can use a direct tree comparison. OpenAPI code is not included.

## Local deviations

- Local TypeScript imports keep the donor `.js` extensions.
- The `openapi` directory and `OpenAPI` export are not included.
- The confined catalog builtin is named `searchCatalog` instead of `search`.
- `ExecutionLimits.maxLogBytes` independently bounds retained console output without limiting returned values or warnings. Console retention uses the smaller of `maxLogBytes` and `maxOutputBytes`, with absent limits treated as unlimited. The existing `maxOutputBytes` result and warning contracts remain unchanged.
- One private collector per suspended execution retains a contiguous whole-line prefix, counting UTF-8 bytes plus one byte per line. After the first overflow it drops every later line and reports one dropped-line marker. `ExecuteOptions.onLog` still receives every raw line in execution order, including dropped lines, and receives a stable readonly `ConsoleLogView` as its second argument. The view exposes the retained line count and a lazy snapshot, not mutable storage. Interpreter function invocations share the same append-and-observe sink.
- `parseProgram` uses Amaro in `strip-only` mode instead of `typescript.transpileModule` so that stripped TypeScript keeps source positions.
- Vendored compiler, lint, safety-comment, and file-size exemptions are listed in the owning root configuration with their reasons. Two minimal type-only adjustments preserve runtime behavior: the length-guarded `intersection` indexed access has one reasoned `@ts-expect-error`, and Date setter dispatch creates one length-guarded fixed tuple view for the four positions it already reads.
