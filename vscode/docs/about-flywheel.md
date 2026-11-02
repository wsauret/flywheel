# Flywheel

**The coding agent that keeps working, inside VS Code.**

Ask Flywheel to make a change, not only to explain one. It can inspect the repository, run tools, edit files, and keep working through a workflow of several agents while you stay in the editor.

## Getting going

1. Open a folder.
2. Open the Flywheel panel.
3. Select a provider in the setup screen, or run **Flywheel: Authentication**.
4. Ask for a change.
5. Use **Changes** beside the composer to review retained file changes when the session has them.

If Flywheel is not installed yet, the extension installs the current release the first time it starts, so there is no separate CLI installation for normal use.

## What is in the panel

The toolbar always offers **+** for a new chat. After a session exists, it can also show the session picker, context and cost information, and a connection badge while the runtime reconnects. Provider, model, workflow, settings, and help actions are not toolbar buttons.

Type `/` on an otherwise empty composer line to open the action panel. It groups the actions available from the current runtime and configuration:

- Session creation, switching, renaming, compaction, reverts, closing, and deletion.
- Chat model, effort, provider accounts, profiles, available models, and usage.
- Skills, capabilities, web search, persistent processes, and update settings.
- Runtime status, logs, reconnect, setup help, and problem reporting.

Press Enter to send and Shift+Enter for a new line. With an empty composer, Arrow Up and Arrow Down recall earlier messages from the session.

## Add context from VS Code

Use the command palette and editor actions to attach what Flywheel needs:

- **Add selection to chat** sends the selected code.
- **Attach files** inserts workspace file references.
- **Add symbol to message** searches workspace symbols.
- **Add problems to message** attaches selected errors and warnings.
- Error and warning lightbulbs offer a focused **Fix** action. A non-empty selection also offers **Explain**.

The default shortcuts are `Cmd+Shift+L` or `Ctrl+Shift+L` for the current selection, `Cmd+Shift+U` or `Ctrl+Shift+U` for files, and `Cmd+Shift+F` or `Ctrl+Shift+F` to focus Flywheel.

## Durable workflows

Ask the chat for the work you need. The chat writes and launches a workflow when it needs one. The workflow shows as a card in that chat. Open the card to see its phases and agents, progress, model, effort, duration, and state above its transcript.

Pause or resume the queue when those actions are available. **Flywheel: Interrupt workflow** interrupts the active workflow. A workflow that has not ended takes a message from the composer, and a message to an interrupted workflow resumes it. If the editor window reloads, the detached runtime keeps working and the panel reconnects.

## Your subscription, not another bill

Sign in with ChatGPT, GitHub Copilot, SuperGrok, or OpenCode Go, or use an API key for Anthropic, OpenAI, Google, OpenRouter, or an OpenAI-compatible endpoint. Provider setup uses an API-key prompt, device code, or browser flow as required.

You can connect several accounts, switch account profiles, select the chat model and effort, assign models to other roles, and inspect provider-reported usage. The available providers and models come from the installed runtime and connected accounts.

## Review and undo

The **Changes** button appears beside the composer when the current session has retained changes. It opens VS Code's native multi-file diff editor. Select a mutation diff in the transcript to open one file.

Reverting a file or undoing the last turn checks the current files before writing. If a file changed after Flywheel touched it, the revert refuses instead of overwriting the newer work. Missing retained diffs are reported as omissions.

## Sessions and transcript

Use the session picker to switch between chats and workflow sessions. You can create, rename, close, or permanently delete sessions. Closing preserves history; deletion does not modify files in the workspace.

Long transcripts load a recent window first. Scroll upward or select the older-messages action to load more. Tool output that was shortened says so and offers **Load the rest**. Active subagent groups can expand and open their own session.

## Status and recovery

**Flywheel: Status** shows provider and MCP health, usage, context, workflow details, and other runtime information. It also offers MCP reauthentication when a connection needs it.

While Flywheel installs or starts, the panel says so. If Flywheel is missing, outdated, or cannot start, the panel states the cause and offers the action that fixes it: a setting, an update, the log, or Try again. Flywheel starts on its own after you correct a setting or open a folder. A connection that recovers by itself shows nothing; the status bar item changes only for a fault.

## Privacy and support

Project sessions and diagnostics stay on the machine where the extension host runs. Model providers and MCP servers receive the context required for the requests you send to them and process it under their own policies.

Use **Report a problem** in the `/` action panel or visit [GitHub Issues](https://github.com/wsauret/flywheel/issues). Remove private source, personal information, and credentials before posting logs or session details publicly.