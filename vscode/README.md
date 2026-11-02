# Flywheel for VS Code

<p align="center"><b>The coding agent that keeps working, inside VS Code.</b></p>

Flywheel runs whole jobs as durable workflows. A run survives a window reload, a crash, an update, or an empty quota. Bring every subscription you pay for, Claude included, and follow the same live session from VS Code, your terminal, your browser, or your phone.

## Getting started

1. Install the extension and open a folder.
2. Open the Flywheel panel.
3. Select a provider in the setup screen, or run **Flywheel: Authentication** from the command palette.
4. Ask for a change. Flywheel opens a session on the first message and starts working in the current project.

If Flywheel is not installed yet, the extension installs the current release the first time it starts, the same way the command-line installer does, and it keeps itself up to date like any Flywheel installation. You do not need to install the CLI separately. Advanced users can select another executable with `flywheel.executablePath`.

## Safety

Flywheel agents work without asking you to approve each step. They run shell commands and edit files with your user account's permissions.

- Guards catch ordinary mistakes, but they are not a sandbox. They do not confine the programs that an agent runs.
- **Changes** shows the session's file edits, with undo for each file. A shell command can also change files outside that record.
- For an untrusted repository, or work where a mistake would be costly, run Flywheel inside a boundary: a container, a virtual machine, a low-privilege account, or a disposable checkout. A dev container works well for this.

## Ask for the whole job. It keeps going.

Describe the work in chat. The agent writes a workflow and launches it: phases of agents that build, review, repair, and verify, with independent work running at the same time. The run lives in a background service, not in your VS Code window.

- Reload or close the window. The run continues, and the panel reconnects to it.
- Update Flywheel mid-run. Running agents and shell commands move to the new build.
- Out of quota at 2 a.m.? The agent waits for the reset, then continues.
- After a crash, Resume restarts only the agents that were in flight. Finished work stays finished.

Open a workflow from its card in the chat. A running workflow shows its phases and agents, progress, model, effort, duration, and state above the transcript. Pause and resume it when it supports them, send it a message from the composer, or interrupt it with **Flywheel: Interrupt workflow**. A message to an interrupted workflow resumes it.

## Every model you pay for. No lock-in.

Sign in with **Claude, ChatGPT, GitHub Copilot, SuperGrok, or OpenCode Go**. Add API keys for **Anthropic, OpenAI, Google, DeepSeek, OpenRouter**, or any OpenAI-compatible endpoint. Choose a model for each role: the chat, workflow agents, and background work.

- Subscriptions serve first. API keys serve only when no subscription can.
- Failover happens inside the turn. You never retry by hand.
- Each request records which provider and account served it.

## Two subscriptions? Flywheel uses both.

Add several accounts of the same paid subscription. When one hits its usage cap or goes down, the next account takes the turn, and nothing on your screen changes. For Claude, the account whose weekly window resets soonest goes first, so quota that is about to expire gets used first.

- Paid overage stays off until you allow it, once per account.
- The Usage view shows each account's spend and history.
- API keys catch what no subscription can serve.

## Claude, through Anthropic's own SDK.

Flywheel signs in to your Claude subscription through the official Claude Agent SDK. Anthropic's engine holds the login: Flywheel never reads, stores, or sends your Claude token. Flywheel's tools, workflows, subagents, skills, and session recording all work on this route.

- Sign in with **Flywheel: Authentication**.
- Several Claude accounts rotate like any other subscription.
- Your own Claude login and settings outside Flywheel stay untouched.

## One session. VS Code, terminal, browser, or phone.

The panel attaches to the same live session as every other Flywheel client. Start a job in VS Code, check on it from the terminal, and answer the agent's question from your phone.

- `flywheel` in a terminal opens the same sessions in the terminal UI.
- `flywheel web` opens the web client. Only your machine can reach it.
- `/remote` pairs your phone with a QR code. No account, no password.
- Every message is sealed end to end. The relay cannot read it.
- Your phone notifies you only when a chat asks you a question.

## Built for the editor

### Your editor is the context

Use VS Code's native pickers instead of copying paths and diagnostics by hand:

- **Add selection to chat** is available from the editor context menu.
- **Flywheel: Mention a project file** inserts selected workspace file references.
- **Flywheel: Add symbol to message** searches workspace symbols and inserts the selected location.
- **Flywheel: Add problems to message** attaches selected errors and warnings.
- Error and warning lightbulbs offer a focused **Fix** action. A non-empty selection also offers **Explain**.

### Review and undo in the native diff editor

When the session has changed files, a **Changes** button appears beside the composer. It opens VS Code's native multi-file diff editor. Mutation tool rows can also open a diff for one file.

A file revert or last-turn undo first checks that the file still matches the recorded change. If you edited the file afterward, Flywheel refuses the revert instead of discarding your work. If a change has no retained diff, Flywheel says so rather than presenting incomplete review as complete.

### The panel

The toolbar shows only the controls that apply to the current state:

| Control | What it does |
| --- | --- |
| Session picker | Opens existing chats and workflow sessions. It appears after a session exists. |
| **+** | Starts a new chat and is visible even before the first session. |
| Context ring and cost | Appears when the current session has context or spend information. Select the ring to compact the session. |
| Connection state | Appears while the extension is connecting or reconnecting to the runtime. |

Type `/` on an otherwise empty composer line to open Flywheel's action panel. It contains session actions, model and usage controls, provider and profile management, skills, runtime settings, status, logs, and recovery actions.

Press Enter to send and Shift+Enter for a new line. When the composer is empty, Arrow Up and Arrow Down recall earlier messages from the current session.

### Quick actions

| Do this | macOS | Windows and Linux |
| --- | --- | --- |
| Focus the Flywheel composer | `Cmd+Shift+F` | `Ctrl+Shift+F` |
| Add the current selection | `Cmd+Shift+L` | `Ctrl+Shift+L` |
| Attach files | `Cmd+Shift+U` | `Ctrl+Shift+U` |
| Open actions, skills, and settings | Type `/` | Type `/` |
| Find every extension command | **Flywheel:** in the command palette | **Flywheel:** in the command palette |

## Smaller things that matter

- **Everything is on the record.** Sessions are stored as facts in a local SQLite database. `flywheel events search` answers what happened.
- **Turn anything off.** About 20 capabilities each have one switch. Off removes their tools, prompts, and commands.
- **MCP.** Add servers over stdio or HTTP with OAuth (`flywheel mcp add`), or import an `.mcp.json` file (`flywheel mcp import`), and check their connection health from the panel.
- **Skills and memory.** Learned skills are files you can read, and `flywheel skills why` traces each one to its sessions.
- **Background commands.** Builds, test suites, and dev servers run while the agent keeps working, and each result reaches the agent when it ends.

## Requirements and remote workspaces

Flywheel requires VS Code 1.96 or later and an open folder. It runs as a workspace extension, so in SSH, WSL, and dev-container sessions the extension and runtime run beside the project on the remote host, and a remote host with no Flywheel gets it installed there.

Flywheel runs on macOS on Apple silicon and Intel, on Linux with glibc or musl on x64 and ARM64, and on Windows on x64 and ARM64. On a musl Linux such as Alpine, install the C++ runtime first (`apk add libstdc++`). You can override the project root with `flywheel.projectRoot` when the first workspace folder is not the project Flywheel should own.

When Microsoft's Remote - SSH extension is installed, Flywheel offers to install itself automatically on future SSH hosts. You can change that choice later with **Flywheel: Install automatically on SSH hosts** or **Flywheel: Stop installing automatically on SSH hosts** in the command palette. An SSH window that is already open may need to reconnect once.

## Privacy

For model inference, Flywheel sends your prompts and code only to the model providers that you configure. Agent tools can send content to other destinations, such as an MCP server, a web search service, or a host that a shell command reaches. Project state stays in the project's `.flywheel/` directory, and account settings stay in `~/.flywheel/`. In a remote workspace, both stay on the remote machine. Release builds send an automatic crash report with the error, the version, the platform, and recent diagnostic records. A report holds no conversation or file content. Turn off the Bug reports setting to stop crash reports. [What Flywheel sends over the network](https://github.com/wsauret/flywheel/blob/main/docs/privacy.md) lists every request that Flywheel makes on its own, what it holds, and the controls that exist for it.

Provider credentials are sent only to the relevant authentication or provider endpoint. Flywheel keeps credentials out of model context, logs, and snapshots.

## Support

Report bugs and request features through [GitHub Issues](https://github.com/wsauret/flywheel/issues). The `/` action panel also includes **Report a problem**. Before attaching logs or session details, remove source code, personal information, and credentials that you do not want to share publicly.

## License

Flywheel for VS Code is distributed under the Apache License 2.0.
