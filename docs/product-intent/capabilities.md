# Capabilities Product Intent

This document states the current intended experience for Flywheel's optional capabilities: the modules a user can turn on or off.

## PI-CAP-001: Capabilities are modular and uniform

Every optional capability is one module a user can turn off. A module contributes the same commands, views, and notices to every client, and turning it off removes all of them everywhere: its tools leave the agent, its commands leave every command list, the palette, and completion, its command-line verbs leave the `flywheel` command, and its views and notices leave every screen, but its saved data and history stay. Recorded work stays viewable, stoppable, and deletable: while Workflows is off, past runs and their cards remain, and only new launches are gone. Turning a module off keeps its settings unchanged, and they have no effect until the module is on again. Turning a module on or off applies at once in every client, without a restart, even for a module that was off at startup. Work that already started when a module turns off finishes; only new work sees the change. Every refusal or omission that an off module causes, to a person in any client, at the command line, or to an agent, names the module and says to turn it on in Settings or remove it from `disabled_modules` in `flywheel.toml`. Flywheel's own tooling is the `development` module: in a source run it is one module like any other, and released builds do not contain it. A module that builds on another, such as Workflows on Skills, is off while that module is off, and Settings says which module to turn on first. Turning that module on again restores the person's choice. Workflows has one Off, Ask, or On setting. Off removes workflow launch. Ask lets a chat write and launch workflows with the person's approval for each launch. Ask needs Ask User on, because each launch asks the person; On does not. On also tells the root chat to orchestrate substantive work.

## PI-CAP-002: Modules stay on unless the person turns them off

Every module is enabled by default, and each one turns on and off with no confirmation. `flywheel.toml` records only the modules that the person turned off, in `disabled_modules`, so a module that a newer release adds is on, even when the person saved a module selection before. An invalid module selection is not an opt-out: it follows the configuration-file rules of PI-INTERACTION-076, so Flywheel keeps the last valid selection, or the default selection when no selection was ever valid.

## PI-CAP-003: MCP connections have explicit scope and account identity

Users can manage global MCP servers and project-specific definitions and enabled-state overrides on every client. Project-specific choices are private to the user's account. Distinct server names can use separate accounts at the same endpoint; the same name and URL share a sign-in across projects. Removal identifies its scope. A project definition replaces a global definition of the same name; an enabled-state override keeps the global connection details. Removing a global server also removes the project overrides that depend on it but keeps full project definitions, and removing a project definition can reveal the global definition. Removal keeps the server's sign-in. Removing or disabling a connection clears that connection's attention warning. A server that failed to connect can be reconnected from every client without a change to its configuration or to the other servers.

## PI-CAP-004: Headless runs reach the same MCP servers

A headless chat, the agents of the workflows it launches, and its subagents can use the project's enabled MCP servers, as an interactive session can. A direct headless task has the same access. Each run waits for the servers to connect before its first request, but never longer than the connection deadline. A server that needs a sign-in or fails to connect does not stop the run: the run names that server on standard error with the command that repairs it. The servers the run starts stop when the run ends.

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
