# Releasing

## Sending it to one person, today

Build the one package and hand them the file:

```bash
cd vscode
bun run package
code --install-extension flywheel-<version>.vsix
```

The package carries no runtime, so the same file serves every machine. On a machine with no Flywheel the extension installs the current public release through the platform's bootstrap installer the first time it starts. For a **remote** machine (SSH, WSL, a dev container) install it on the remote:

```bash
code --remote ssh-remote+myhost --install-extension flywheel-<version>.vsix
```

This needs no publisher account and no marketplace. It is the right way to get it in front of a handful of people.

## Publishing to the Marketplace

Two one-time steps, then it is a command.

1. **Use the permanent publisher.** The extension identity is `flywheel-core-team.flywheel`. Publication requires Owner or Contributor access to `flywheel-core-team`; changing `publisher` or `name` creates a different Marketplace extension.

2. **Create a short-lived Personal Access Token.** In Azure DevOps (<https://dev.azure.com>), open User settings → Personal access tokens. Set organization to **All accessible organizations** and scope to **Marketplace → Manage**. Then run `bunx @vscode/vsce login flywheel-core-team`. Revoke the token after the release is verified.

Set the next version in `package.json` and commit the source that will ship. Then generate and review the extension-only release notes before packaging. The command compares against the previous `vscode-v<version>` tag, includes shared runtime changes newly shipped by the extension, and excludes terminal-only interface work:

```bash
cd vscode
bun run notes:draft
bun run package
bun run publish:marketplace --dry-run
bun run publish:marketplace
```

The notes command writes `dist/release-notes.md` and a sidecar that binds those exact bytes to the extension version, source commit, and previous extension tag. The publication script requires that binding and the universal package, runs `bun run e2e:bootstrap` (below), then passes the notes to `vsce` as the Marketplace changelog. A real publication requires a clean committed tree. It stages `vscode-v<version>` locally before the Marketplace upload, removes that tag if the upload fails, and pushes it only after the Marketplace accepts the release. Binary tags remain `v<version>` and never act as extension release boundaries.

If Marketplace publication succeeds but the final tag push fails, do not publish the extension again. Stay on the same source commit and run:

```bash
bun run publish:marketplace --recover-tag
```

Recovery verifies that the local tag names `HEAD` and that the Marketplace already serves the package version before it pushes the tag.

## The runtime release comes first

The package installs whatever release is public as `latest`, so it must speak that release's protocol. Publish the runtime release this build needs first, then move `MINIMUM_RUNTIME_VERSION` in `src/runtime/runtime-resolver.ts` to it. The minimum never names an unreleased version, because a checkout reports the last public one.

`bun run e2e:bootstrap` proves the order. It installs the latest public release into a bare account home under the system temporary directory, exactly as the extension does on a new machine, starts its account service, and attaches once. It needs the network, downloads about 50 MB, and never touches the account it runs in. The publication script runs it in both modes and stops when it does not attach.

## In CI

There is deliberately no workflow file in this directory. GitHub reads workflows
only from `.github/workflows/` at the repository root, so wiring this into CI is
a change to the repository's own workflows and belongs to whoever owns them.

What such a job needs is small, because the runtime source is in this
repository rather than somewhere it has to be fetched from:

- Bun.
- `bun install --frozen-lockfile` at the root; the workspace covers `vscode/`.
- The root gates (`bun run lint`, `bun run test`, `bun run check:boundaries`),
  then `bun run package` in `vscode/`.
- `VSCE_PAT` as a secret, and only on a tag.

## What a reader of the listing gets

The Marketplace page renders `README.md` and `package.json`'s `description`, `categories`, `keywords`, icon, and gallery banner. The homepage points to the Flywheel website. Privacy and support are public sections of the listing README, and the manifest sends issue reports to the public Flywheel issue tracker.

## Before the first publish

- The Marketplace never accepts one version twice, so `version` moves before
  every publish.
- `package.json` names the public source repository, with `directory` set to `vscode`. `vsce` uses it to resolve relative links and images in `README.md`, so the listing shows them from the public repository.
