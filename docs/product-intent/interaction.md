# Interaction Product Intent

This document states the current intended experience for Flywheel's interactive controls.

## PI-INTERACTION-001: Text editing is consistent and contextual

Flywheel text fields provide consistent, discoverable terminal editing controls while allowing the active surface to reserve keys for its own navigation and actions.

The chat prompt and Ask User text inputs use the same editing behavior. Hotkey help is compact and groups the keys relevant to the active control. The Usage view presents its navigation vertically.

In the terminal slash popup, Enter completes and executes the currently highlighted suggestion. Tab completes a suggestion without executing it. When no suggestion is available, Enter submits the command text as typed.

## PI-INTERACTION-002: Transcript selection follows edge dragging

While a user extends a mouse selection beyond the visible transcript, the transcript scrolls in that direction and keeps extending the selection until the user releases the mouse or reaches the transcript boundary.

## PI-INTERACTION-003: Startup reaches an interactive chat promptly

Flywheel shows an interactive prompt and makes chat ready promptly after launch in empty and populated workspaces. While the terminal waits for its first chat, it names what it is starting now over one progress bar for the whole start, and a startup failure of the background service or the project appears there with its reason.

## PI-INTERACTION-004: Ask User options can require text

Ask User options can require text. Every text entry starts immediately after its option title and wraps when needed, and Flywheel submits the selected option and its text as one answer.

## PI-INTERACTION-005: Tool work appears as it happens

Flywheel shows each transcript-visible tool call and its available input, output, and mutation evidence as soon as it can do so accurately, without waiting for sibling calls or the rest of the model turn. A running shell command streams its output as the command produces it, on every client, whether it runs in the foreground or in the background and across turns, until it settles; its row then shows the settled output. A shell command that mutated project files settles as the writes and edits it made instead, shown the same way as any other file edit (PI-AGENT-017).

A settled mutating command with no mutation evidence shows its settled output followed once by Flywheel's bounded landing report, including recovery instructions when they apply. Commands with mutation evidence keep the file-change presentation. The output area excludes foreground-to-background transfer notices and other process-management instructions. It stays empty until output or a settled landing report is available. Detach and Stop remain separate controls: Detach, or the command reaching its foreground time limit, moves that one command to the background, and its row then offers Stop instead. A command that ends first stays an ordinary foreground result and never appears as background work.

File-editing tools show proposed changes as rendered diffs while input arrives, including unfinished lines, never as raw tool-input bodies. Successful execution replaces the preview with the actual file changes in the same view, without duplicate bodies or automatic collapse. User expansion choices and transcript scroll intent remain in place.

File-editing previews are provisional. Flywheel checks syntax and applicability as enough input arrives; a detected problem replaces the proposed changes with a compact advisory message. Final execution replaces that advice: successful calls show actual changes, and failed calls show only the tool summary and error.

An unavailable preview check or advice that arrives after final execution never delays, refuses, or replaces the final result.

On the web client, every tool row arrives collapsed, edits and writes included, and shows no input, output, or diff until the user opens it. A streaming diff renders only inside a row the user has opened. A running command's Detach and Stop controls sit at the end of its own row, over the tail of a long command, so the row keeps its one-line height. A file-editing row names every file it changes beside the tool name, while its input arrives and once it has run, so a collapsed edit never reads as a bare tool name.

In the terminal, unexpanded output previews, diffs included, show at most their first 20 displayed rows after wrapping, with a separate limit for each file. A diff preview arrives with its file's details, so it has its final height when it appears and nothing below it moves as content loads. Wrapped diff lines continue under the code, beside the line number. A file with hidden rows or lines shows its expansion control, and expanding it shows every line in full, wrapped. Headings and expansion controls remain outside this limit. Further content streams out of sight until expanded, subject to displayed retention limits.

When a command removes a directory, its row shows that directory once, with the number of files and their size, instead of each file; expanding it shows each file's change.

Session-note mutations are clearly labeled and fully collapsed by default; users can expand them to inspect the content or diff.

Write calls use language syntax highlighting. Edit and patch calls use diff colors without language syntax highlighting, during both streaming and completed display.

Write output uses an independently selected syntax palette: Nord by default, with Slate and Vesper available. The selection does not change chat Markdown, fenced code, interface colors, or edit and patch diff colors.

Slate and Vesper match Nord's brightness and saturation range. Write syntax styling is neither rainbow nor monochrome.

Tool calls display typed filesystem paths relative to the execution directory while preserving canonical paths for navigation and file identity. Paths in a session's tool rows, links, and diffs resolve against that session's recorded working directory, never the client's launch directory, so its history reads and opens the same after a restart or from another directory.

Tool failures show concise plain-text explanations of what happened, not serialized error envelopes.

A script the agent runs through the code tool has no row of its own. The tool calls the script makes appear under one Executed heading, which shows the run's elapsed time once the run has settled. The terminal and web clients show this the same way.

Call summaries under Executed show at most two displayed lines, with an ellipsis for omitted input. This limit does not apply to ordinary shell command rendering.

Stop ends a background command, a subagent's current work, or a workflow, and a stopped child's pending tool call in its parent resolves. Work a person stopped is shown as Stopped, and work an agent stopped is shown as Canceled. These distinctions remain visible in saved transcripts. Interrupted work is not stopped work and is shown as interrupted. Work that its parent agent interrupted is shown as interrupted by the parent, in the parent's transcript and in the child's own transcript. A stopped or canceled subagent admits explicit Resume; completed subagents, stopped commands, and stopped workflows do not.

Subagent dispatches appear as compact activity rows in the parent transcript. Each subagent row is a header and one agent line, in the words of an agent line on a workflow card (PI-INTERACTION-051). The header names the subagent's persona, goal, model and effort, and operations, and holds Open, the subagent's Interrupt or Resume as its state admits, and Stop while it runs. The agent line shows the run's state glyph and one sentence: the newest call while the subagent runs, or what it waits on; the first sentence of its handoff summary once it completes, marked partial when it stopped at its turn budget; its failure reason, followed in a quieter style by the provider's detail; who interrupted it; or that it was stopped or canceled. A narrow header drops the operations first and cuts the goal before the model, and shortens the model only once the goal is gone; it never drops the persona, the model, Open, or a control. In the terminal, the header shows the run's elapsed time after the model and effort, and a narrow header never drops it; on the web client, the header's row time carries it. Every openable row keeps an open-view affordance after the child settles and never shows an expand-or-collapse affordance. On the web client, subagent rows show activity at the left and keep their open-view affordance visible at the right, independent of text truncation. Tool output bodies, including streaming previews and completed diffs, are not rendered in the parent transcript. A subagent's own session retains its normal tool output views.

While a subagent initializes, its row shows its available persona and Initializing... in place of its goal. Its goal, model, controls, and activity appear together when the child is ready.

A workflow launched from a chat appears in the chat's transcript as an activity row like a subagent row, marked with the workflow glyph before its name. The row states the workflow's goal, its total operations across all its agents, and its duration. It names no model, because each agent can run on a different model. A workflow's name is the short title its launch gives. The card, the background list, and the workflow's view show that same name. Flywheel generates a name only for a launch that gives none.

A subagent's card opens its child's ordinary transcript, in the terminal in a nested viewer, and Close or Escape returns to the preceding view without interrupting work. On the web client it selects the child and preserves parent navigation, and Escape in its composer interrupts that subagent, as in a workflow agent view (PI-INTERACTION-044). On a phone-width web client, a subagent's or workflow's card keeps its header to one line that never wraps: one `⋯` control stays at the end of the line, the header's text fades out behind it, and the control opens a menu of the actions the card admits, each with what it does, and a long press on the header, or a right-click with a mouse, opens the same menu. The controls never take a row of their own. A wider web client shows each control as its own button on the header line. A workflow's card opens at full size, and each agent of the workflow opens in its agent view (PI-INTERACTION-051). Settled cards remain openable.

Message, interrupt, resume, and stop calls name their action and the name or short goal of their target, not its session identifier, and show their own outcome separately from earlier child work. A rejected call does not mark that child work as failed.

Accepted resume calls to a subagent use the full subagent activity view and identify their action. When a subagent is resumed, only the latest accepted resume shows it running and settling; the dispatch and any earlier resume show it as interrupted. Its agent line starts with the newest call of the child session's earlier work and moves to each new call. Failed subagent rows show one short error explanation, followed in a quieter style by the provider's detail when it has one, without instructions to retry by sending a message.

Every client shows the same transcript: the same messages, calls, results, subagents, and thoughts the reader has chosen to see, in the same order. Provider-designated narration appears as assistant messages even when thoughts are hidden. Clients differ only in how they group and preview those rows. In the terminal, consecutive reads, listings, and searches appear under one Explored heading, and consecutive shell commands and session bookkeeping calls (messages, notes, memory, skill changes, papercuts, experiment records, and controls of child sessions) under one Ran heading, each showing the run's elapsed time once it has settled. On the web client, every call between one message and the next gathers under one heading that counts what was run and used, such as "Ran 2 commands, used 2 tools (1 failed)"; only an assistant message, a subagent, or an Ask User question ends a stretch. The heading changes in place as calls land, the group arrives collapsed, and a settled stretch of one call is that call's own row; while a stretch runs, its heading previews its newest calls (PI-INTERACTION-054). On both clients, consecutive reads by one tool fold into one row that names each file by its basename, and a read row shows what was read, never its contents. A shell command appears once its command text has arrived.

Dividers fall at the same place on every client: before narration that resumes after finalized tool work. No other row takes a divider. A visible thought between tool work and narration means the narration takes no divider. On the web client a folded turn (PI-INTERACTION-053) shows its dividers once it is opened.

Work still running is never dimmed. A running tool call, run, or subagent shows a pulsing marker where its row's marker sits, and a row with nothing to open reads as a plain row, not a disabled one.

## PI-INTERACTION-006: Session statistics stay live and remain visible

Session statistics update as measured usage becomes available from each model request in the session, including running subagents, even while the parent waits. Final available statistics remain visible after work stops. Requests that a provider served without reporting usage are counted as unmeasured, and requests whose usage report ended early are counted as partially measured.

Parent session statistics include request usage from subagents and workflows, including nested descendants, once per request. Context-window readings remain local.

Historical usage that cannot be assigned to one agent remains part of the workflow's total. The total remains exact, and the per-agent split is shown as unavailable. The same request never counts twice in a workflow or parent total.

Subagent resume statistics continue from the same child session's previous work, excluding inactive time.

Users can inspect the current session's reported cache reuse, token and request usage, tool outcomes, and cost breakdowns, including descendant work, from Stats on every client. Each reading identifies its scope and any missing data. Cache reuse is the share of reported input read from cache and reads the same on every client; missing cache detail reads as unavailable, never zero. Open Stats stays current. When a refresh fails, Stats keeps that session's latest reading, shows the failure, and offers Retry. Stats never shows another session's reading.

Users can compare measured generation speed by model and reasoning effort, including descendant work, in Stats on every client. The session header shows the current agent's own average generation speed. Readings identify their token-count basis and missing measurements. Generation speed counts streamed assistant text and tool arguments in comparison tokens, not billed tokens, over streaming time only; reasoning, waiting, and tool execution do not count.

Terminal header statistics, including context usage, stay neutral colored regardless of usage or session state. On the web client, context usage sits in the session header as a ring with its percentage, so it never reads as a loading indicator. Choosing it explains the reading and offers compaction rather than compacting at once.

Displayed session costs round to the nearest cent with two decimal places. Recorded costs retain their full precision.

While historical aggregate statistics are unknown, the session picker leaves their values blank. A new terminal chat with no recorded usage leaves its header statistics blank. Other surfaces mark initial aggregate loading. No surface presents partial aggregates as final, and known statistics remain visible during refresh.

## PI-INTERACTION-007: The transcript stays on screen through recovery

A transcript with content never shows as empty. When Flywheel's view of a session disagrees with the runtime, it keeps showing the current transcript until the replacement arrives, then shows the newest transcript in its place.

## PI-INTERACTION-008: Session changes are reviewable in one place

Flywheel shows how many project files the current session has changed. A session's changes include the changes of every subagent and workflow agent it launched, at any depth, so after a workflow edits files, the chat that launched it counts and lists them. A subagent's or workflow agent's own review, where a client opens one, covers only that session and the sessions it launched. Flywheel-owned files inside the project's `.flywheel` directory are not listed or counted. One action opens a scrollable list of every changed project file. The review opens in path order. Incoming changes update that ordered review in place without flashing or changing the reader's viewport and expansion intent. Each file has a clearly marked header and one rendered diff from its content before the session touched it to its content now. Each diff has a short preview that expands in place. A Viewed checkbox collapses the whole file and records that its latest session edit was reviewed. Viewed state remains available across clients and restarts. Edits to other files leave it unchanged; a new edit to that file unchecks it and reveals the updated diff. This review works on every client surface, and a host with an editor also offers to open the same file there. In the terminal, the clickable Changes label sits in the prompt bar beside the remote-control display, not in the statistics header, and appears only when the last known count is greater than zero. It shows the last known count without loading, error, unknown, or stale labels. An incomplete count uses a plus sign. Request states and errors appear only inside the review, and /changes remains available when the prompt bar does not show the label. On the web client, the Changes control beside the prompt likewise appears only when the last known count is greater than zero. Each file header holds one line: the kind of change, the path shortened from its start so the file name stays, the launched agents that changed the file, by the titles their own views show and in the agent-name color, the lines added and removed, and the file's controls. The session's own changes name no agent. A diff marks each gap of unchanged lines between its changed sections.

The review includes changes outside the loaded transcript. It shows only the work of this session and the sessions it launched: a file that something else changed after their last recorded write is neither listed nor counted. When the session and the sessions it launched changed the same file, the file's one diff runs from its content before the first of their changes to its content after the last. Viewed state belongs to the review that records it. A file whose diff was not retained says so and offers no Undo. Files the session deleted under a directory that no longer exists appear under one header for that directory, with the number of files; expanding it shows each file with its own diff and controls. A review that shows no files while files the session changed are left out says why they are left out.

Each file offers Undo, which asks for confirmation and then restores the file to its content before the session or a session it launched first touched it, including deleting a created file and restoring a deleted one, without starting agent work. Flywheel checks that the file still matches its last recorded state before it writes, and refuses restoration with a short reason when retained evidence cannot prove the result.

## PI-INTERACTION-009: A pending question docks at the prompt

While a chat waits on a question, the question and its choices appear at the prompt as the next thing to do, in the same frame the command menu uses, and leave once answered or skipped. The transcript then records the question as an Ask User entry with one row per question, titled by its header and carrying the answer, with a skipped question marked as cancelled. Subagents and workflows never ask the person (PI-AGENT-024), so their viewers, cards, and agent views show no question. On every client, Escape skips the question at the prompt, and an answer or skip that no longer applies says why.

A pending question stays pending when its session closes or Flywheel stops, including when the agent ran other tools beside it. Reopening the session shows it at the prompt again, unanswered, and answering it continues the turn.

On the web client, saved question titles and answers wrap within the transcript width so their full text stays visible beside the indented bullet.

Ask User context appears immediately before its question entry as a normal assistant transcript message, with the assistant dot and full Markdown rendering, equivalent to an assistant message followed by a tool call in the same turn. It is not tool content or question-dock copy.

## PI-INTERACTION-010: Typing anywhere goes to the prompt

A printable key pressed while no editable control or dialog has the keyboard goes to the prompt, so `/` opens the command menu and a letter starts a message from anywhere in the client without a click first, as in the TUI. Shortcuts with a modifier, space, and keys inside an editable control or an open sheet stay where they landed.

## PI-INTERACTION-011: The transcript follows new output until the user leaves the bottom

On every client the transcript stays pinned to its newest output while the user is at the bottom, so new content scrolls the page. Scrolling away stops the following, and a single control appears above the prompt. Before another message arrives it offers the latest output; after messages arrive it shows how many are new. Activating it returns to the bottom and resumes following, whether the user had scrolled up or paged back far enough to leave the live end. Pointer wheel input over this control still scrolls the transcript.

The prompt floats over the transcript rather than ending it. At the bottom the newest output sits clear above the prompt; scrolled up, the transcript continues beneath the prompt, dimmed toward the page colour, all the way to the bottom edge.

On the web client, a blank text line of space separates the live activity status from the prompt.

## PI-INTERACTION-012: Session selection reuses an empty new chat tab

Selecting an existing session replaces the current New Chat tab only when that tab is empty and has no draft. A New Chat tab with content or a draft remains open.

## PI-INTERACTION-013: Session indicators distinguish lifecycle and activity

A session appears active in tab and session indicators while Flywheel owes work for it, including while its parent agent waits for running background commands, subagents, or workflows. It appears idle only after Flywheel yields the turn to the user.

A session's prompt shows that session's current activity through the same status display whether the session is open in a tab or in a nested subagent viewer or a workflow's agent view.

The terminal session picker shows a muted ○ for inactive but openable sessions, a steady green ● for active sessions waiting for work, and a blinking ● for sessions doing work. Inactivity does not use an error or unavailable symbol.

## PI-INTERACTION-014: Notifications show when they were raised

Every notification shows the date and 24-hour time it was raised, to the minute, in the user's local time, on the terminal and web clients alike.

## PI-INTERACTION-015: Notifications remain available after recovery

Notification toasts and the notification list stay consistent. Condition recovery does not remove a notification: when a notification's condition clears, the notification, and any toast already shown, stays and is marked resolved. A notification remains available for 48 hours after it was raised unless it is dismissed first. If the condition comes back, it shows as a new notification.

## PI-INTERACTION-016: A new chat's card names the commands that change it

A blank chat opens on a card that states the model, the project, the branch of the chat's working directory when that directory is on one, and the profile when more than one exists. Each fact a command changes is followed by that command, `/model` and `/settings`, in the same words on the terminal and web clients, and the web card's commands open the matching sheet when tapped.

The card shows the currently connected backend's version, including at the top of an existing session after an in-place backend update. A per-project Show build setting defaults off. Turning it on adds the backend's eight-character build identifier beside the version, as in `(v0.0.10 build 3029f1ab)`. Installed runs identify their running build; source runs identify their running source snapshot. If the backend cannot identify its build, the enabled display says `build unavailable`. Version, build, and visibility update in existing cards without reopening the session.

## PI-INTERACTION-017: The web command menu opens on settings in expected-use order and shows commands to typing

On the web client a bare `/` opens a menu of settings and frequent actions in one expected-use order that Flywheel ships, with the most-used settings first. Each setting that changes one value in place also appears in that menu with its control. It lists no other slash command or skill. Typing after the slash searches that menu and the full command catalog by name and description. A line under the menu states how many commands are available. That line and the Commands row open a sheet of the whole catalog in menu order, with descriptions and use counts. Picking an entry puts it in the composer. Workflows have no slash command or catalog entry: the person asks the chat to write and launch one. An open menu keeps its place while the session works. State changes update rows without returning a scrolled reader to the top.

The terminal's command menu ranks commands by how often the person used each one. Command use counts are one account-global record the runtime keeps, and the web Commands sheet shows them.

## PI-INTERACTION-018: Links remain one interactive target

All links act as one interactive target, no matter how long they are: hovering any row highlights the whole link.

## PI-INTERACTION-019: The model in use is always in view

Every client keeps the displayed conversation session's model and effort in view beside its prompt. The reading and its model controls name that session's serving choice. In an agent view, they name that agent, never its parent chat. The web command menu, model sheet, and prompt reading edit the same choice. Model and effort, in every client's command menu, edits that choice for the transcript in view, whether a chat, a subagent, or a workflow agent.

A model edit in an agent view changes only that session. The session inherits current workflow choices until the person overrides them. Choosing inheritance removes only its local override. A workflow-wide change reaches sessions that still inherit it and later attempts. Interrupt, Resume, and recovery preserve a session's local choice. A fresh retry or round starts from the workflow's current choice. Fields fixed by the workflow file or launch remain fixed.

## PI-INTERACTION-020: Context shows progress toward compaction

The terminal context control shows progress toward automatic compaction when enabled and the current context token count when disabled. Its running count uses the active model's token units. Opening it shows context details and an explicit Compact now action without starting compaction.

Context counts describe the content sent to the model, not omitted history or encoded transport data. Compaction preserves independent counts for the context before and after the reset, and the user-facing compaction report shows both.

For Copilot models described by models.dev, context capacity comes from that catalog rather than Copilot's advertised window. Context growth does not prompt users to start a new conversation.

## PI-INTERACTION-021: Action buttons have consistent affordances

Ordinary terminal action buttons have consistent padding, readable default styling, and visible hover and keyboard-focus feedback.

Terminal prompt-bar controls share the context control's subtle background highlight on hover. Clicking Remote Control opens its modal; New, Close tab, Switch, and Sessions perform their displayed actions. The prompt bar names the close of a tab "close tab", because "close" alone names Close chat (PI-INTERACTION-082). Clicking a visible background-process count opens the background modal. Clickable areas include the adjacent spacing without changing the bar's layout.

## PI-INTERACTION-022: Workflows belong to their parent chat

Every workflow is orchestration owned by the chat whose agent launches it, including a headless chat. A workflow is not a session. The person asks that chat to write and launch a workflow. Clients offer no direct workflow launch. Each agent attempt that starts has its own conversation session directly under that chat. A workflow's launching call stays pending while it runs or has interrupted work that can continue. Completion and Stop resolve that call and deliver the result to the parent once. Completed workflows are read-only, and follow-up conversation happens in the parent.

Earlier workflows remain reachable from the parent chat with their history and statistics intact. Unfinished follow-up input remains available for explicit continuation in the parent. Deleting a parent stops and deletes its workflows, their agent sessions, and its other owned child sessions, including nested descendants. This also applies to a workflow whose agents have not started. Independent forks remain intact. Deleting a session removes it and its owned work from every client, but its recorded conversation, including provider reasoning, stays in the project's database, readable through `flywheel events search`, until that database is removed.

## PI-INTERACTION-023: A chat can fork without changing its source

Running `/fork` in a chat copies its committed active conversation branch and its current checkpoint into an independent paused chat, leaves the source unchanged, gives the copy a distinct derived title, and opens the copy as the current chat. In the terminal, the copy opens in a new tab.

## PI-INTERACTION-024: Submitted messages appear immediately

In the terminal, Up on an empty first row recalls the latest unread queued person's message in both the main chat and a subagent viewer. A message the agent already consumed cannot be recalled. Recall preserves anything the person typed while it waited.

Submitting a chat message on any client shows its text immediately as queued while the runtime receives it. Runtime output replaces that local entry without a duplicate, including after transcript recovery. A message sent while the connection is down, or whose connection drops before the runtime confirms it, stays queued and is delivered when the connection returns, in the order the person sent it, and the session records it once. If the runtime refuses a message, or a fault other than a lost connection hides whether the message arrived, the message remains visible with the reason and is available to recall into the prompt for editing and explicit resubmission. Unread messages returned by a finished subagent stay visible in the parent chat and return only to the sending window's parent composer while that window is open.

A message that itself starts a new chat is the one exception: one sent while no chat is open, which asks the runtime to create the chat. Flywheel does not send it again by itself, because a second copy would start a second chat. If the connection drops before the runtime answers that creation, Flywheel says that the chat did not start, and the message is available to recall into the prompt for editing. The runtime may have started the chat before the answer was lost, so sending the message again can leave an earlier chat beside the new one. New chat and ctrl+n ask the runtime for the chat at the tap, so the first message sent into a chat they opened waits and goes out again like any other.

A message on its way cannot be edited: one still being sent, or one that waits for the connection. Up, in the terminal and on the web, keeps it queued and says that Flywheel is still sending it and sends it when the connection returns. Such a message shows no Edit control. A waiting message stays queued and is delivered when the connection returns however the client goes away and comes back: a web page reload, by Flywheel or by the person, a closed tab that the browser reopens, a terminal restart, and a self-update.

A message sent while the agent works reaches the next safe handoff without waiting for the rest of the current turn. Detaching a foreground command makes that handoff available immediately. If the runtime stops unexpectedly before the agent reads such a message, the message stays in the session and is delivered once, in order, when work continues.

## PI-INTERACTION-025: The web transcript reads in a centred column

On the web client the transcript reads in one centred column of comfortable line length, and the prompt matches its width. A pane wider than the column shows empty space on both sides of it; a narrower pane, such as a phone's, fills its width. Every transcript block shares the column's width. While a workspace panel is docked beside the transcript (PI-INTERACTION-056), the column centres in the space that remains.

## PI-INTERACTION-026: The session list is furniture the user arranges

On a web pane wide enough to show the session list beside the transcript, the user drags the list's edge to resize it, folds it away and back with a toolbar button or Mod+B, and finds it the same way next time in that browser. With the list folded, the toolbar title opens the list, as it does on a narrow pane.

## PI-INTERACTION-027: The web client answers a small set of chords from anywhere

On the web client, Mod+K opens the session list with its search ready to type into on a keyboard-and-mouse device, Mod+B folds the session list on a wide pane, and Mod+/ opens a sheet that lists every key the client answers, including the composer's own. Mod is the platform's command key. The command menu also offers the shortcuts sheet by name.

## PI-INTERACTION-028: Messages and code blocks can be copied on the web client

On the web client every message, tool call, group of calls, and folded turn has the clock time it started, with the date when it started on an earlier day; a running one shows how long it has run, and a settled one how long it took. Rows inside a collapsed group or a folded turn show their times only once it is opened. Where there is a pointer, a row's time appears at its right end while the pointer is over it, and a message shows a Copy control at its top right that copies its source text. On a touch device, dragging the transcript to the left reveals the times of the rows on screen and a Copy control beside each message; they stay until the person drags back or taps the transcript. No message spends a line of its own on its time or its Copy control. Every fenced code block has its own Copy control that copies the code alone. A copy that succeeds says so briefly on the control it came from.

## PI-INTERACTION-029: Words in any transcript can be found and opened

On every client, the user searches the words of the current session's transcript or of every session in the project. Hits are ranked by relevance and each shows who said it, the matching words in context, and in project scope the session's title; the search covers what people and the agent said and what tools returned, as recorded, including while a session works. Opening a hit lands its transcript on the block that holds it, in whichever session, marks that block briefly, and keeps the search open so the next hit is one key away. On the web client Mod+F and the command menu open the search; in the terminal a command does.

## PI-INTERACTION-030: Files are mentioned from a picker on every client

In the terminal and the web client, typing `@` in the composer opens a list of the project's files and folders matching what follows it, best match first, with a bare `@` listing the project's top level, folders first. Enter, Tab, or a click puts a file's project-relative path into the message as `@path` with a space after it, quoted when the path holds a space, the same reference the agent reads in every client. Visually equivalent Unicode spaces do not change which selected file the agent accesses. Picking a folder puts `@folder/` and keeps the list open inside it, and Escape leaves what was typed. The list respects the project's ignore rules and never offers Flywheel's own state or the repository's object store. On the web client the `+` control's menu and the command menu also start a mention, except in an editor that offers its own file dialog for the menu row.

## PI-INTERACTION-031: Files and photos attach to a message on every client

On the web client a `+` control beside `/` opens a short menu: add files or photos from this device, or mention a project file. Files or photos chosen there, pasted into the composer, or dropped onto it attach to the next message and show as removable chips until it is sent. In the terminal, pasting a clipboard image, dragging or pasting one or more local image paths at once, or choosing files through `/attach` attaches through the same message contract. Each dragged image path shows its own numbered image marker at once, not the path first. Enter waits for an image that is still loading and then sends the complete message once. If loading fails, a clear notice appears and the draft remains available without sending an empty image or its filename. The model sees an attached image as an image and an attached text file as its text with its name; a file of another kind or over the size limit is refused with a notice naming the file and what is accepted. A message can consist only of attachments. Queued and sent messages show one marker per attachment and preview attached images below their text, including when the session is reopened. Each preview preserves its proportions and stays within a bounded area smaller than the viewport. Activating a preview opens the retained full-resolution image in a viewer with fitting, zoom, and scrolling controls. Closing the viewer returns to the chat. Images behind an open modal do not show through its opaque background. On every client, `@` mentions a project file by path without attaching its bytes.

## PI-INTERACTION-032: Thinking progress stays honest

While a model thinks, the terminal shows elapsed thinking time and any live output progress the provider exposes. It never presents a placeholder as a measured token count.

## PI-INTERACTION-033: Overflowing terminal tabs follow horizontal scrolling

While the pointer is over the terminal header's tab bar, horizontal mouse or trackpad scrolling moves an overflowing tab bar one tab at a time in the scroll direction. Scrolling elsewhere does not move the tabs, and the overflow arrows remain available.

## PI-INTERACTION-034: Provider progress updates read as assistant messages

When a supported model provides a user-facing progress update, every client shows it as ordinary assistant text in transcript order while work continues. The update remains visible when the session is reopened. It does not count as a final answer or stop tool work. Private reasoning remains hidden.

## PI-INTERACTION-035: Agent work never blocks interaction

Flywheel keeps typing, rendering, navigation, session and tab controls, Stop, and connection liveness responsive while agents, tools, searches, indexing, builds, and tests run.

## PI-INTERACTION-036: A recovered connection is invisible and a lost one is explained

A dropped connection to the runtime that recovers is invisible: nothing is announced, and the transcript and composer stay in place while output that arrived meanwhile appears. When recovery fails, one notice says in plain words what is wrong and what to do about it, and the notice disappears on its own once the runtime answers again.

## PI-INTERACTION-047: Background service failures are explained

When Flywheel's background service stops within a minute after it starts serving, more than once in a row, every client that is attached to it or that starts it shows one warning while the service serves again: "Flywheel's background service keeps stopping soon after it starts. Last cause: <cause>." followed by "Flywheel starts it again. Open sessions continue when it starts." The warning adds no control, asks nothing, and never blocks input, and it disappears on its own once the service has served for a minute. One such stop that recovers shows nothing. When Flywheel cannot restore a project's sessions after its process stops, every client says so, with the cause in plain words when one is known, such as commands that did not stop or history that could not be repaired, until a later restore succeeds. When the service cannot start for a cause that `flywheel kill` alone does not fix, every client that starts it shows that cause and its own remedy, and the terminal keeps trying until the cause is gone.

## PI-INTERACTION-037: The background list shows a chat's background work

Each chat has one background list. It shows the background commands that the chat ran and every subagent and workflow that the chat started, in the order they started. A subagent or a workflow that another child started shows under that child. Each row is one tool call whose work continues in the background. A workflow is one call that runs one workflow, and interrupt and Stop act on the whole workflow, so a workflow is one row: its agents and the work they start have no rows of their own. The workflow's row states how many of its agents are done of all, how many failed, and while it runs, how many agents run and their names. `/bg` and the background count in the terminal prompt bar open the list. On the web client, `/bg` opens it, and the command menu offers it while background work runs.

The list opens on active work: commands that run, and subagents and workflows that run or wait on their parent. One control, a button in the list or a key, shows all work instead. All work adds each finished command with its exit status and how long it ran, and each subagent and workflow with its status: interrupted, completed, partial, failed, stopped, or canceled. A finished subagent also shows how long it ran. Finished rows are dimmed. Each client remembers the last choice for the person who uses it. The background count in the prompt bar counts only active work.

The list is complete. It shows work whose card is outside the loaded part of a long transcript, and work that finished before Flywheel restarted. A command whose end Flywheel did not record shows that it ended, without an exit status.

Clicking or tapping a row closes the list and shows the row's card at once in the middle of the transcript view, without scrolling through the rows between, and loads older transcript when necessary. A card taller than the view shows from its top. A row nested under another child shows the card of the child that contains it. In the terminal, the card's background stays highlighted for three seconds so the person can find it. Enter, or the Open control on the web client, opens a subagent in its viewer or a workflow's full-size card. A separate `x` control stops a row that is still active, and the `x` key does the same in the terminal. On the web client, Stop asks for confirmation first.

Background commands start with their output collapsed. In the terminal, a person selects a running command with the arrow keys and presses Space to show or hide its recent live output directly under it, independently of other commands.

## PI-INTERACTION-038: Kill progress distinguishes planned and completed work

The kill command labels the processes it plans to stop before shutdown starts and confirms the result only after cleanup finishes.

## PI-INTERACTION-046: Kill stops only the account home it runs in

The kill command stops only the Flywheel processes of the account home it runs in. It leaves a process whose account home it cannot prove running and names it. The kill command with `installed` or `dev` stops only installed builds or only source runs, and leaves the other kind running. The kill command with `all` stops every Flywheel process on the machine.

## PI-INTERACTION-039: Web session IDs can be copied

On Windows, Linux, macOS, Android, and iOS, a user can copy the current web session ID from the command menu and any web session ID from that session's list actions. Copy works with a pointer, keyboard, or touch and confirms whether it succeeded.

## PI-INTERACTION-040: Session navigation lists chats

Session navigation lists chats only. The terminal session picker, the web session list, tabs, and their counts never show a subagent, an agent of a workflow, or a workflow. A workflow is not a session. A person reaches a subagent or workflow from its card in the parent's transcript or from the chat's background list. A subagent opens in a nested viewer in the terminal and as a selected child on the web client. Back returns through its ordinary parent navigation. A workflow opens its full-size card over its parent chat on every client. Its agent opens in the ordinary child-session viewer with the workflow header.

## PI-INTERACTION-041: Generated tab titles use title case

Automatically generated tab titles capitalize the first letter of every word. Their longer session titles keep natural sentence casing.

People can edit a session's tab title and longer description independently. Editing either leaves the other unchanged. Tab titles have a 14-character limit.

## PI-INTERACTION-042: An open session is always served

A session open in a tab is always served. After a runtime restart it comes back on its own, idle or still waiting for model capacity, with any interrupted work marked in the transcript, and the person never sees it as unserved or is asked to do anything to bring it back. If its runner cannot start, such as when its auth profile is gone, the tab stays open and its transcript shows one notice of the failure, which the next successful start removes; the next activation or message tries again, and a message sent meanwhile stays in the conversation. Escape on an idle chat with no question at the prompt does nothing.

## PI-INTERACTION-043: A chat turn is interrupted, never stopped

A running chat turn has one way to stop: interrupt. Every surface's control interrupts it, and so does Escape while no question waits at the prompt; a chat offers no terminal stop. Interrupting cuts the turn at once, including a tool call the turn is waiting on in the foreground, keeps everything already committed, leaves the session idle, and shows in the session whether a person or the runtime interrupted it. Interrupted work reads Interrupted, Interrupted by the parent, Interrupted by the runtime, or Interrupted by an unexpected exit, and continued work reads Resumed; no surface calls it paused. Subagents, workflows, and background commands the turn started keep running, and each has its own Stop. A turn that waits on them is still running, so Escape and Interrupt cut that wait too. An interrupted session does not wake on its own: a notification from background work or a message from another session is recorded but starts no turn, and it lands when the person resumes or sends a message. A turn that a restart or an unexpected exit interrupted while it waited on background work or on model capacity is different: it still waits, and the completion or the stated time wakes it, as either wakes a turn that no restart interrupted. An interrupted turn is always resumable: Resume continues it from where it stopped without a new message, and the same control resumes a turn that an unexpected exit interrupted: the transcript shows that interruption where it happened, and Resume never runs a tool call that already finished again. A message typed while the turn ran is delivered as the continuation. Sending a new message instead starts a fresh turn. A new message sent after an interrupt withdraws any approval the person gave during the interrupted turn and that the turn did not use, such as approval of a workflow launch, so the agent must ask again; Resume keeps those approvals. The person's latest decision wins: an interrupt that arrives after Resume or a message interrupts the turn it opens, and an interrupt from before that never cuts it. In the terminal, Resume is offered as a key hint beside the other session keys, and the status area shows no session controls.

## PI-INTERACTION-044: A workflow can be interrupted and resumed without a message

Interrupt stops the agents it names immediately: from an agent view, that agent; from the card's header, every agent that runs. The person and the workflow's parent agent can each interrupt and resume it; the parent never resumes a workflow that a person interrupted. Resume continues each interrupted agent without a new message and without starting its phase again, including after an unexpected exit or planned replacement. While a module that the workflow needs is off, Resume says which module is off and how to turn it on, and a message that the person sent to an interrupted agent is kept: its agent view shows the same words and that the message waits, and the agent continues with the message once the module is on, with no second send. After a Resume finds that the workflow's definition changed, the card says which parts changed and keeps Resume: once the person restores those parts, Resume continues the workflow (PI-AGENT-015). When the workflow's saved progress is damaged and its request is still readable, the card says so and offers Restart, which runs the workflow again from its recorded request. Stop ends the workflow for its parent and resolves the parent's call as stopped, shown as Stopped for a person and Canceled for an agent. The parent's result includes the last handoff that an agent wrote before the Stop, as a record of finished work and not as a request to continue. The card's header holds the workflow's Interrupt, Resume, or Restart and its Stop, at both sizes and on every client. In the terminal, Escape goes back one level and never interrupts, and Close returns to the chat. On the web client, Escape in an agent view's composer interrupts only that agent, and the full-size card has no Escape action. Escape does nothing in a parked or finished agent view. The Back control and the browser back gesture go back one level.

An agent view uses the same conversation body as a subagent viewer, including live status, transcript, model controls, background actions, and nested children. Both have the same size and shape: they fill the terminal but for a one-cell margin. Only its workflow header and agent navigation differ. Interrupt and Resume in that view act on its exact current agent session through the workflow. The agent view has no Stop for that agent alone.

## PI-INTERACTION-051: A workflow shows its whole plan on its card

The parent chat shows every workflow that it launched, built in or written for the task, as a card in its transcript, in the terminal and on the web client. The card is the one place that shows a workflow's plan and progress. A workflow has no transcript of its own: its card shows the plan, and each of its agents opens in an agent view. The card has two sizes that one model draws: inline in the chat, and full-size. Open, a click on the card's header, Enter or Open on the workflow in Background Work, or a link to the workflow shows the full-size card over its chat. On a phone the full-size card is the workflow's screen. The full-size card has no composer.

The card lists the workflow's phases in run order. A phase has one agent, several named agents that run in parallel, or one agent for each item of a list. Each phase of a stream shows on its own, so a stream of a probe phase and a check phase over the same items shows as two phases, `probe` and `check`, which run at the same time while items move from one to the next. The phases of each round of a repeat show as phases of their own, such as `hunt · round 2`. A repeat that runs while a check finds work numbers each phase by the check that it leads to, and its first round carries no round label. A phase after the check repairs what that check found, so it belongs to the next round: a debug run whose verify keeps finding the defect reads `investigate`, `fix`, `verify`, `refix · round 2`, `verify · round 2`, `refix · round 3`, `verify · round 3`. A phase that casts votes on each item has one agent for each vote. The agents of one phase can run different briefs, personas, models, and efforts. The card names a phase by its short id from the workflow, such as `rewrites`, and shows its longer name when the person points at it. An agent reads its item key, such as `api`, or its own id, such as `lint`.

The card shows every phase that the workflow can reach, from launch. A phase that runs only if an earlier phase finds it necessary reads "if needed" until that phase decides, and then reads as an ordinary phase to come or as skipped. A phase that the workflow can no longer reach reads skipped, so a workflow that completed or failed shows no phase as "if needed". A phase over an empty list reads zero targets, with no chits and no agent.

Progress reads as chits: a filled chit for each unit that finished well in green, failed in red, runs in blue, or an interrupt holds in yellow, then an empty chit for each unit not started, then the count. Each agent is one unit, so an item that moves through a stream of two phases counts two units. A phase over a list that is not known yet counts one unit until the list arrives, so the total can change then. A repeat that runs while a field is not empty counts the rounds that started, so each new round adds its units, and a repeat over items counts one round for each item. A phase over the launch input shows its agents from launch; a phase over a list that an earlier phase writes shows no chits and no count until that list arrives. The count counts the units that finished well, so a failed agent reads failed and never done, such as `20/21 done · 1 failed`. While the run goes on, an agent that its own interrupt holds counts as interrupted on the plan bar, as it does on its phase line and in the agent view's band, such as `1/22 done · 2 running · 1 interrupted`. The plan bar is the first line of the inline card, and the full-size card pins it at its foot. A phase shows one chit for each agent up to its slots; above that it fills its slots in proportion and the exact count follows, such as `13/30`. A state that holds any unit keeps at least one chit. In the terminal the inline card's plan bar has 30 slots and a phase 12, a card narrower than 80 columns 20 and 8, and a card below 46 columns 12 and 6; the full-size card has 40 and 12. The web client has 40 and 12, and a phone 20 and 8. The agent view's workflow band has 40 chits in the terminal and in the web client, and 12 on a phone, so they fit beside the word `workflow` and a count. A phase of one agent shows no chits: its glyph is its state.

A phase is one line: its glyph, its id, its chits right after the id, a quiet column, and its time at the right edge. While one of its agents runs or an interrupt holds it, its agents show under it as a tree, one line each: glyph, name, quiet column, and time. Every time on a workflow surface counts only active work: an agent's time is the time its session worked, as a chat's time is, and a phase's time and the run's time stop while the run is interrupted. Phase lines and agent lines share one quiet column, so what they say starts at the same place. The quiet column of a phase of several agents starts with its count, such as `0/2`, then a dot, then its agents' names while any of them has not settled, such as `0/2 · quality · elegance`. An agent's quiet column reads its newest call while it runs as one short sentence of a verb and its subject, such as `Read model-access.md`, `Searched workflowSeatPair in src/tui`, `Listed src/tui`, `Edited workflow-card.tsx`, `Dispatched explorer`, `Asked you`, or `Ran bun run test`; a shell command reads as what it does, such as `Searched rows in models; Read parsed.sql`, `Tested test_parser.py`, `Ran q2.sql in Snowflake`, `Committed fix: keep rows`, or `Viewed PR 4475`: what it changes or runs comes first, then what it reads, searches, or lists, and its directory changes, environment wrappers, and output filters are left out. A command that Flywheel does not recognize reads as the command it ran, without those wrappers. A command declared to change project files reads as `Edited` or `Wrote`, and once its changes land it names the files that it changed. A call to a tool that Flywheel does not know reads as `Called` with the tool's name and its subject. Once the agent finished, the column reads the first sentence of its handoff summary, without its final period; its reason once it failed or was skipped; `interrupted` while an interrupt holds it; and what it waits for before it starts. A phase of one agent shows that agent's sentence on its own line. When every agent of a phase settled, the phase folds to one line that says what it did after its count: its agent's summary sentence, its settled join or coverage, why it failed or was skipped, how far it got before a Stop, or, when there is nothing else to say, its agents' names again. Every agent opens its handoff summary with one short sentence that states its result. A settled phase with failed agents keeps them under its line, so a failure never hides.

The inline card shows at most 8 phase lines: finished phases before the one that needs attention fold into one line, such as `✓ 9 done`, and phases after the shown ones into another, such as `○ 6 more`. It shows at most 6 agents for each phase and 10 in all: failed agents first, then interrupted ones, then the longest running, then one line that counts the rest by state, such as `+24 more · 18 done · 2 running`. When two phases need more than 10 lines, the phase with the most lines gives one up first, and no phase shows fewer than 2. A terminal narrower than 46 columns draws no box: it shows the plan bar with a short count, such as `7/21 · 11 running`, one line that folds the plan around the phase that needs attention, such as `✓ 2 done › ● reviews › 2 more`, that phase's chits and count, and its agents. Selecting a phase expands or folds its agents, and the person's choice holds until the person changes it. Selecting the counting line lists every agent of that phase in place. The full-size card shows every phase and every agent of an expanded phase in item order, and scrolls. It shows a phase's model and effort only when every agent of the phase shares them, and otherwise each agent's own. When the agents of a phase run different briefs or personas, it names each agent's persona and its brief in the words of the agent view's line, such as `reviewer-code-security · brief review`. It adds each agent's operations. Its lines take the whole width of its frame, so a summary is cut only once the line is full. Its plan bar stays at its foot. Width never changes how many lines the card has: the card has its final height from its first frame, and only the run's progress and the person's choices change it.

Coverage reads in the same words everywhere it shows: on a settled phase's line, such as `Coverage: required 7 of 9, 2 unsurveyed`, and on the plan bar's label. It names how many required targets the survey reached out of all of them and how many it did not reach. A survey with no targets reads zero targets, a survey of supporting targets alone reads `no required targets`, and coverage never reads as full or as a percentage while a required target is unsurveyed; it reads as done only when the survey holds a required target and surveyed every one. A workflow that completed with incomplete coverage keeps its completed status, and its card names the coverage beside it. A join that selects reports what it dropped as well as what it kept, on its settled line: a deduplicating join reads such as `Removed duplicates: kept 7, dropped 3`, a ranking join such as `Ranked: kept 3, dropped 5`, and a quorum join such as `Voted: passed 2 of 3`. A settled join adds how many agents failed. Each round's settled line names its round and, when the repeats stopped there, why, such as `Round 2 · Removed duplicates: kept 0, dropped 4 · dry` or `Round 3 · Removed duplicates: kept 2, dropped 0 · max 3 rounds`. `flywheel workflow verify --session` lists each kept and dropped result with its agent and the reason the join dropped it, as the run recorded it.

The card's header names the run by the title its launch gave it, or by the workflow's name when the launch gave none, so a reused workflow file never lends the run an old name. The full-size card and the agent view name the run the same way, so the person finds the name of the card they selected on every surface of the run. It shows its state when it is not running, such as `Interrupted` or `Failed`, and its elapsed time; the full-size card adds its cost. It holds Open on the inline card, the workflow's Interrupt, Resume, or Restart as the run admits, and Stop while the parent's call can stop the run. A narrow header shortens the run's name first and its state after the name, never hides the time, and keeps every control reachable from its action menu (PI-INTERACTION-005). The card shows none of the tool calls inside the workflow, no launch line, and no warning from the launch of a workflow file: the agent that wrote the file reads each warning in its launch result and fixes the file. While a workflow's definition changed, or its saved progress is damaged, one notice line at the top of its box says so and what the person can do (PI-INTERACTION-044).

Selecting an agent that started, on either card, opens its ordinary child-session viewer with the workflow header. Opening another workflow agent replaces the current agent view. A child opened from that agent's transcript uses ordinary child-session navigation and returns to that agent when closed. On the full-size card, selecting a phase of one agent opens its agent. Selecting an agent of a stream that runs, or that an interrupt parked, opens it with its item. When the item's agent of a later phase starts, the view moves forward to that agent. It stays there after that agent settles and never moves back to an earlier phase. Manual agent navigation pins the selected session. Selecting an agent that settled shows that agent and stays on it. An agent that has not started opens nothing. The agent view's header has two bands. The workflow band is about the whole workflow: a back control that names where it returns, which is the chat's title when the agent opened from the inline card and `All agents` when it opened from the full-size card; the workflow's name, in bold behind the workflow's glyph, such as `⚙ Debug bash edit mutation flows`, so it reads apart from the back control; and the workflow's progress, marked with the word `workflow`, as chits and a count in words, such as `0/9 done · 8 running`. A rule closes the workflow band, and everything under it is about one agent. The agent line follows the rule, such as `areas › role-defaults · explorer · gpt-6-luna medium`. It starts with the phase's name and the agent's own name, which is its item key for an agent of a list and its id for a named agent, and never the record id that every agent of a list shares; the agent of a phase of one agent shows only the phase's name. Then it shows the persona's id when the agent has a persona, `brief` and the brief's id when the agent runs a brief that is not named after it, and the agent's model and effort. At the right of the same line are the agent's state, its elapsed time, and its operations, such as `running · 37s · 7 ops`, and its own Interrupt or Resume, which act on that agent alone. The follow-up conversation's line says `follow-up`. No line lists the agent's siblings: the card lists them, and the Next agent control opens the next agent and shows the open agent's place in its phase, such as `Next agent 2/9`. The agent of a phase of one agent has no place to show, so the control reads `Next agent`. The card counts each logical agent once, including when it has retries or earlier conversations. It opens that agent's current session by default. Its row and the agent view offer earlier sessions of the same agent as history. Those sessions add no agents to progress or to the Next agent order. On every workflow surface of every client, a phase's name has one color and an agent's name has another, and neither is the color of a state. The agents that the line of a phase of named agents names before the phase starts have the agent's color too. No text is cut while the line has room: the workflow's name takes the free space and is cut only when the line is full. A narrow terminal line drops parts in this order: on the workflow band the word `workflow`, then the chits, and then the count reads in the short words of a narrow plan bar, which drop the word `done`, such as `16/22 · 3 running`; on the agent line the operations, the model, the persona, the brief, then the time. A part drops only while the line has no room for it, so a part that fits again once a later part dropped stays. It never drops the way back, the workflow's name, the count, the phase's name, the agent's name, its state, or a control. A terminal band that would cut the way back or the workflow's name below 8 columns takes two lines: the way back and the name, and under them the progress, which drops its parts again only while its own line has no room. In the web client, a band too narrow for one line puts the progress on a second line under the back control and the workflow's name, where the back control gives up its width first; the progress keeps the count in its full words and drops the word `workflow`, then the chits, only while its line has no room for them. The web client's agent line drops its parts in the terminal's order while its row has no room for them. Its row is what the agent's controls leave, and on a phone a row of its own above them. A web agent line that does not fit with every part dropped wraps at a part instead of cutting it, and no wrapped line starts with a separator. The back control looks and acts as a button on every client and lights under the pointer. In the web client it shows a focus ring when the keyboard reaches it. In the terminal, no key moves the focus into the header, because Tab moves from agent to agent: Escape, and Left on an empty composer, go back, and the footer's Back control names those keys. In the terminal, the close control keeps two columns from the last part of the title line, as it does on every frame. The agent's transcript follows. It opens with one closed line for the brief that the agent received as its first message, which names its item, or the agent in a phase of named agents, the phase whose handoff it carries, and how many lines it holds, such as `Brief · item api · from probe · 52 lines` or `Brief · agent lint · 18 lines`. The agent's state reads in the words of its line on the card: an agent that runs reads as running with its running calls, never as interrupted. The agent view offers a composer while its agent runs or waits and has not finished. The composer's placeholder names its address, such as `Message item json` or `Message agent lint`, and its message reaches only that item or agent (PI-AGENT-027). It takes words only: it adds no file, and it says so. A finished agent shows no composer.

In the terminal, the full-size card moves its selection with Up and Down, opens the selected agent with Enter, expands and folds a phase with Enter, Right, and Left, and scrolls with Page Up and Page Down. Escape goes back one level: from an agent view to where it opened from, and from the full-size card to the chat. Left goes back from an agent view while its composer is empty. Tab and Shift+Tab move from agent to agent in run order. On the web client, the full-size card's list moves with the arrow keys, Home, and End, opens with Enter, and expands and folds with the right and left arrows; in an agent view `[` and `]` open the previous and next agent while no text field has focus. The keyboard shortcuts sheet lists these keys.

## PI-INTERACTION-045: A running workflow agent keeps its own model seat

A running workflow agent's model picker identifies that agent and changes its session assignment, not a persistent default for its brief. The Workflow Agent role remains available for defaults. Persona defaults remain available.

## PI-INTERACTION-048: Restart brings everything back

`/restart` in the terminal restarts Flywheel in place: the background service and the terminal both start again from the active release, or from the checkout's current source in a source run. The terminal comes back with the same open tabs, foreground session, and unsent drafts. Running work continues after the restart as it does after an update, including shell commands that are still running. Other connected clients reconnect on their own. If the service cannot restart, the terminal stays as it was and says why. In a source run, a checkout whose terminal code cannot load ends the terminal with that load error, as starting the checkout would.

## PI-INTERACTION-049: Every tap answers at once

On the web client, every tap or click shows a response at once, on any connection. A pressed control shows that it is pressed. A tap that opens a session, a subagent, a workflow, or a new chat moves to that destination at once and shows a loading screen with its name until its content arrives; the screen the person left never stays in view. A control whose action waits on the runtime shows that it is working until the action settles, and tapping it again does not repeat the action. A tap that cannot complete says why. None of this blocks other input or announces a reconnect.

## PI-INTERACTION-050: Sessions send each other messages

An agent in a chat, a subagent, or a workflow can send a message to another session or a workflow in the same project. The sender names whether its target is a session or a workflow. A workflow agent's parent is the chat that launched its workflow. A child knows its parent, and a parent can find its child sessions and the agents of its workflows. Lists distinguish session IDs from workflow IDs and identify an agent's workflow.

A message to an agent session reaches only that agent, including the parent's reply to its question. It never adds workflow direction. A message to a workflow ID uses the workflow rules in PI-AGENT-027. A workflow is not an answering agent and takes no reply wait.

Sent and received session messages appear in their ordinary transcripts as compact rows that name the direction, the other session, and its type. An agent of a workflow names its workflow membership; the workflow itself is not a session type. Workflow-target messages name the workflow at the sender and appear in the transcripts of the agents that read them. Type labels start with a capital letter, and workflow labels carry the workflow glyph. Rows start collapsed, expand to show the message, fold into each client's tool grouping, and create no divider or routine delivery receipt. Rows name the other session by its current name, or by the name recorded at sending once that session is deleted. A subagent's brief opens its transcript as a message from its parent and never returns to the person's composer. A failed send shows why it failed; a held send shows why it waits as a notice, in the same words on every client. Only a message received from the session's direct parent appears as a fully visible distinct message block with its own bar and sender color. The person's messages keep their color. A reply that the parent sends after the person spoke to it shows what the person said.

A message reaches a working session after its current action. It starts a turn in an idle session that a client shows. A chat that no client shows keeps the message without starting work. A session interrupted by a person, its parent, or the runtime, or stopped unexpectedly, keeps it until authorized continuation. A message from the parent can continue its child unless a person made the latest interrupt. The sender learns a hold at once. A planned replacement does not hold a message: the session reads it when its successor resumes.

A deleted or finished target refuses messages. A repeated message from the same sender to the same target and address is refused for 30 seconds when the recipient has sent nothing back. An unread message returns to its sender when no intended reader can read it because the target finished or was deleted. A workflow instruction remains available to each later agent its address covers; one agent reading it does not consume it for other addressed agents.

Sessions cannot keep each other working. After a short chain of peer messages, another such message to a session that answered its turn starts no work, also while it waits on background work. The session reads it later. Only a person's message ends the chain. This limit never holds a message between a session and its own parent or child. A peer message to a workflow keeps the same one-reader information and wake limits; it becomes no workflow direction.

A child can wait for its parent, and a parent can wait for its own child, without ending its turn. Flywheel refuses any other reply wait before sending. A wait ends on a reply, when the addressee reads the message and then yields without replying, or when it can no longer read messages. Waiting on work that needs the asking child cannot keep their reply wait open. Reply waits continue across planned replacement. Interrupt cuts a wait, and Resume continues it.

When the parent or runtime interrupts the child, waits on that child end and no new wait opens. A person's interrupt pauses the wait until the person resumes the child; a new wait can open while it is interrupted. That child stays the parent's active work, without an interrupt or resume notice. While a child waits on its parent, its card and viewer say so.

A person's message in a subagent viewer addresses that session. In a workflow agent view, it addresses that item or named agent through the workflow, as PI-AGENT-027 states. A person's message can continue interrupted work. A parent's message can do so only when a person did not make the latest interrupt.

A subagent or an agent of a workflow ends its session when an admitted handoff starts. From then on it reads no input of any kind, from the person, its parent, notifications, or commands, and it makes no further tool call or model request, except to correct a handoff that was not valid by writing it again. A refused send does not erase its draft. A recorded handoff ends the run without reading queued person's input. Those unread words stay visible in the parent chat transcript and return only to the sending window's parent composer while that window is open, after any existing draft with a blank line. If that window closes, the transcript notice is the only copy; no other client inserts the words. The finished subagent viewer hides its composer and states where returned words are kept. A still-owned unsent draft moves to the parent composer after its pending send settles.

## PI-INTERACTION-052: Desktop notifications page the person only when a session asks a question

While desktop notifications are on, the terminal and the web client page the person when a session, a chat or an agent of a workflow, starts waiting on a question, with the same words. That is the only moment they page: a turn that ends, and a workflow run that finishes, pauses, or fails, pages no one. Each new question pages again, also in the same session and in the session the person has open. In-app notifications are not pages and stay as PI-INTERACTION-073 states. A web page asks the browser for permission once, when the person turns the Desktop notifications switch on in its Settings. While the browser does not allow the page to notify, the switch shows off; when the browser blocks notifications, the switch says so and says how to allow them in the browser. A click on a web page's notification brings that page to the front and opens the session that asks. A click on a terminal notification opens no view in the terminal.

## PI-INTERACTION-053: A finished turn on the web client folds to its answer

On the web client, once the agent has answered and stopped working, everything between the person's message and the agent's final answer folds into one line, except the cards of workflows that the turn launched. The line gives the time the work started, how long it took, and what was run, edited, and delegated, such as "Worked 6m 12s · ran 14 commands, edited 5 files, 2 subagents". A duration of an hour or more counts hours, such as "6h 3m 41s", on every client. Each workflow card stays in view after the line, in its finished form, before the answer. Opening the line shows every other row as it was. A turn that is still running, that ended without an answer, or that reported an error stays open. Opening a search hit inside a folded turn opens it. The terminal does not fold turns.

## PI-INTERACTION-054: Running work previews its newest calls on the web client

While a stretch of calls runs on the web client, its heading shows how long the stretch has run and its newest four calls show beneath it as they land, older ones giving way. Between calls, the heading and preview stay in place while more calls can arrive. Idle completed work does not pulse or show running time. A following visible boundary or a settled turn ends the stretch. Once the stretch settles it collapses to its heading. The activity line at the end of the transcript shows how long its current activity has lasted, such as Thinking… 12s, and counts again from zero when the activity changes. Reconnecting, reloading, or opening the session on another client does not restart it. It never shows how long the turn has run.

## PI-INTERACTION-055: A finished turn lists the files it changed

On the web client, under the answer of a finished turn, the project files that the turn's own calls changed are listed with the lines added and removed. Opening a file shows the changes the turn made to it, in the order it made them. Files changed inside a subagent belong to that subagent's session and its own turns, not to the parent's turn. The whole session's changes, with the changes of every session it launched, stay in the one review (PI-INTERACTION-008).

## PI-INTERACTION-056: A wide web pane docks the workspace beside the transcript

On a web pane wide enough to keep the transcript column beside it, Changes, Background, and Status open as a panel docked at the right of the transcript rather than a sheet over it. The panel shows the selected session, stays open while the person moves between sessions, and closes with its own control or Escape. A narrower pane and the phone show them as sheets.

## PI-INTERACTION-057: The web session list leads with what needs the person

The web session list groups sessions by what they need: Needs you, where a question waits for the person's answer, which is the only state that blocks a session on the person; then Working; then Recent. An interrupted or crashed turn and a reported error leave a session in its place by work and recency; the session offers Resume once it is open, and an error row keeps the error colour. Each group lists its newest first. A row shows its state, and its line counts show only the kinds that are not zero. When the list first shows, the open session's row is in view. The header always shows the open session's title, shortened when space is short, beside any sign that another session needs the person. Where the header has room beside the title, the web header names where the session works: the project, the linked worktree when the session's working directory is one, and that directory's branch, which follows a branch switch while the session is open. A web client cannot choose a session's working directory.

## PI-INTERACTION-058: The phone prompt and long messages stay compact

The web prompt is one rounded card with text above a persistent row of controls, including on a phone before the keyboard opens. The row keeps separate commands and attachment controls, the model picker, the changed-file icon and count when nonzero, and the send or run controls. Context usage lives in the header, not the prompt. On every web pane a message from the person longer than eight lines shows those eight lines and a control that shows the rest.

## PI-INTERACTION-059: The system terminal theme follows the terminal

When the user selects the system terminal theme, Flywheel uses the terminal's reported colors and adjusts text colors for readability on their surfaces. Without reported colors, Flywheel still starts with a usable theme. The choice does not change the independent write syntax palette.

## PI-INTERACTION-060: Every terminal theme remains readable

Every built-in terminal theme keeps text, controls, and diff content readable on their surfaces, including subdued content. Each theme retains its palette character. Theme selection does not change the independent write syntax palette.

## PI-INTERACTION-061: Side questions leave the main chat in place

`/btw` lets a person ask a temporary side question using the current chat's context without interrupting its work. Side questions cannot use tools and do not enter the main transcript or normal session list. The terminal opens them in a modal, and the web client opens them in a side-question surface. The person can ask follow-up questions, reopen temporary answers, copy an answer, clear the side history, stop a side request, or keep the side conversation as an independent chat that holds the main chat's current checkpoint. Closing a side-question surface stops its pending request and returns to the main chat without changing its draft or scroll position. Temporary side history is bounded and ends when its owning runtime session is released; kept chats remain available. Side requests retain normal request accounting and inspection.

## PI-INTERACTION-062: A surface on screen stays and updates in place

A surface on screen stays and updates in place. On every client (terminal, desktop web, phone web, editor), a surface stays mounted for as long as the thing it shows exists. What the person set on it, such as a minimized question, an open or closed row, a pick, a draft, focus, and the reading position, stays as they left it. Runtime updates, reconnection, and re-reads of the transcript only change the surface in place. They never remove it and show it again or draw it again from the start. While the client cannot yet trust what a surface shows, the surface stays and holds the actions that depend on it. When content above the reader changes size or older history loads, the row the reader looks at stays at the same place on the screen. When a surface can either stay stable or show newer data sooner, it stays stable.

## PI-INTERACTION-063: A background read that fails is not announced on its own

When a client cannot read data for a surface in the background, the surface keeps what it shows and the client tries again by itself. Flywheel does not show a notice for each failed read. While such reads keep failing, one notice says in plain words that some views could not load and that Flywheel keeps trying, and it disappears once they load. A failed action that the person took still says why.

## PI-INTERACTION-064: Crashes report themselves

When a client of an official Flywheel release crashes or its runtime reports a fault, Flywheel sends a bug report to the Flywheel maintainers on its own. The crash screen or fault notice says that it sent the report automatically, shows a short report id the person can quote, and says to turn off Bug reports in Settings to stop automatic reports. Bug reports are on by default; when the person turns them off, Flywheel sends no report, automatic or manual. Only an official release build carries the maintainers' report endpoint. Any other build, such as a local install, a source run, or a release that a fork builds, sends no report: the screen says that no report was sent because the build is not an official Flywheel release and offers to copy the report. A run under Flywheel's test harness sends no automatic report. A report holds the error name, message, and stack, with secrets redacted and the home directory shown as `~`; the app version and build; the operating system and architecture; the surface; the session id; and the recent warning and failure records of the client, the account service, and the project executor, which carry only ids, counts, and timings. It holds no conversation, prompt, tool output, or file content. The person can also send a report with an optional note at any time with the report command, from an official release. When a report cannot be sent, the screen says so and offers to copy the report. `docs/privacy.md` states publicly what Flywheel sends, when, to whom, and how to turn it off.

## PI-INTERACTION-065: Unused chats can delete themselves

Settings offers automatic deletion of unused chats, off by default. When a person turns it on with a whole number of days, Flywheel deletes each chat that no one has used and that has done no work for that many days, with the workflows and child sessions its deletion removes, the same as a person's delete. A chat that is open in a tab, working, or owning running work is never deleted this way. Flywheel deletes in a project when the project opens, once a day while it stays open, and when the setting changes.

## PI-INTERACTION-066: An activity turns red only for a real stall

In the terminal, the status line shows how long the current activity has gone without progress from the model. Each activity starts in its neutral color when it appears and turns red only after time spent in it with no new output or activity change. A wait on subagents or a reply, compaction, a notice, or a lost connection is not a stall: while one shows, no stall time builds up, and the activity that follows starts neutral. A foreground tool call is not a stall: the status shows Executing in its neutral color until the call ends. A wait on background work shows Waiting, also neutral.

## PI-INTERACTION-067: Settings save as they change

On every client, a change to a setting is saved as soon as the person makes it. No settings surface has a Save key or a Save button. A choice, such as a checkbox, a switch, or a highlighted theme, saves when the person changes it. A model and its effort are one choice: the person adjusts both, and confirming the model saves them together. A typed value, such as a number or a name, saves when the person finishes it: on Enter, on leaving the field, on Escape, or when the surface closes. A typed value that is not valid is not saved, and the field says why. Each control shows the saved value: while a change is being saved the control says so, and a change that cannot be saved returns the control to the saved value with a notice that says why. Closing or leaving a settings surface never discards a change. Entering an API key is part of connecting an account and is submitted explicitly. A bulk change that turns off every module asks for confirmation first.

## PI-INTERACTION-068: A launch opens the nearest established project

A launch with `--project-root`, or else with a nonempty `FLYWHEEL_PROJECT_ROOT`, opens exactly that existing directory as the project. Otherwise Flywheel opens the nearest directory that already has a `.flywheel` folder, searching from the starting directory up to and including the nearest Git root, or only the starting directory outside Git, so a package of a monorepo with its own folder stays its own project. When no such directory exists, an interactive terminal launch asks the person to choose between the Git root and the starting directory when they differ; every other launch uses the Git root when there is one, else the starting directory. After a project's `.flywheel` folder is deleted, a later launch chooses again.

## PI-INTERACTION-069: The account home opens as a project only when named

A launch that opens a project, such as a terminal launch, a headless launch, or `flywheel web`, never finds or falls back to the account home as its project. Such a launch refuses when the account home is the only candidate, says that the account home holds the account's settings, and says that running Flywheel in any other directory starts a project there; a paired terminal can open a project on a paired machine instead. Commands that work on the account, such as `flywheel serve` and `flywheel kill`, still run from the account home.

## PI-INTERACTION-070: Status names the working directory apart from the project

When a session's working directory differs from its project root, status and session details show both, each with its own label. No surface labels the working directory as the project.

## PI-INTERACTION-071: CLI subcommands that act on a noun read noun then verb

A Flywheel CLI subcommand that acts on a noun reads noun then verb, separated by a space, such as `flywheel events search` and `flywheel auth login`. Every subcommand that takes a project directory takes it as `--project-root`.

## PI-INTERACTION-072: A dismissed notification stays dismissed

Dismissing a notification hides it on every client. While its condition stays unresolved, including across restarts, Flywheel does not raise it again; only a recurrence after the condition cleared raises a new notification.

## PI-INTERACTION-073: Each client announces new notifications and offers one list

The terminal shows one summary of open notifications at startup and one toast for each new notification. The web client shows a toolbar badge that counts the notifications that still need attention and opens their list, where resolved notifications stay as history. `/notifications` opens the list on each client. A notification offers an action button only when it has an action, and every notification can be dismissed from the list.

## PI-INTERACTION-075: An empty chat leaves no row behind

A chat with no name that the person gave and no message from the person is removed when its tab closes and when its project stops with no client holding it, so opening a chat and leaving it leaves no empty row. A runtime restart, planned or not, keeps every empty chat, and each open tab reattaches to the same chat.

## PI-INTERACTION-076: A malformed configuration file keeps the last valid settings

When a person's edit makes the configuration file malformed, Flywheel keeps using the last valid settings, or the defaults when it never read a valid file, and leaves the file unchanged. Each setting that the problem affects shows a yellow warning on its Settings row and on every group that contains it, and one notice that opens Settings stays only while such a setting is affected. A problem that names no specific setting raises no notice. A fixed file applies at once, without a restart.

## PI-CAP-011: Configuration errors say how to fix them

Flywheel ignores a setting that it does not recognize, with a warning that names the setting and lists the recognized ones, so a configuration from an earlier or later release keeps working. It rejects a recognized setting whose value is ambiguous or unsafe, with an error that says how to fix it. A setting that an earlier release accepted and that no longer has an effect is ignored with a one-line warning that names it.

## PI-CAP-012: The configuration reference shows only what a person can set

The configuration reference shows authored keys, user-facing types and constraints, defaults, examples, and each setting's application mode, and never shows internal identifiers, sensitivity metadata, secrets, or retained values.

## PI-INTERACTION-077: A chat closed elsewhere does not reopen behind the person

On the web client, returning to a recently shown session finds it ready without a cold start. A chat that another client closed opens again only when the person shows it, and a reconnect never reopens it in the background.

## PI-INTERACTION-078: A service that dies before it listens is named in the startup error

When the account service exits before it listens and wrote no failure record, the client's startup error names the executable, the build, the exit code, and the last lines of that process's error output.

## PI-INTERACTION-079: Flywheel state is never offered for commit

In a project under Git, the project's `.flywheel` folder is not offered for commit. Flywheel never edits the project's tracked files to achieve this, the rule does not reach a clone, and a project where it cannot be applied still starts normally.

## PI-INTERACTION-080: Terminal clicks land on a header's text and anywhere in a body

In the terminal, a transcript item has two kinds of click target. A header, such as a transcript line, the line that names a tool and its command, a file heading in a diff, an entry listed in an expanded group, and every row of a workflow card, accepts a click or hover only on what it draws: each displayed line's text up to its last visible character, the card's box, and an image. Blank space after a short header line, between lines, and beside a card's box does nothing. A body, the text that an item shows under its header as a preview or expanded, such as tool output, the diff of an edit, the content of a write, thinking, or a long message, accepts a click or hover anywhere in its area, including blank lines, blank space after short lines, its padding, and its rail. When bodies nest, the innermost body under the pointer takes the click. List rows in dialogs and pickers accept the whole band that their highlight paints, and buttons accept their padding.

## PI-INTERACTION-081: Each command and setting has one name and one way in

Each command has one slash token and one name, and the terminal, desktop web, phone, and editor show that name in menus, palettes, and the heading of the surface it opens. Typing a command's token opens the same surface on every client that offers that surface. A typed token that names no command is refused with the same notice on every client and is never sent as a message. Settings shows the same sections, order, and row names on every client, apart from rows that describe the terminal or the browser itself.

## PI-INTERACTION-082: Closing a tab ends no work, and Close chat ends it now

Closing a chat's tab only stops showing the chat. Its running turn, its background commands, its subagents, and its workflows go on, and the chat stays active and shows as working while they do. When its turn comes to rest, the chat closes as Close chat closes it. Opening the chat again before then keeps it open.

Close chat is the one action that ends a chat's work now. It is the command `/close`, which acts on the chat in front in every client and is refused in a subagent or a workflow agent, and the session row of every client offers it for an active chat: the terminal Sessions list, the web and phone session list, and the editor's command palette. It asks for no confirmation. It interrupts the running turn as the runtime, so Resume can continue it, stops the chat's background commands, pauses its subagents, and closes the chat. Workflows that the chat started keep running, each with its own Stop. A chat with no name that the person gave and no message from the person is removed when it closes (PI-INTERACTION-075). Close chat in the terminal, by `/close` or the Sessions list, also removes the chat's tab there.
