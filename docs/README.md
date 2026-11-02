# Flywheel user documentation

The command line, slash command, key, and configuration pages are generated from the code that defines them, so they match the release that you run. Flywheel also installs a copy of each Reference page in `~/.flywheel/`, next to `flywheel.toml`.

## Reference

- [Command line](../src/workflows/docs/cli.md): every `flywheel` subcommand and option, with its syntax.
- [Slash commands](../src/workflows/docs/commands.md): every built-in command that you can type in the prompt, with its aliases and key.
- [Keys](../src/workflows/docs/keys.md): the default keys of the terminal interface, and how to change them.
- [Configuration](../src/workflows/docs/configuration.md): every setting in `flywheel.toml`, with its type, default, and an example.
- [Custom providers](../src/workflows/docs/custom-providers.md): how to add a model server that speaks the OpenAI chat-completions API.

## Policies

- [Privacy](privacy.md): what Flywheel sends, where, and when.
- [Provider terms](provider-terms.md): the evidence that Flywheel's subscription sign-ins follow each provider's terms.

## For contributors

- [Contributing](../CONTRIBUTING.md): how to set up the repository, check a change, and open a pull request.
- [Architecture](architecture.md): the layers, the modules, and where each kind of code lives.
- [Terminology](terminology.md): the terms that Flywheel uses.
- [Product intent](product-intent/README.md): the statements of user-observable behavior.
- [Architecture intent](architecture-intent/README.md): the statements of the internal organization.
- [Elegance](elegance.md): the rubric that judges designs and code.
- [Development skills](../src/orchestration/modules/development/definitions/skills/): the methods for specific kinds of Flywheel work, such as session debugging and web client rendering.

## Help

- [Support](../SUPPORT.md): where to ask questions and report bugs, feature requests, and security problems.
