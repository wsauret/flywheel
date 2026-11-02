# Third-Party Notices

Flywheel is released under the Apache License 2.0 (see `LICENSE`). Parts of this repository are inspired by, adapted from, or include material from the following projects. Each copyright notice below is preserved as its license requires.

## Inspirations

Parts of Flywheel are inspired by these projects:
- **pi** (Mario Zechner), MIT License, Copyright (c) 2025 Mario Zechner. The ChatGPT backend transport shape, session-tree pending-write handling, and conversation recall rendering helpers were all helpful references.
- **opencode** (opencode contributors), MIT License, Copyright (c) 2025 opencode. The click-anywhere-to-expand behavior on collapsed tool output and diffs, and the provider-failure classification boundary shape were great ideas.
- **Codex CLI** (OpenAI), Apache License 2.0, Copyright 2025 OpenAI. The `apply_patch` planner in `src/infra/file-edit/` is derived from its apply-patch crate: the patch grammar and parser, the four seek tiers with first-match chunk application, the update derivation, and the end-to-end scenario fixtures under `tests/fixtures/apply-patch-scenarios/`, which are kept byte for byte. The paste-burst detection was also helpful, as were the backend wire-frame fixture shapes from its test suite.
- **Hermes** (Nous Research), MIT License, Copyright (c) 2025 Nous Research. The escape-normalized tier of the string edit planner is ported from its `fuzzy_match.py`. It also inspired the memory tool and store semantics, the skill lifecycle pruner, the self-improvement review and its prompts, tool-argument coercion and tool-name repair, tool-output budgeting, and the threat-pattern library.
- **condensed-milk** (tomooshi), MIT License, Copyright (c) 2026 tomooshi. Inspired the static-cutoff stale tool-result masking core.
- **OpenClaw** (OpenClaw Foundation), MIT License, Copyright (c) 2026 OpenClaw Foundation. Its TypeScript port of the Codex apply-patch parser and update derivation (`apply-patch.ts`, `apply-patch-update.ts`) guided the TypeScript patch planner in `src/infra/file-edit/`.
- **OMP / pi** (Mario Zechner, Can Bölük, and Stencil Labs, Inc.), MIT License, Copyright (c) 2025 Mario Zechner, Copyright (c) 2025-2026 Can Bölük, Copyright (c) 2026 Stencil Labs, Inc. Its proven display-prefix and uniform-indentation matching techniques informed the string edit planner.
- **Fast Agent**, Apache License 2.0. Its pure string replacement planning and non-overlapping replace-all behavior informed the string edit planner.

The MIT License text for the MIT-licensed projects above:

```text
Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE IN OTHER DEALINGS IN THE
SOFTWARE.
```

The Apache License 2.0 governing the Codex CLI and Fast Agent portions is available at https://www.apache.org/licenses/LICENSE-2.0.

## Adapted source files

These Flywheel files adapt source, tests, or text from the projects named. Each project's license text appears above, and the copyright lines are those given in the Inspirations section unless stated here.

- **OpenClaw** (MIT): the login-shell environment probe in `src/infra/login-shell-path.ts`; the latest-modification scan in `src/infra/source-snapshot.ts`; the service reload handoff in `src/orchestration/app-service/account-service-installation.ts`; the Windows Task Scheduler task definition in `src/orchestration/app-service/account-service-registration.ts`; the systemd linger check in `src/orchestration/app-service/account-service-systemd.ts`; the web serving token, CSP, HTTP, routing, and static-file handling in `src/orchestration/app-service/web-serving/` and `webview/local/token.ts`, with the source slices in `tests/fixtures/upstream/web/`, the drift check `scripts/check-web-upstream-drift.ts`, and its test `tests/unit/orchestration/app-service/web-upstream-drift.test.ts`; and the session-message result shape in `src/orchestration/agent-runtime/tools/message-session.ts`.
- **pi** (MIT): the serve lifetime holds in `src/orchestration/app-service/serve-lifetime.ts`; the MCP account and project configuration rules in `src/orchestration/modules/mcp/config.ts`, with the source slices and license in `tests/fixtures/upstream/mcp/` and the drift test `tests/unit/orchestration/modules/mcp/upstream-drift.test.ts`; and test cases ported into `tests/unit/infra/llm/compute-cost.test.ts`, `tests/unit/orchestration/agent-runtime/llm/google-failure-signals.test.ts`, and `tests/unit/orchestration/agent-runtime/llm/openrouter-reasoning-details.test.ts`; the model provider adapters, wire conversions, and their helpers, adapted from `packages/ai` of pi, in `src/orchestration/agent-runtime/llm/anthropic.ts`, `src/orchestration/agent-runtime/llm/anthropic-usage.ts`, `src/orchestration/agent-runtime/llm/conversions/anthropic-messages.ts`, `src/orchestration/agent-runtime/llm/conversions/google-generative-ai.ts`, `src/orchestration/agent-runtime/llm/google.ts`, `src/orchestration/agent-runtime/llm/provider-description.ts`, `src/orchestration/agent-runtime/llm/openai-completions.ts`, `src/orchestration/agent-runtime/llm/openai-completions-messages.ts`, `src/orchestration/agent-runtime/llm/openai-helpers.ts`, `src/orchestration/agent-runtime/llm/openai-adapter-helpers.ts`, `src/orchestration/agent-runtime/llm/openai-options.ts`, `src/orchestration/agent-runtime/llm/openai-prompt-cache.ts`, `src/orchestration/agent-runtime/llm/chatgpt-client.ts`, `src/orchestration/agent-runtime/llm/chatgpt-adapter-error.ts`, `src/orchestration/agent-runtime/llm/chatgpt-adapter/request.ts`, `src/orchestration/agent-runtime/llm/chatgpt-adapter/transport.ts`, `src/orchestration/agent-runtime/llm/chatgpt-adapter/sse.ts`, `src/orchestration/agent-runtime/llm/chatgpt-adapter/types.ts`, `src/orchestration/agent-runtime/llm/chatgpt-adapter/websocket.ts`, `src/orchestration/agent-runtime/llm/chatgpt-adapter/websocket-session.ts`, `src/orchestration/agent-runtime/llm/provider-availability.ts`, `src/orchestration/agent-runtime/llm/model-compat.ts`, `src/orchestration/agent-runtime/llm/json-parse.ts`, `src/orchestration/agent-runtime/llm/sanitize-unicode.ts`, `src/infra/llm/llm-helpers.ts`, and `src/infra/llm/provider-error-diagnostic.ts`; the ChatGPT login input parser in `src/orchestration/auth/openai-oauth.ts`; the GitHub Copilot base URL, client, headers, and device login in `src/orchestration/modules/provider-github-copilot/base-url.ts`, `src/orchestration/modules/provider-github-copilot/clients.ts`, `src/orchestration/modules/provider-github-copilot/headers.ts`, and `src/orchestration/modules/provider-github-copilot/oauth.ts`; and the adapter test cases in `tests/unit/orchestration/agent-runtime/llm/anthropic-adapter-config.test.ts`, `tests/unit/orchestration/agent-runtime/llm/anthropic-usage-accounting.test.ts`, `tests/unit/orchestration/agent-runtime/llm/copilot-headers.test.ts`, `tests/unit/orchestration/agent-runtime/llm/llm-converters.test.ts`, `tests/unit/orchestration/agent-runtime/llm/openai-completions-converter.test.ts`, `tests/unit/orchestration/agent-runtime/llm/openrouter-request-shape.test.ts`, and `tests/unit/orchestration/agent-runtime/llm/chatgpt-backend/sse.test.ts`.
- **opencode** (MIT): the Code Mode tool description in `src/orchestration/modules/code-mode/tool.ts` and the result text in `src/orchestration/modules/code-mode/result-format.ts`, adapted from `packages/core/src/codemode/tool.ts` of opencode.
- **pi-autoresearch** (MIT, Copyright (c) 2026 Tobi Lutke and David Cortés, https://github.com/davebcn87/pi-autoresearch): the experiment loop in `src/orchestration/modules/experiments/`, `src/orchestration/agent-runtime/tools/experiment-schemas.ts`, `src/tui/modules/experiments/dashboard-lines.ts`, and the dashboard confidence bands in `webview/src/modules/experiments/strip.tsx` and its test `webview/src/modules/experiments/strip.test.tsx`; the skills in `src/agent-skills/experiment-charter/` and `src/agent-skills/experiment-finalize/`; and their tests in `tests/unit/orchestration/modules/experiments/` and `tests/integration/orchestration/modules/experiments/`.
- **OMP / pi** (MIT): the reply wait and its cycle check in `src/orchestration/session/reply-waits.ts`; the session-message envelope text in `src/orchestration/agent-runtime/llm/provider-history.ts`; and the native search engine and glob helpers in `crates/ripgrep/src/grep.rs` and `crates/ripgrep/src/glob_util.rs`, adapted from `crates/pi-natives/src/grep.rs` and `crates/pi-natives/src/glob_util.rs` of OMP (https://github.com/can1357/oh-my-pi). Its license and copyright notice ship beside the compiled crate as `crates/ripgrep/LICENSE.omp`.
- **Codex CLI** (Apache License 2.0): the session-message envelope and the session list row in `src/orchestration/agent-runtime/llm/provider-history.ts` and `src/orchestration/agent-runtime/tools/list-sessions.ts`; the patch grammar in `src/orchestration/agent-runtime/tools/apply-patch.ts`; the session-notes token-budget messages in `src/infra/agent-assets/session-notes.ts`, adapted from `codex-rs/models-manager/models.json` and changed by Flywheel as the replacement ledger in their test records, and that test `tests/unit/orchestration/agent-runtime/session-notes-prompts.test.ts`; the seek test cases in `tests/unit/infra/file-edit/seek-sequence.test.ts`; and the ChatGPT backend error-frame fixture shapes in `src/orchestration/agent-runtime/llm/chatgpt-adapter/sse.ts`, `src/orchestration/agent-runtime/llm/provider-availability.ts`, and `tests/unit/orchestration/agent-runtime/llm/chatgpt-backend/sse.test.ts`.
- **Hermes** (MIT): the phone keyboard inset in `webview/phone/keyboard-inset.ts` and its test `webview/phone/keyboard-inset.test.ts`; the tool-name fuzzy-match cutoff in `src/orchestration/agent-runtime/tools/tool-dispatch.ts`; and the escape-normalized tier of the string edit planner in `src/infra/file-edit/string-edit.ts`.
- **anti-slop** (MIT, Copyright (c) 2026 Dillon Mulroy, https://github.com/dmmulroy/anti-slop): the Oxlint rule plugin in `scripts/oxlint-plugin-anti-slop/`, vendored and adapted from its `src/` directory.
- **fff** (MIT, Copyright (c) 2025 Dmitriy Kovalenko, https://github.com/dmtrKovalenko/fff.nvim): the definition and import line classifiers in `src/orchestration/agent-runtime/tools/search-ranking.ts`, adapted from its `grep.rs`, and the output budget grain in `src/orchestration/agent-runtime/tools/search-pipeline.ts`.

## Terminal system theme

The terminal system-theme math and solver are adapted from pi at revision `ea448f454af474f3e2fe9733b331e17b0662f5d6`, https://github.com/earendil-works/pi/tree/ea448f454af474f3e2fe9733b331e17b0662f5d6. Copyright (c) 2025 Mario Zechner, MIT License. The MIT License text appears above. The Oklab and OKHSL conversion also preserves Copyright (c) 2021 Björn Ottosson and his MIT notice in `src/tui/context/theme/oklab.ts`.

| Original source | Flywheel destination | Adaptation and replacement ledger |
|---|---|---|
| `packages/tui/src/oklab.ts` | `src/tui/context/theme/oklab.ts` | Copied first. Replaced the terminal-color type import with canonical RGB channels. Replaced array-to-tuple assertions and unchecked indexing with fixed tuples for strict TypeScript. Preserved conversion coefficients, gamut equations, and the Ottosson notice. |
| `packages/tui/src/colors.ts` | `src/tui/context/theme/oklch.ts` | Retained only hue-preserving OKLCH gamut mapping and RGB-to-OKLCH conversion. Replaced the renderer color union with RGB and OKLCH channel objects. Omitted parsing, indexed colors, mixing, ANSI emission, and style helpers. |
| `packages/coding-agent/src/modes/interactive/theme/system-theme.ts` | `src/tui/context/theme/system-theme.ts` | Copied first. Replaced the role and surface recipe with all Flywheel `TuiTheme` fields. Retained the used target-lightness curves, family coefficients, Gaussian falloff, source chroma cap, dependency ordering, appearance detection, and minimal relaxation search. Removed unused families, levels, role recipes, and saturation controls. Replaced the unreported-color ANSI tier with the existing Flywheel named fallback. Published explicit OpenTUI RGBA colors instead of default-color sentinels. Removed the upstream foreground-emphasis-selection policy: preserve a reported foreground that already meets 4.5:1 on all required surfaces. Applied the nominal 4.5:1 correction to all generated text roles. Kept the source hue and chroma cap through curve painting, WCAG correction, and secondary hierarchy correction. Bounded neutral lower-tier contrast by the corrected body, using the least readable valid neutral endpoint and bounded lightness bisection. Mapped Flywheel textSubtle to the perceptual lightness midpoint between corrected body and muted text, not upstream's lower subtle tier. Solarized RGB quantization makes the least valid neutral endpoint slightly stronger than the initially corrected body (dark 5.640476 versus 5.611172; light 5.298636 versus 5.247675 on ground). An already-unreadable foreground receives only the minimum additional correction needed to accommodate that endpoint; all shared foreground roles use the corrected body. An already-readable reported foreground remains unchanged. Used a readable ground-pole endpoint for panel bisection because a palette hue at the background's OKLab lightness can fall below the WCAG floor on mid-gray grounds. Resolved selection foreground separately as black or white. Removed the duplicate palette length check: the terminal hook supplies the canonical full 16-slot palette. |

The Flywheel adaptation shares its contrast floor and bisection primitive with named themes. A shared final readable-palette pass preserves valid generated colors and corrects text on its rendered fills. Body roles target 1.15 times semantic muted contrast on interface fills. A readable terminal-reported foreground takes priority over this preferred gap, but not the contrast floor. Shared body roles receive the same hierarchy policy. Subdued palettes use opaque lightness corrections instead of foreground alpha. The normal palette supplies subdued hue anchors to avoid repeated byte-rounding drift. The independent write syntax palette is unchanged.

Without a reported background, the fallback uses the existing Flywheel dark preset or GitHub light preset according to the appearance hint. The light preset keeps independent syntax colors on a light rendered ground.

## Vendored components

- **ripgrep** (compiled into `crates/ripgrep/*.node`), dual-licensed MIT or Unlicense; used here under the MIT License. Copyright (c) Andrew Gallant. https://github.com/BurntSushi/ripgrep
- **PCRE2 10.46** (statically compiled into `crates/ripgrep/*.node` through `pcre2-sys`), BSD-3-Clause WITH PCRE2-exception. Copyright (c) 1997-2007 University of Cambridge, Copyright (c) 2007-2024 Philip Hazel, Copyright (c) 2009-2024 Zoltan Herczeg, and other contributors. The complete PCRE2 license text is preserved below and in both `crates/ripgrep/THIRD-PARTY-LICENSES.txt` and `THIRD-PARTY-LICENSES.txt`. https://github.com/PCRE2Project/pcre2/tree/pcre2-10.46
- **Monaspace Argon** font (`assets/fonts/monaspace-argon/`, and the website copy `website/public/fonts/monaspace-argon.woff2`), SIL Open Font License 1.1; the full license ships alongside the font as `OFL.txt`, and beside the website copy as `website/public/fonts/OFL-monaspace-argon.txt`. Copyright (c) 2023 GitHub. https://github.com/githubnext/monaspace
- **Schibsted Grotesk** font (`website/public/fonts/schibsted-grotesk-*.woff2`), SIL Open Font License 1.1; the full license ships alongside the font as `website/public/fonts/OFL-schibsted-grotesk.txt`. Copyright 2023 The Schibsted-Grotesk Project Authors. https://github.com/schibsted/schibsted-grotesk
- **Wix Madefor Text** font (`website/public/fonts/wix-madefor-text-*.woff2`), SIL Open Font License 1.1; the full license ships alongside the font as `website/public/fonts/OFL-wix-madefor-text.txt`. Copyright 2021 The Wix Madefor Project Authors. https://github.com/wix/wixmadefor
- **OpenCode TUI color themes** (`src/tui/context/theme/*.json`), MIT License, Copyright (c) 2025 opencode. The license text appears above. https://github.com/anomalyco/opencode
- **OpenCode Code Mode interpreter** (`src/infra/code-mode/`), MIT License, Copyright (c) 2025 opencode contributors. Its upstream source, commit, and local deviations are recorded in `src/infra/code-mode/VENDOR.md`. Its tests are in `tests/unit/infra/code-mode/`. The Test262-derived conformance suites retain the BSD license in `tests/unit/infra/code-mode/LICENSE.test262`. https://github.com/anomalyco/opencode
- **Zig 0.15.2 compiler-rt and mingw-w64 runtime** (statically linked into `crates/windows-launcher/*.exe` and `crates/windows-git-forwarder/*.exe` by `zig cc` for the `x86_64-windows-gnu` and `aarch64-windows-gnu` targets). Zig links its own compiler-rt, MIT License, Copyright (c) Zig contributors, and the mingw-w64 startup and stdio objects that it ships in `lib/libc/mingw/`. Most of those objects are in the public domain; the others are under the Zope Public License 2.1, Copyright (c) 2009 - 2013 by the mingw-w64 project. The C runtime itself is the Windows Universal C Runtime, which the executables load from the system. Both license texts are in `THIRD-PARTY-LICENSES.txt`. https://github.com/ziglang/zig/tree/0.15.2
- **models.dev catalog** (`src/infra/llm/models-bundled.txt`, a snapshot that `scripts/refresh-models-snapshot.ts` fetches from https://models.dev), MIT License, Copyright (c) 2025 models.dev. The license text appears above, and the upstream file is kept in `third-party/reviewed/data/models.dev/LICENSE`, which `THIRD-PARTY-LICENSES.txt` reproduces. https://github.com/anomalyco/models.dev
- **Flywheel tokenizer** (`crates/tokenizer/`), with source and data adapted from OMP, ctok, OpenAI tiktoken, and xutf, plus the statically linked Rust standard library. The pinned revisions, vocabulary origins, narrow adaptations, fixture interpretation, toolchain, copyright notices, and complete license texts are preserved in `crates/tokenizer/NOTICE.md` and its referenced license files. The crate declares `license = "MIT"` in its `Cargo.toml` on purpose, because most of its source is adapted MIT code; the rest of Flywheel is licensed under Apache-2.0.

## Bundled dependencies

Every distributed artifact carries the applicable material from `THIRD-PARTY-LICENSES.txt`. The generated bundle is derived from the production dependency graph in `bun.lock` and the committed native-crate ledgers.

The `flywheel` binary embeds the **Bun 1.4.4** runtime, because `bun build --compile` builds it. Bun is MIT-licensed. Bun statically links JavaScriptCore and WebKit, which are LGPL-2, and tinycc, which is LGPL-2.1. It also statically links other libraries under permissive licenses, which Bun's license file lists. The source of JavaScriptCore and WebKit that Bun 1.4.4 uses is at https://github.com/oven-sh/WebKit/tree/d6375c72affe0f70222cdcb45012b10f0bf3a9d5. The tinycc source is at https://github.com/oven-sh/tinycc/tree/05f0fafaa3be31e31d7b4b5c17dc60f62c991171. The Bun source and its relink instructions are at https://github.com/oven-sh/bun/tree/bun-v1.4.4. Bun's license file and the LGPL-2 and LGPL-2.1 texts are in `THIRD-PARTY-LICENSES.txt`. The bundle also has one section for each other component that Bun's license file names: the statically linked libraries, the code that `bun check`, `bun lint`, and `bun fmt` port from other projects, and the embedded polyfills. These sections carry the license and notice texts that `scripts/review-bun-runtime-licenses.ts` fetched from each upstream repository at a pinned commit, or from the published package of the one component whose repository no longer exists, and that `third-party/reviewed/runtime/bun-1.4.4/components/` keeps. Where Bun names the version that it links, the pin is that version. Bun names no version for the code that it ports, so the pin of such a component is the upstream commit that the review read. For libarchive, whose license file defers to the notice in each source file, the section also carries the distinct notices of the source files that Bun compiles.

Flywheel distributes libvips 8.18.7 and its dependency set as separately replaceable shared libraries through sharp-libvips 1.3.4. The complete component license table, GNU GPL 3.0 and LGPL 3.0 terms, and exact source provenance at https://github.com/lovell/sharp-libvips/tree/v1.3.4 accompany the binaries in `THIRD-PARTY-LICENSES.txt`.

Each release archive also includes the unmodified Claude engine binary from `@anthropic-ai/claude-agent-sdk` 0.3.306, the version that `package.json` pins. `scripts/claude-engine-asset.ts` copies it from the locked platform package and checks it against the `bun.lock` integrity and the SHA-256 that the SDK manifest states. This binary is proprietary Anthropic software, and the Apache License 2.0 does not cover it. Its terms are in the SDK's `LICENSE.md`, which `THIRD-PARTY-LICENSES.txt` reproduces.

## Benchmark material

Some benchmark tasks under `bench/tasks/implement/` copy material from external datasets and projects. This material keeps its upstream licenses, and Flywheel's repository license does not relicense it. The DS-1000 data stays under its CC BY-SA license. Each task folder holds its provenance record, its copy ledger, and the full license and notice texts, so this file does not repeat them. The task folders also keep the notices of the runtimes, Python wheels, and bundled libraries that the tasks use, such as Python, Node.js, and the libraries that Redis bundles. The other tasks and fixtures under `bench/` are Flywheel's own material.

| Upstream | Source | License | Provenance and license texts |
|---|---|---|---|
| DS-1000 | https://github.com/xlang-ai/DS-1000 | CC BY-SA 4.0. The source Stack Overflow question and answer revisions are under CC BY-SA 3.0 and 4.0. | `bench/tasks/implement/ds1000-298/` |
| SWE-bench Verified dataset | https://huggingface.co/datasets/princeton-nlp/SWE-bench_Verified | MIT, as the publisher labels it. The label does not relicense the source code, issue text, or patches in it. | `bench/tasks/implement/astropy__astropy-14598/`, `bench/tasks/implement/psf__requests-6028/` |
| SWE-bench Multilingual dataset | https://huggingface.co/datasets/SWE-bench/SWE-bench_Multilingual | MIT, as its dataset card declares | `bench/tasks/implement/redis__redis-10068/` |
| SWE-bench harness | https://github.com/SWE-bench/SWE-bench | MIT | `bench/tasks/implement/astropy__astropy-14598/`, `bench/tasks/implement/psf__requests-6028/`, `bench/tasks/implement/redis__redis-10068/` |
| SWE-Gym dataset and its SWE-Bench fork | https://huggingface.co/datasets/SWE-Gym/SWE-Gym, https://github.com/SWE-Gym/SWE-Bench-Fork | Dataset: MIT, as its dataset card declares. Grader: MIT (SWE-bench), with the SWE-Gym Apache-2.0 notice kept. | `bench/tasks/implement/getmoto__moto-7365/` |
| astropy | https://github.com/astropy/astropy | BSD-3-Clause | `bench/tasks/implement/astropy__astropy-14598/` |
| moto | https://github.com/getmoto/moto | Apache-2.0 | `bench/tasks/implement/getmoto__moto-7365/` |
| Requests | https://github.com/psf/requests | Apache-2.0 | `bench/tasks/implement/psf__requests-6028/` |
| Redis | https://github.com/redis/redis | BSD-3-Clause | `bench/tasks/implement/redis__redis-10068/` |
| Deep SWE (Datacurve) | https://github.com/datacurve-ai/deep-swe | Apache-2.0, for Datacurve's own contributions only | `bench/tasks/implement/httpx-streaming-json-iteration/` |
| HTTPX | https://github.com/encode/httpx | BSD-3-Clause | `bench/tasks/implement/httpx-streaming-json-iteration/` |
| SWE-gen-JS | https://github.com/abundant-ai/SWE-gen-JS | Apache-2.0 | `bench/tasks/implement/jquense__yup-2305/` |
| yup | https://github.com/jquense/yup | MIT | `bench/tasks/implement/jquense__yup-2305/` |
| Terminal-Bench 2.1 | https://github.com/harbor-framework/terminal-bench-2-1 | Apache-2.0 | `bench/tasks/implement/regex-chess/`, `bench/tasks/implement/scheme-metacircular/` |
| Exercism Rust track and problem specifications, through the Aider polyglot benchmark | https://github.com/exercism/rust, https://github.com/exercism/problem-specifications, https://github.com/Aider-AI/polyglot-benchmark | MIT | `bench/tasks/implement/rust-react/` |
| Aider | https://github.com/Aider-AI/aider | Apache-2.0, for the original instruction addendum | `bench/tasks/implement/rust-react/` |

## PCRE2 license

Source: https://github.com/PCRE2Project/pcre2/blob/pcre2-10.46/LICENCE.md

```text
PCRE2 License
=============

| SPDX-License-Identifier: | BSD-3-Clause WITH PCRE2-exception |
|---------|-------|

PCRE2 is a library of functions to support regular expressions whose syntax
and semantics are as close as possible to those of the Perl 5 language.

Releases 10.00 and above of PCRE2 are distributed under the terms of the "BSD"
licence, as specified below, with one exemption for certain binary
redistributions. The documentation for PCRE2, supplied in the "doc" directory,
is distributed under the same terms as the software itself. The data in the
testdata directory is not copyrighted and is in the public domain.

The basic library functions are written in C and are freestanding. Also
included in the distribution is a just-in-time compiler that can be used to
optimize pattern matching. This is an optional feature that can be omitted when
the library is built.


COPYRIGHT
---------

### The basic library functions

    Written by:       Philip Hazel
    Email local part: Philip.Hazel
    Email domain:     gmail.com

    Retired from University of Cambridge Computing Service,
    Cambridge, England.

    Copyright (c) 1997-2007 University of Cambridge
    Copyright (c) 2007-2024 Philip Hazel
    All rights reserved.

### PCRE2 Just-In-Time compilation support

    Written by:       Zoltan Herczeg
    Email local part: hzmester
    Email domain:     freemail.hu

    Copyright (c) 2010-2024 Zoltan Herczeg
    All rights reserved.

### Stack-less Just-In-Time compiler

    Written by:       Zoltan Herczeg
    Email local part: hzmester
    Email domain:     freemail.hu

    Copyright (c) 2009-2024 Zoltan Herczeg
    All rights reserved.

### All other contributions

Many other contributors have participated in the authorship of PCRE2. As PCRE2
has never required a Contributor Licensing Agreement, or other copyright
assignment agreement, all contributions have copyright retained by each
original contributor or their employer.


THE "BSD" LICENCE
-----------------

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

* Redistributions of source code must retain the above copyright notices,
  this list of conditions and the following disclaimer.

* Redistributions in binary form must reproduce the above copyright
  notices, this list of conditions and the following disclaimer in the
  documentation and/or other materials provided with the distribution.

* Neither the name of the University of Cambridge nor the names of any
  contributors may be used to endorse or promote products derived from this
  software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE
ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT OWNER OR CONTRIBUTORS BE
LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR
CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF
SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS
INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN
CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE)
ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE
POSSIBILITY OF SUCH DAMAGE.


EXEMPTION FOR BINARY LIBRARY-LIKE PACKAGES
------------------------------------------

The second condition in the BSD licence (covering binary redistributions) does
not apply all the way down a chain of software. If binary package A includes
PCRE2, it must respect the condition, but if package B is software that
includes package A, the condition is not imposed on package B unless it uses
PCRE2 independently.

End
```
