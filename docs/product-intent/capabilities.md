# Capabilities Product Intent

This document states the current intended experience for Flywheel's optional capabilities: the modules a user can turn on or off.

## PI-CAP-001: Capabilities are modular and uniform

Every optional capability is one module that a user can turn off, and a module adds the same tools, commands, command-line verbs, views, and notices to every client. Turning a module off removes its contributions everywhere but keeps its saved data, viewable history, and settings, which have no effect until the module is on again. Turning a module on or off applies at once in every client without a restart, and work that already started finishes and can still be stopped or deleted. Every refusal or omission that an off module causes names the module and says to turn it on in Settings or remove it from `disabled_modules` in `flywheel.toml`.

## PI-CAP-017: Flywheel's own tooling is the development module

Flywheel's own tooling is the `development` module. In a source run it is one module like any other, and released builds do not contain it.

## PI-CAP-018: A module that builds on another is off while that module is off

A module that builds on another, such as Workflows on Skills, is off while that module is off, and Settings says which module to turn on first. Turning that module on again restores the person's choice.

## PI-CAP-019: Workflows has one Off, Ask, or On setting

Workflows has one setting with the values Off, Ask, and On. Ask needs Ask User on, but On does not.

## PI-CAP-002: Modules stay on unless the person turns them off

Every module is enabled by default, and each one turns on and off with no confirmation, except that a bulk change that turns off every module asks first. `flywheel.toml` records only the modules that the person turned off, in `disabled_modules`, so a module that a newer release adds is on, even when the person saved a module selection before. An invalid module selection is not an opt-out: it follows the configuration-file rules of PI-INTERACTION-076, so Flywheel keeps the last valid selection, or the default selection when no selection was ever valid.

## PI-CAP-003: An HTTP MCP server can use Claude as its client

Flywheel is the MCP client of a server by default, but an HTTP server can use Claude as its client instead. Flywheel chooses Claude for known servers that accept only approved apps that include Claude, and a person's choice for any HTTP server wins. Such a server connects through the Claude engine that ships with Flywheel, needs no Claude sign-in, and gives its tools to every provider. Its row and its sign-in action say that it connects through Claude and why.

## PI-CAP-014: MCP connections have explicit scope and account identity

Users can manage global MCP servers and project-specific definitions and enabled-state overrides on every client. Project-specific choices are private to the user's account. Distinct server names can use separate accounts at the same endpoint, and the same name and URL share one sign-in across projects. Removing a server keeps its sign-in.

## PI-CAP-015: A project MCP definition takes precedence over the global one

A project definition replaces a global definition of the same name, and an enabled-state override keeps the global connection details. Removal names its scope. Removing a global server also removes its project overrides but keeps full project definitions. Removing a project definition can reveal the global definition.

## PI-CAP-016: A failed MCP connection can be repaired from every client

A server that failed to connect can be reconnected from every client without a change to its configuration or to other servers. Removing or disabling a connection clears its attention warning. When Flywheel's own sign-in fails because the server allows no client registration, the error names the choice of Claude as the client.

## PI-CAP-004: Headless runs reach the same MCP servers

A headless chat, the agents of its workflows, its subagents, and a direct headless task can use the project's enabled MCP servers, as an interactive session can. Each run waits for the servers to connect before its first request, but never longer than the connection deadline. A server that needs a sign-in or fails to connect does not stop the run, which names that server on standard error with the command that repairs it. The servers the run starts stop when the run ends.

## PI-CAP-005: Full and Minimal presets set every module at once

Settings offers two presets beside the per-module settings. Full turns every module on and sets Workflows to On, and Minimal turns every module off.

## PI-CAP-006: Empty capability selections are allowed and named

A person can turn off every provider, or every tool, including all shell, file, and discovery tools. Flywheel accepts that selection, keeps working where it can, and, when no provider or no tool remains, shows a warning that names the empty capability. The warning never changes the selection.

## PI-CAP-007: Turning Usage off keeps accounting and paid-use permission

Turning Usage off also stops its background usage checks and threshold notices. It does not change model access, routing, or paid-use questions, and it keeps the person's thresholds. Flywheel keeps recording model requests while Usage is off, so Usage shows that activity when it is on again.

## PI-CAP-008: A broken module view does not break the client

When one module's part of a screen (its status line, panel, view, or badge) fails to draw, only that piece disappears. The composer, the transcript, and every other module keep working, and one notice names the module that failed.

## PI-CAP-009: Doctor reports each enabled module separately

`/doctor` reports, in its own section, the health of each enabled module that has a health check, and says when a section needs the person to act. A check that fails is reported in its section and does not stop the other checks. A module that is off adds no section.

## PI-CAP-010: Agent file changes carry Git AI attribution

Git AI attribution is a setting, not a module. With it on, Git AI attributes each file change an agent makes through its file or shell tools to that agent, and changes the person made before it stay attributed to the person. The attribution comes from the request that made the change, as captured when that request started, so a later settings or profile change does not relabel it.

## PI-CAP-013: A project opens in either a source run or the installed Flywheel, not both

A project that a source run serves cannot open in the installed Flywheel at the same time, and the reverse. The refusal names the other Flywheel and its process, so the person can close the project there or open it from there.
