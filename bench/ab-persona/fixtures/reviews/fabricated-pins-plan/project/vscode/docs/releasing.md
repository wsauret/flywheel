# Releasing

## Sending it to one person, today

Build the package for their machine and hand them the file:

```bash
cd vscode
bun run package darwin-arm64
code --install-extension flywheel-darwin-arm64-0.0.1.vsix
```

| Their machine | Target |
| --- | --- |
| Mac, Apple Silicon | `darwin-arm64` |
| Mac, Intel | `darwin-x64` |
| Linux, glibc (Debian, Ubuntu, Fedora…) | `linux-x64` / `linux-arm64` |
| Alpine or another musl distribution | `alpine-x64` / `alpine-arm64` |
| Windows | `win32-x64` / `win32-arm64` |

For a **remote** machine (SSH, WSL, a dev container) install the package for
the *remote's* platform, not the laptop's:

```bash
code --remote ssh-remote+myhost --install-extension flywheel-linux-x64-0.0.1.vsix
```

This needs no publisher account and no marketplace. It is the right way to get
it in front of a handful of people.

`bun run package all` builds all eight. Each target is staged alone, so a
package carries exactly the runtime built for it and nothing else.

## Publishing to the Marketplace

Two one-time steps, then it is a command.

1. **Use the permanent publisher.** The extension identity is `flywheel-core-team.flywheel`. Publication requires Owner or Contributor access to `flywheel-core-team`; changing `publisher` or `name` creates a different Marketplace extension.

2. **Create a short-lived Personal Access Token.** In Azure DevOps (<https://dev.azure.com>), open User settings → Personal access tokens. Set organization to **All accessible organizations** and scope to **Marketplace → Manage**. Then run `bunx @vscode/vsce login flywheel-core-team`. Revoke the token after the release is verified.

Set the next version in `package.json` and commit the source that will ship. Then generate and review the extension-only release notes before packaging. The command compares against the previous `vscode-v<version>` tag, includes shared runtime changes newly shipped by the extension, and excludes terminal-only interface work:

```bash
cd vscode
bun run notes:draft
bun run package all
bun run publish:marketplace --dry-run
bun run publish:marketplace
```

The notes command writes `dist/release-notes.md` and a sidecar that binds those exact bytes to the extension version, source commit, and previous extension tag. The publication script requires that binding and all eight platform packages, then passes the notes to `vsce` as the Marketplace changelog. A real publication requires a clean committed tree. It stages `vscode-v<version>` locally before the Marketplace upload, removes that tag if the upload fails, and pushes it only after the Marketplace accepts the release. Binary tags remain `v<version>` and never act as extension release boundaries.

If Marketplace publication succeeds but the final tag push fails, do not publish the extension again. Stay on the same source commit and run:

```bash
bun run publish:marketplace --recover-tag
```

Recovery verifies that the local tag names `HEAD` and that the Marketplace already serves the package version before it pushes the tag.

## In CI

There is deliberately no workflow file in this directory. GitHub reads workflows
only from `.github/workflows/` at the repository root, so wiring this into CI is
a change to the repository's own workflows and belongs to whoever owns them.

What such a job needs is small, because the runtime source is in this
repository rather than somewhere it has to be fetched from:

- Bun.
- `bun install --frozen-lockfile` at the root; the workspace covers `vscode/`.
- The root gates (`bun run lint`, `bun run test`, `bun run check:boundaries`),
  then `bun run package <target>` in `vscode/` per target in a matrix.
- `VSCE_PAT` as a secret, and only on a tag.

## What a reader of the listing gets

The Marketplace page renders `README.md` and `package.json`'s `description`, `categories`, `keywords`, icon, and gallery banner. The homepage points back to the Marketplace listing. Privacy and support are public sections of the listing README, and the manifest sends issue reports to the public Flywheel issue tracker.

## Before the first publish

- `version` is `0.0.1`. The Marketplace will not accept the same version twice,
  so it has to move before every publish.
- `package.json` deliberately has no `repository` field while the source repository is private. The package script passes `--allow-missing-repository`, so `vsce` does not prompt and the release stays noninteractive. The Marketplace listing, privacy disclosure, and support destination remain public.
