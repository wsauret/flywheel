# Contributing to Flywheel

Thank you for your interest in Flywheel. This guide tells you how to set up the repository, check a change, and open a pull request.

Everyone who takes part in this project must follow the [Code of Conduct](CODE_OF_CONDUCT.md).

Flywheel has one maintainer, who reviews issues and pull requests as time allows. Before you start a larger change, discuss it in [GitHub Discussions](https://github.com/wsauret/flywheel/discussions) or in an issue (see "Before you start").

## The rules that most often block a pull request

`AGENTS.md` holds the complete rules. It is written for coding agents and is long, so use it as a reference. These rules cause most review rejections:

- **One source of truth per value.** Read a value from the code that owns it. Do not copy state into a second store or add a status field that shadows it.
- **Handle only reachable states.** Add code only for a state that a person or an external producer (a provider, a subprocess, the file system) can cause. Do not add guards for states that only a test or a direct internal call can create.
- **Durable user state outlives the binary.** A change to an on-disk format, a config key, a model or provider id, or a credential shape ships with a conversion from the previous shape, a dated removal comment, and a test that feeds the previous shape.
- **Bun process launches state `windowsHide: true`.** macOS, Linux, and Windows are all first-class platforms. Do not weaken a platform test to make it pass.
- **No other coding-agent harness names.** Repository code, comments, and documents do not name other coding-agent products. `AGENTS.md` section 1 lists the few exceptions.
- **Commit headers follow the contract.** Refer to "Write commit messages to the contract" below.
- **Settled provider-terms practices stay settled.** `docs/provider-terms.md` lists the practices that the maintainer settled. A review does not reopen them.

The architecture is a set of living statements under `docs/architecture-intent/`. User-observable behavior is a set of living statements under `docs/product-intent/`. Read the statements for the area that you change. A change that alters one of these statements must update the statement in the same pull request.

`CLAUDE.md` only imports `AGENTS.md`, so agents that read `CLAUDE.md` get the same rules.

## Set up the repository

1. Install [Bun](https://bun.sh) 1.4.4. The `packageManager` field of `package.json` names this version, and CI uses the same version. You do not need Node.js: `bun run lint` runs its tools under Bun.
2. Clone the repository.
3. Install the dependencies:

```bash
bun install --frozen-lockfile
```

4. Run Flywheel from source:

```bash
bun run dev
```

You do not need Rust for ordinary development. The repository commits the native assets that Flywheel uses at run time.

## Find your way around

- The section "Where New Code Lives" in [docs/architecture.md](docs/architecture.md#where-new-code-lives) tells you where each kind of code goes.
- [docs/terminology.md](docs/terminology.md) defines the terms that Flywheel uses.
- [docs/product-intent/README.md](docs/product-intent/README.md) indexes the statements of user-observable behavior.
- [docs/architecture-intent/README.md](docs/architecture-intent/README.md) indexes the statements of the internal organization.
- [bench/README.md](bench/README.md) describes the benchmark tooling under `bench/`. It needs paid model access, and an ordinary contribution does not need it.
- The [good first issue](https://github.com/wsauret/flywheel/issues?q=is%3Aopen+label%3A%22good+first+issue%22) filter lists open issues that are a good start.

The repository has four workspaces next to the terminal application in `src/`:

- `webview/`: the web client for desktop browsers, the phone, and the VS Code panel ([webview/README.md](webview/README.md)). Check it with `bun run lint:webview`. Its tests run in `bun run test`.
- `vscode/`: the VS Code extension. Check it with `bun run lint:vscode`. Its tests run in `bun run test`.
- `relay/`: the relay Worker and the hosted phone page ([relay/README.md](relay/README.md)). Check it with `bun run lint:relay` and `bun run --cwd relay test`.
- `website/`: the flywl.sh site ([website/README.md](website/README.md)). Check it with `bun run --cwd website test`, which builds the site and tests the output.

`bun run lint` includes the three `lint:` checks above.

## Check a change

Use the `bun run` scripts. Do not call the underlying tools directly.

```bash
bun run test               # the fast unit suite
bun run lint               # types, oxlint, and the project gates
bun run check:boundaries   # the source-layer dependency rules
```

All three must pass before you open a pull request. Read the complete output: the scripts already show only the failures. The one exception is a source-only change to a native crate that you cannot rebuild, which "Change the source of a crate" in [crates/README.md](crates/README.md#change-the-source-of-a-crate) describes.

- To run one test file, give its path: `bun run test tests/unit/scripts/commit-contract.test.ts`. The script adds the Bun options that the suite needs, which a bare `bun test` does not.
- `bun run test`, `bun run lint`, `bun run test:perf`, and the integration suites share one validation lane per user on a machine. If another of these commands runs, your command waits and tells you which command holds the lane.
- The unit suite has a duration budget and a 90-second hang guard that fit a fast development machine. On a slower machine, `bun run test` can fail on the budget or the guard while every test passes. Set `TEST_BUDGET=advisory` to report the budget without failing, and set `TEST_HANG_GUARD_SECONDS` to a larger value, such as `900`. CI sets both. A failure on the budget alone does not block a pull request.
- `bun run lint` starts all of its steps at the same time. If your machine runs out of memory during lint, set `LINT_CONCURRENCY` to a positive integer, and lint runs at most that many steps at a time. CI uses `LINT_CONCURRENCY=1 bun run lint`. In PowerShell, run `$env:LINT_CONCURRENCY = "1"` first.
- Run `bun run lint:module-containment` after you change a module, a registry, or a protocol domain.
- Run `bun run test:perf` after a change that can affect startup. A startup regression above 20% fails.
- Run `bun run test:integration:no-api` only when unit tests and a focused script cannot prove the change. It needs no credentials.

Unit tests must not make network calls, spawn real processes, or write into the project directory. `AGENTS.md` section 5 gives the full rules for tests and validation.

A change to the source of a native crate under `crates/` follows the policy in [crates/README.md](crates/README.md#change-the-source-of-a-crate). If you do not have the toolchain of the crate, you can open the pull request with the source change only, even though the unit suite fails on the native assets of that crate. The maintainer then rebuilds every committed binary from its source and commits the rebuilt binaries and manifests to the pull request, and merges only after CI passes. The maintainer never merges a binary that a contributor built without that rebuild and comparison.

## Verify a user-visible change

A change that a user can see in the terminal UI needs a live check of the installed binary. The `flywheel-uat` skill (`src/orchestration/modules/development/definitions/skills/flywheel-uat/SKILL.md`) gives the method, and `bun run uat:tui --help` shows the driver. You need these:

- tmux. On Windows, install psmux, which provides `tmux`.
- A model provider in a Flywheel auth profile. The driver uses that profile in an isolated home. A provider subscription or an API key works. For a check that costs nothing, declare a local server that speaks the OpenAI chat-completions API, such as llama.cpp, Ollama, or LM Studio, as a [custom provider](src/workflows/docs/custom-providers.md). The isolated home does not copy your `flywheel.toml`, so give the driver a file that holds the `[custom_providers]` table with `--config <file>`.
- An installed build of your checkout.

`bun run install:local` builds your checkout and installs it as the Flywheel of your account. It replaces the `flywheel` command in your launcher directory, makes your build the active build under `~/.flywheel`, and registers and starts your account service on that build. The launcher directory is `FLYWHEEL_INSTALL_DIR` when you set it. Otherwise it is `~/.local/bin` on macOS and Linux, and `%LOCALAPPDATA%\Flywheel\bin` on Windows, or `~\.flywheel\bin` when `LOCALAPPDATA` is not set.

To keep your own Flywheel, install into a separate home instead. On macOS and Linux:

```bash
export UAT_HOME="$HOME/flywheel-uat-home"
BUN_INSTALL_CACHE_DIR="$HOME/.bun/install/cache" HOME="$UAT_HOME" FLYWHEEL_INSTALL_DIR="$UAT_HOME/bin" FLYWHEEL_NO_MODIFY_PATH=1 bun run install:local
FLYWHEEL_INSTALLED_BINARY="$UAT_HOME/bin/flywheel" bun run uat:tui start --scratch-root <scratch-directory> --installation-home "$UAT_HOME"
```

The installer does not register an account service for a home that you do not log in to, and `FLYWHEEL_NO_MODIFY_PATH` keeps it out of your shell profile. If you already replaced your own Flywheel, run the install command in [README.md](README.md#install) again to go back to the latest release.

If you cannot run this check, say so in the pull request. The maintainer then runs it before merging.

## Write commit messages to the contract

The release notes on the [Releases page](https://github.com/wsauret/flywheel/releases) come from the commit history, so each commit header must parse. Pull requests are squash-merged, and the pull request title becomes the commit header, so write the title to this contract. Use this form:

```text
<type>(<scope>)?: <subject>
```

- The type is one of `feat`, `fix`, `perf`, `docs`, `refactor`, `test`, `chore`, or `release`.
- Use `feat`, `fix`, and `perf` only for changes that a user can see. Write the subject so that it can stand alone as a release note.
- The scope is optional and lowercase.
- Write the subject in the imperative mood, in lowercase, with no period at the end.
- Add a `Changelog:` trailer when the user-facing sentence is different from the subject.
- For a breaking change, put `!` after the type and add a `BREAKING CHANGE:` paragraph that says what breaks and what the user must do.

Check a draft message before you commit:

```bash
printf "%s\n" "fix(tui): keep the prompt focused after a paste" | bun run scripts/commit-contract.ts check-message
```

## Before you start

A small fix can go straight to a pull request: a bug fix, a test, a documentation correction, or a focused improvement to existing behavior.

Open an issue or a discussion first and wait until the maintainer agrees to the approach for any of these:

- A new feature or a new command.
- A new dependency.
- A change to a statement in `docs/product-intent/` or `docs/architecture-intent/`.
- A refactor that moves or renames modules.

Flywheel has strict design rules, so agreeing on the shape first keeps you from doing work that the review cannot accept.

The review does not accept these changes:

- A change that reopens a practice that `docs/provider-terms.md` lists as settled.
- Code or documents that name another coding-agent harness outside the exceptions in `AGENTS.md`.
- A change that removes support for macOS, Linux, or Windows, or that weakens a platform test to make it pass.
- A second serving process or a per-project server. Clients attach through the one `flywheel serve` account service.
- A committed native binary that the maintainer did not rebuild from its source.

## Open a pull request

Open your pull request against `main` of this repository. This repository is the source of truth for Flywheel, and the maintainer works in it too.

1. Fork the repository and create a branch for your change.
2. Keep the pull request to one concern. Include the tests for each behavior change.
3. Make sure that `bun run test`, `bun run lint`, and `bun run check:boundaries` pass. A source-only native change that you cannot rebuild is the one exception (refer to "Check a change").
4. Fill in the pull request template. Tell the reviewer how you checked the change.
5. For a change that a user can see in the terminal UI, describe what you observed in the running application, as "Verify a user-visible change" tells.

The maintainer reviews the pull request. When the review approves it and the CI checks pass, the maintainer squash-merges it into `main`. The pull request title becomes the commit header, so the maintainer may edit the title to match the commit contract before merging.

### Pull requests written with AI help

Pull requests written with an AI agent are welcome. You are still the author: you must have spent more time writing and reading the pull request than the maintainer will spend reviewing it. Read every line before you open it, and be ready to explain any of it.

## License of contributions

Flywheel is licensed under the Apache License 2.0. As section 5 of [LICENSE](LICENSE) states, a contribution that you submit is licensed under the same terms, unless you explicitly state otherwise. You do not sign a contributor license agreement, and you do not add a sign-off line to your commits.

## Report a bug or ask for a feature

Ask questions in the [Q&A discussions](https://github.com/wsauret/flywheel/discussions/categories/q-a), not in an issue. For bugs and feature requests, use the issue templates on GitHub. A bug report needs the output of `flywheel --version`, your platform, and the steps that cause the problem.

Do not report a security problem in a public issue. Follow `SECURITY.md`.

## Write documents and comments

Write prose in [ASD-STE100 Simplified Technical English](https://www.asd-ste100.org/): short sentences, one instruction per sentence, the active voice, and one meaning for each word. Do not use em-dashes or emojis. Do not wrap lines by hand in Markdown files. `AGENTS.md` section 6 gives the full rules.

| Before | After |
|---|---|
| The configuration should be validated prior to the service being restarted. | Validate the configuration. Then restart the service. |
| It is worth noting that this may fail if the lock happens to be held. | This fails when another process holds the lock. |
