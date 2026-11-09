# Interaction Product Intent

This document states the current intended experience for text entry, keyboard controls, surface-specific input behavior, launch and project selection, command-line conventions, and settings and configuration files.

## PI-INTERACTION-001: Text editing is consistent and contextual

Flywheel text fields provide consistent, discoverable terminal editing controls while allowing the active surface to reserve keys for its own navigation and actions. The chat prompt and Ask User text inputs use the same editing behavior. Hotkey help is compact and groups the keys relevant to the active control. The Usage view presents its navigation vertically.

## PI-INTERACTION-097: Terminal slash popup keys complete or execute

In the terminal slash popup, Enter completes and executes the currently highlighted suggestion. Tab completes a suggestion without executing it. When no suggestion is available, Enter submits the command text as typed.

## PI-INTERACTION-002: Transcript selection follows edge dragging

While a user extends a mouse selection beyond the visible transcript, the transcript scrolls in that direction and keeps extending the selection until the user releases the mouse or reaches the transcript boundary.

## PI-INTERACTION-003: Startup reaches an interactive chat promptly

Flywheel shows an interactive prompt and makes chat ready promptly after launch in empty and populated workspaces. While the terminal waits for its first chat, it names what it is starting now over one progress bar for the whole start. A startup failure of the background service or the project appears there with its reason.

## PI-INTERACTION-004: Ask User options can require text

Ask User options can require text. Every text entry starts immediately after its option title and wraps when needed, and Flywheel submits the selected option and its text as one answer.

## PI-INTERACTION-005: Tool work appears as it happens

Flywheel shows each transcript-visible tool call with its available input, output, and mutation evidence as soon as it can do so accurately, without waiting for sibling calls or the turn's end. A shell command appears once its text arrives and streams output on every client as it runs, in the foreground or background and across turns. A settled command shows its settled output. A mutating command without mutation evidence adds one bounded landing report, plus applicable recovery instructions. The output area stays empty until output or a landing report arrives. It never shows transfer notices or other process-management instructions.

## PI-INTERACTION-139: A running command can be detached or stopped

Detach and Stop are separate controls on a running command. Detach, or the command reaching its foreground time limit, moves that one command to the background, and its row then offers Stop instead. A command that ends first stays an ordinary foreground result and never appears as background work. On the web client, both controls sit at the end of the command's own row, over the tail of a long command, so the row keeps one line.

## PI-INTERACTION-140: Stopped work reads apart from interrupted work

Stop ends a background command, a subagent's current work, or a workflow, and a stopped child's pending tool call in its parent resolves. Work a person stopped reads Stopped and work an agent stopped reads Canceled, also in saved transcripts. Work that its parent agent interrupted reads as interrupted by the parent, in the parent's transcript and in the child's own transcript. A stopped or canceled subagent admits explicit Resume, but completed subagents, stopped commands, and stopped workflows do not.

## PI-INTERACTION-141: File edits preview as diffs while they stream

File-editing tools show proposed changes as rendered diffs while input arrives, including unfinished lines, never as raw tool input. As enough input arrives, Flywheel checks syntax and applicability, and a detected problem replaces the proposed changes with a compact advisory message. Final execution replaces the preview or advice in the same view: a successful call shows the actual changes, and a failed call shows only the tool summary and error. An unavailable check or advice that arrives after final execution never delays, refuses, or replaces the final result.

## PI-INTERACTION-142: Web tool rows arrive collapsed

On the web client, every tool row arrives collapsed, edits and writes included, and shows no input, output, or diff until the user opens it. A streaming diff renders only inside a row the user has opened. A file-editing row names every file it changes beside the tool name, while its input arrives and once it has run.

## PI-INTERACTION-143: Terminal previews show a bounded first part

In the terminal, an unexpanded output preview, diffs included, shows at most its first 20 displayed rows after wrapping, with a separate limit for each file and headings and expansion controls outside it. A diff preview appears at its final height, so nothing below it moves as its content loads. A file with hidden rows shows an expansion control that shows every line in full, and wrapped diff lines continue under the code beside the line number. Further content streams out of sight until expanded, subject to displayed retention limits.

## PI-INTERACTION-144: A removed directory reads as one change

When a command removes a directory, its row shows that directory once, with the number of files and their size, instead of each file. Expanding it shows each file's change.

## PI-INTERACTION-145: Session-note changes start collapsed

Session-note changes are clearly labeled and fully collapsed until the user expands them to inspect the content or diff.

## PI-INTERACTION-146: Write output has its own syntax palette

Write calls use language syntax highlighting, and edit and patch calls use diff colors without it, while streaming and once complete. Write highlighting uses an independently selected palette: Nord by default, with Slate and Vesper available. The selection does not change chat Markdown, fenced code, interface colors, or edit and patch diff colors. Slate and Vesper match Nord's brightness and saturation range, and write styling is neither rainbow nor monochrome.

## PI-INTERACTION-147: Tool paths read against the session's directory

Tool calls display typed filesystem paths relative to the execution directory and keep canonical paths for navigation and file identity. Paths in a session's tool rows, links, and diffs resolve against that session's recorded working directory, never the client's launch directory. Its history therefore reads and opens the same after a restart or from another directory.

## PI-INTERACTION-148: Failures read as plain explanations

Tool failures show concise plain-text explanations of what happened, not serialized error envelopes. A failed subagent row shows one short error explanation, followed in a quieter style by the provider's detail when it has one. It never tells the person to retry by sending a message.

## PI-INTERACTION-149: A code-tool script reads as one Executed group

A script the agent runs through the code tool has no row of its own, and on every client its tool calls appear under one Executed heading. The heading shows the run's elapsed time once the run has settled. Call summaries under Executed show at most two displayed lines, with an ellipsis for omitted input, a limit that ordinary shell command rows do not have.

## PI-INTERACTION-150: A subagent reads as one compact row

A subagent dispatch appears in the parent transcript as a header and one agent line, in the words of an agent line on a workflow card (PI-INTERACTION-164). The header names the subagent's persona, goal, model and effort, and operations, and holds Open, Interrupt or Resume as its state admits, and Stop while it runs. The agent line marks its handoff summary as partial when the subagent stopped at its turn budget. The parent transcript renders none of the subagent's tool output, and the subagent's own session keeps its normal tool views.

## PI-INTERACTION-151: A subagent header fits a narrow width

A narrow subagent header drops the operations first, cuts the goal before the model, and shortens the model only once the goal is gone. It never drops the persona, the model, Open, a control, or the elapsed time, which follows the model and effort in the terminal and is the row's time on the web client. Every openable row keeps an open-view affordance after the child settles and never shows an expand-or-collapse affordance. On the web client, that affordance stays visible at the right even when the text truncates.

## PI-INTERACTION-152: A subagent row follows its start and each resume

While a subagent initializes, its row shows its persona and Initializing... in place of its goal, until its goal, model, controls, and activity appear together. An accepted resume of a subagent uses the full subagent row and names its action. Only the latest accepted resume shows the subagent running and settling, and the dispatch and earlier resumes show it as interrupted. Its agent line starts with the newest call of the child's earlier work and moves to each new call.

## PI-INTERACTION-153: Calls that control a child name their target

Message, interrupt, resume, and stop calls name their action and the name or short goal of their target, never its session identifier. Each shows its own outcome apart from earlier child work, and a rejected call does not mark that work as failed.

## PI-INTERACTION-154: A subagent card opens its child's transcript

In the terminal, a subagent's card opens its child's ordinary transcript in a nested viewer, and Close or Escape returns to the preceding view without interrupting work. On the web client it selects the child and keeps the parent's navigation, and Escape in its composer interrupts that subagent (PI-INTERACTION-116).

## PI-INTERACTION-155: A card header stays on one line on a phone

On a phone-width web client, a subagent's or workflow's card header stays on one line that never wraps, and its controls never take a row of their own. One ⋯ control stays at the end of the line, and the header's text fades out behind it. The control, a long press on the header, or a right-click opens a menu of the actions the card admits, each with what it does. A wider web client shows each control as its own button on the header line.

## PI-INTERACTION-156: Every client shows the same transcript

Every client shows the same messages, calls, results, subagents, and the thoughts the reader chose to see, in the same order. Clients differ only in how they group and preview those rows. On every client, consecutive reads by one tool fold into one row that names each file by its basename and shows what was read, never its contents.

## PI-INTERACTION-157: Tool calls gather under headings

In the terminal, consecutive reads, listings, and searches gather under one Explored heading, and consecutive shell commands and session bookkeeping calls under one Ran heading, each with its elapsed time once settled. On the web client, the calls between one message and the next gather under one heading that counts them, such as "Ran 2 commands, used 2 tools (1 failed)". Only an assistant message, a subagent, or an Ask User question ends that stretch. The group arrives collapsed, and a settled stretch of one call shows as that call's own row.

## PI-INTERACTION-158: Dividers mark narration after tool work

On every client, a divider falls only before narration that resumes after finalized tool work. A visible thought between the tool work and the narration removes that divider. On the web client, a folded turn (PI-INTERACTION-053) shows its dividers once it is opened.

## PI-INTERACTION-159: Running work never looks disabled

Work still running is never dimmed, and a running tool call, run, or subagent shows a pulsing marker where its row's marker sits. A row with nothing to open reads as a plain row, not a disabled one.

## PI-INTERACTION-160: A launched workflow appears in its chat as a named row

A workflow launched from a chat appears in its transcript marked with the workflow glyph before its name. Its header shows the workflow's goal, its total operations across all its agents, and its duration, and names no model. The card, the background list, and the workflow's views show the name its launch gave, or a name that Flywheel generates when the launch gave none.

## PI-INTERACTION-006: Session statistics stay live and remain visible

Session statistics update as each model request in the session reports usage, including running subagents while the parent waits. Parent statistics count each request of their subagents and workflows, at any depth, once in every total, while context-window readings stay local. Final statistics remain visible after work stops, and known statistics remain visible during a refresh. While aggregate statistics are unknown, the session picker and a new terminal chat leave them blank, other surfaces mark loading, and no surface presents partial aggregates as final.

## PI-INTERACTION-126: Stats shows the session's usage readings

Users can inspect the current session's live cache reuse, token and request usage, tool outcomes, and cost breakdowns, including descendant work, from Stats on every client. Each reading names its scope and any missing data. Cache reuse is the share of reported input read from cache, and missing cache detail reads as unavailable, never zero. When a refresh fails, Stats keeps that session's latest reading, shows the failure, and offers Retry, and it never shows another session's reading.

## PI-INTERACTION-127: Generation speed is measured and comparable

Users can compare measured generation speed by model and reasoning effort, including descendant work, in Stats on every client. The session header shows the current agent's own average generation speed. Generation speed counts streamed assistant text and tool arguments in comparison tokens over streaming time only, excluding reasoning, waiting, and tool execution. Readings name their token-count basis and missing measurements.

## PI-INTERACTION-128: Statistics account for incomplete and resumed work

Requests served without a usage report count as unmeasured, and requests whose report ended early count as partially measured. Usage that cannot be assigned to one agent stays in the workflow's exact total, and the per-agent split reads as unavailable. A resumed subagent's statistics continue from its earlier work in the same child session, excluding inactive time.

## PI-INTERACTION-129: Header statistics read calmly and precisely

Terminal header statistics, including context usage, stay neutral colored regardless of usage or session state. On the web client, the session header shows context usage as a ring with its percentage. Choosing the ring explains the reading and offers compaction without compacting at once. Displayed session costs round to the nearest cent with two decimal places, and recorded costs keep full precision.

## PI-INTERACTION-007: The transcript stays on screen through recovery

A transcript with content never shows as empty. When Flywheel's view of a session disagrees with the runtime, it keeps showing the current transcript until the replacement arrives, then shows the newest transcript in its place. When Flywheel cannot read a session's transcript, every client says so in place of an empty transcript, and it reads the transcript again when the person opens the session again.

## PI-INTERACTION-008: Session changes are reviewable in one place

Flywheel shows how many project files the current session and every session it launched, at any depth, have changed. On every client surface, one action opens a scrollable review of every changed project file in path order. Each file shows one diff from its content before these sessions first touched it to its content now, as a short preview that expands in place. A diff marks each gap of unchanged lines between its changed sections.

## PI-INTERACTION-108: The change review shows only its sessions' work

The review shows only the work of its session and the sessions it launched, including changes outside the loaded transcript. A subagent's or workflow agent's own review covers only that session and the sessions it launched. A file that something else changed after these sessions last wrote it is neither listed nor counted, and neither are Flywheel-owned files in the project's Flywheel state folder. A review that shows no files while it leaves out files the session changed says why.

## PI-INTERACTION-109: Viewed marks a file's latest edit as reviewed

A Viewed checkbox collapses the whole file and records that its latest session edit was reviewed. Viewed state belongs to the review that records it and remains across clients and restarts. A new edit to that file unchecks it and reveals the updated diff, and edits to other files leave it unchanged.

## PI-INTERACTION-110: The Changes control shows the last known count

In the terminal, a clickable Changes label sits in the prompt bar beside the remote-control display, not in the statistics header. On the web client, a Changes control sits beside the prompt. Each appears only when the last known count is greater than zero, and a plus sign marks an incomplete count. It never shows loading, error, unknown, or stale labels, which appear only inside the review, and the changes command remains available when the label is hidden.

## PI-INTERACTION-111: Each changed file has one header line

Each file in the review has one header line with the change kind, the path, the lines added and removed, and the file controls. The path is shortened from its start to keep the file name. A host with an editor offers to open the file there. The header names each launched agent that changed the file by its view title, in the agent-name color. It names no agent for the session's own changes. Files deleted under a removed directory share one directory header with their count. Expanding it shows each file with its own diff and controls.

## PI-INTERACTION-112: Undo restores a file to its content before the session

Each file offers Undo, which asks for confirmation and then restores the file to its content before the session or a session it launched first touched it. Undo deletes a file that these sessions created and restores one that they deleted, and it starts no agent work. Before it writes, Flywheel checks that the file still matches its last recorded state, and it refuses with a short reason when retained evidence cannot prove the result. A file whose diff was not retained says so and offers no Undo.

## PI-INTERACTION-009: A pending question docks at the prompt

While a chat waits on a question, the question and its choices appear at the prompt in the command menu's frame, and leave once answered or skipped. On every client, Escape skips the question, and an answer or skip that no longer applies says why. The transcript then records an Ask User entry with one row per question, titled by its header and showing the answer, and marks a skipped question cancelled. A pending question survives a closed session or a stopped Flywheel, and reopening the session shows it at the prompt again, where an answer continues the turn.

## PI-INTERACTION-085: Ask User entries read in full in the transcript

Ask User context appears immediately before its question entry as a normal assistant transcript message, with the assistant dot and full Markdown rendering. It is not tool content or question-dock copy. On the web client, saved question titles and answers wrap within the transcript width so their full text stays visible.

## PI-INTERACTION-010: Typing anywhere goes to the prompt

A printable key pressed while no editable control or dialog has the keyboard goes to the prompt. So a slash opens the command menu and a letter starts a message from anywhere in the client, with no click first, as in the TUI. Shortcuts with a modifier, space, and keys inside an editable control or an open sheet stay where they landed.

## PI-INTERACTION-011: The transcript follows new output until the user leaves the bottom

On every client the transcript stays pinned to its newest output while the user is at the bottom. Scrolling away stops the following and shows one control above the prompt that offers the latest output, or counts new messages once any arrive. Activating it returns to the bottom and resumes following, also after paging back past the live end. Wheel input over this control still scrolls the transcript.

## PI-INTERACTION-089: The prompt floats over the transcript

The prompt floats over the transcript rather than ending it. At the bottom the newest output sits clear above the prompt. Scrolled up, the transcript continues beneath the prompt to the bottom edge, dimmed toward the page colour. On the web client, a blank text line separates the live activity status from the prompt.

## PI-INTERACTION-012: Session selection reuses an empty new chat tab

Selecting an existing session replaces the current New Chat tab only when that tab is empty and has no draft. A New Chat tab with content or a draft remains open.

## PI-INTERACTION-013: Session indicators distinguish lifecycle and activity

A session appears active in tab and session indicators while Flywheel owes work for it, including while its parent agent waits for running background commands, subagents, or workflows. It appears idle only after Flywheel yields the turn to the user.

The terminal session picker shows a muted ○ for inactive but openable sessions, a steady green ● for active sessions waiting for work, and a blinking ● for sessions doing work. Inactivity does not use an error or unavailable symbol.

## PI-INTERACTION-105: A session's prompt shows its activity in every view

A session's prompt shows that session's current activity through the same status display in a tab, a nested subagent viewer, or a workflow's agent view.

## PI-INTERACTION-014: Notifications show when they were raised

Every notification shows the date and 24-hour time it was raised, to the minute, in the user's local time, on the terminal and web clients alike.

## PI-INTERACTION-015: Notifications remain available after recovery

Notification toasts and the notification list stay consistent. Condition recovery does not remove a notification: when a notification's condition clears, the notification, and any toast already shown, stays and is marked resolved. A notification remains available for 48 hours after it was raised unless it is dismissed first. If the condition comes back, it shows as a new notification.

## PI-INTERACTION-016: A new chat's card names the commands that change it

A blank chat opens on a card that states the model, the project, the branch of the chat's working directory when that directory is on one, and the profile when more than one exists. Each fact a command changes is followed by that command, the model or the settings command, in the same words on the terminal and web clients. On the web card, tapping a command opens the matching sheet.

## PI-INTERACTION-113: A chat's card shows the backend's version and optional build

The card shows the currently connected backend's version, including at the top of an existing session after an in-place backend update. A per-project Show build setting, off by default, adds the backend's eight-character build identifier beside the version, as in "(v0.0.10 build 3029f1ab)". The identifier names the running build or source snapshot, and the display says "build unavailable" when the backend cannot identify its build. Version, build, and visibility update in existing cards without reopening the session.

## PI-INTERACTION-017: The web command menu opens on settings in expected-use order and shows commands to typing

On the web client a bare slash opens a menu of settings and frequent actions in one expected-use order that Flywheel ships, most-used settings first. Each setting that changes one value in place appears there with its control, and the menu lists no other slash command or skill. Typing after the slash searches that menu and the full command catalog by name and description. Picking an entry puts it in the composer. A line under the menu counts the available commands. That line and the Commands row open a sheet of the whole catalog in menu order, with descriptions.

## PI-INTERACTION-083: The terminal command menu ranks commands by account-wide use

The terminal's command menu ranks commands by how often the person used each one. Command use counts cover the whole account, and the web Commands sheet shows them.

## PI-INTERACTION-018: Links remain one interactive target

All links act as one interactive target, no matter how long they are: hovering any row highlights the whole link.

## PI-INTERACTION-019: The model in use is always in view

Every client keeps the displayed conversation session's model and effort in view beside its prompt. The reading and its model controls name that session's serving choice, and in an agent view they name that agent, never its parent chat. The prompt reading, the web model sheet, and Model and effort in every client's command menu all edit that one choice for the transcript in view, whether a chat, a subagent, or a workflow agent. A model edit in an agent view changes only that session.

## PI-INTERACTION-020: Context shows progress toward compaction

The terminal context control shows progress toward automatic compaction when that is enabled, and otherwise the current context token count. Its running count uses the active model's token units. Opening it shows context details and an explicit Compact now action without starting compaction. Context growth does not prompt users to start a new conversation.

## PI-INTERACTION-106: Context counts reflect what the model receives

Context counts describe the content sent to the model, not omitted history or encoded transport data. The compaction report shows independent counts for the context before and after the reset. For Copilot models that models.dev describes, context capacity comes from that catalog rather than the window Copilot advertises.

## PI-INTERACTION-021: Action buttons have consistent affordances

Ordinary terminal action buttons have consistent padding, readable default styling, and visible hover and keyboard-focus feedback. Terminal prompt-bar controls share the context control's subtle background highlight on hover, and their clickable areas include the adjacent spacing without changing the bar's layout. Remote Control opens its modal, and New, Close tab, Switch, and Sessions perform their displayed actions. The tab-close control reads "close tab", never plain "close".

## PI-INTERACTION-022: Workflows belong to their parent chat

Every workflow belongs to the chat whose agent launches it, including a headless chat, and clients offer no direct workflow launch. A workflow is not a session, but each agent attempt that starts has its own conversation session directly under that chat. Earlier workflows stay reachable from the parent chat with their history and statistics intact, and a completed workflow is read-only. Follow-up conversation happens in the parent, where unfinished follow-up input waits for the person to continue it explicitly.

## PI-INTERACTION-087: A workflow's launch call waits for its result

A workflow's launching call stays pending while the workflow runs or has interrupted work that can continue. Completion and Stop resolve that call and deliver the result to the parent once.

## PI-INTERACTION-088: Deleting a chat deletes the work it owns

Deleting a parent chat stops and deletes its workflows, their agent sessions, and its other owned child sessions, including nested descendants and workflows whose agents have not started. Independent forks remain intact. Deleting a session removes it and its owned work from every client. Its recorded conversation, including provider reasoning, stays in the project's database, where the events search command can read it, until that database is removed.

## PI-INTERACTION-023: A chat can fork without changing its source

Running the fork command in a chat copies its committed active conversation branch and its current checkpoint into an independent paused chat. The source stays unchanged. The copy gets a distinct derived title and opens as the current chat. In the terminal, the copy opens in a new tab.

## PI-INTERACTION-024: Submitted messages appear immediately

Submitting a chat message on any client shows it at once as queued, and runtime output replaces that entry without a duplicate. A message sent while the connection is down, or dropped before the runtime confirms it, stays queued and is delivered once, in order, when the connection returns. A waiting message stays queued across client reloads, restarts, and self-updates. A message that the runtime refuses, or whose arrival a fault other than a lost connection leaves unknown, stays visible with the reason and can be recalled for editing and resubmission.

## PI-INTERACTION-123: Up recalls an unread queued message for editing

In the terminal, Up on an empty first row recalls the latest unread queued message in the main chat or a subagent viewer, and keeps what the person typed. A message that the agent already read cannot be recalled. A recall that Flywheel cannot complete keeps the message queued. A message still being sent or waiting for the connection cannot be edited and shows no Edit control. Up on such a message, in the terminal and on the web, keeps it queued and says that Flywheel is still sending it.

## PI-INTERACTION-124: A message that starts a chat is never sent twice

A message sent while no chat is open starts a new chat, and Flywheel never resends it by itself. If the connection drops before the runtime confirms the new chat, Flywheel says that the chat did not start, and the message can be recalled for editing. Sending it again can leave an earlier chat beside the new one. The first message in a chat that New chat or ctrl+n opened waits and is resent like any other.

## PI-INTERACTION-125: A message sent during a turn reaches the agent at the next safe handoff

A message sent while the agent works reaches it at the next safe handoff, without waiting for the turn to end. Detaching a foreground command makes that handoff available at once. If the runtime stops before the agent reads the message, the message stays in the session and is delivered once, in order, when work continues.

## PI-INTERACTION-025: The web transcript reads in a centred column

On the web client the transcript reads in one centred column of comfortable line length, and the prompt matches its width. A pane wider than the column shows empty space on both sides of it; a narrower pane, such as a phone's, fills its width. Every transcript block shares the column's width. While a workspace panel is docked beside the transcript (PI-INTERACTION-056), the column centres in the space that remains.

## PI-INTERACTION-026: The session list is furniture the user arranges

On a web pane wide enough to show the session list beside the transcript, the user can resize the list by dragging its edge. A toolbar button or Mod+B folds it away and back. The list keeps its width and fold state in that browser. With the list folded, the toolbar title opens the list, as it does on a narrow pane.

## PI-INTERACTION-027: The web client answers a small set of chords from anywhere

On the web client, Mod+K opens the session list with its search ready to type into on a keyboard-and-mouse device. Mod+B folds the session list on a wide pane. Mod+Slash opens a sheet that lists every key the client answers, including the composer's own. Mod is the platform's command key. The command menu also offers the shortcuts sheet by name.

## PI-INTERACTION-028: Messages and code blocks can be copied on the web client

Where there is a pointer, every message on the web client has a Copy control at its top right that copies its source text and takes no line of its own. On a touch device, dragging the transcript to the left reveals a Copy control beside each message until the person drags back or taps the transcript. Every fenced code block has its own Copy control that copies the code alone. A copy that succeeds says so briefly on the control it came from.

## PI-INTERACTION-122: Transcript rows show when they started and how long they ran on the web client

On the web client, every message, tool call, and group of calls shows the clock time it started, with the date when it started on an earlier day. A running row shows how long it has run, and a settled row shows how long it took. Where there is a pointer, a row's time appears at the row's right end while the pointer is over it and takes no line of its own. On a touch device, the leftward drag that reveals Copy controls also reveals the times of the rows on screen.

## PI-INTERACTION-029: Words in any transcript can be found and opened

On every client, the user searches the current session or every session in the project. The search covers people's and the agent's words and tool results, as recorded, also while a session works. Each hit, ranked by relevance, shows the speaker, the matching words in context, and in project scope the session's title. Opening a hit lands its session's transcript on the block that holds it and briefly marks that block. The search stays open with the next hit one key away. Mod+F or the command menu opens it on the web client. A command opens it in the terminal.

## PI-INTERACTION-030: Files are mentioned from a picker on every client

In the terminal and web client, typing an at sign in the composer lists matching project files and folders, best match first. It never offers ignored files, Flywheel's own state, or the repository's object store. Enter, Tab, or a click inserts a mention: an at sign and the file's project-relative path, quoted when it holds a space, then a space. The agent reads exactly that file. A bare at sign lists the top level, folders first. Picking a folder inserts its mention with a closing slash and lists the folder's contents. Escape closes the list and leaves what was typed.

## PI-INTERACTION-130: Web menus start a file mention

On the web client, choosing mention from the plus menu or the command menu opens the same file list as typing an at sign. In the editor, the mention row of the plus menu opens the editor's own file picker instead.

## PI-INTERACTION-031: Files and photos attach to a message on every client

On the web client, files or photos chosen from the plus control, pasted into the composer, or dropped onto it attach to the next message as removable chips until sent. The terminal attaches a pasted clipboard image, dragged or pasted local image paths, and files from the attach command the same way. The model sees an attached image as an image and a text file as its text and name. A message may have attachments and no text. A file of another kind or over the size limit is refused with a notice naming the file and what is accepted.

## PI-INTERACTION-120: A terminal image attachment shows at once and sends complete

In the terminal, each dragged image path shows its own numbered image marker at once, never the path first. Enter waits for an image that is still loading and then sends the complete message once. If loading fails, a notice says so and the draft stays, with no empty image or filename sent.

## PI-INTERACTION-121: Attached images preview in the transcript and open full size

Queued and sent messages show one marker per attachment and preview attached images below their text, also when the session is reopened. Each preview keeps its proportions within a bounded area smaller than the viewport. Activating a preview opens the full-resolution image in a viewer that fits, zooms, and scrolls, and closing the viewer returns to the chat. Images behind an open modal do not show through its opaque background.

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

## PI-INTERACTION-047: A background service that keeps stopping shows a warning

When the background service stops within a minute of serving, more than once in a row, every client that is attached to it or that starts it shows one warning while it serves again. The warning names the last cause and says that Flywheel starts the service again and that open sessions continue when it starts. The warning adds no control, asks nothing, and never blocks input, and it disappears on its own once the service has served for a minute. One such stop that recovers shows nothing.

## PI-INTERACTION-117: Failed session restores are explained

When Flywheel cannot restore a project's sessions after its process stops, every client says so until a later restore succeeds. The message gives the cause in plain words when one is known, such as commands that did not stop or history that could not be repaired.

## PI-INTERACTION-118: Service start failures are explained

When the background service cannot start for a cause that the kill command alone does not fix, every client that starts it shows that cause and its own remedy. The terminal keeps trying until the cause is gone.

## PI-INTERACTION-037: The background list shows a chat's background work

Each chat has one background list, which shows the background commands that the chat ran and the subagents and workflows that it started, in the order they started. A subagent or a workflow that another child started shows under that child. Each row is one tool call whose work continues in the background, so a workflow is one row and its agents have no rows of their own. The list is complete, also for work whose card is outside the loaded part of the transcript and for work that finished before Flywheel restarted.

## PI-INTERACTION-092: The background list opens on active work

The background command opens the background list, and the web command menu offers it while background work runs. In the terminal, the background count in the prompt bar also opens the list and counts only active work. The list opens on active work: commands that run, and subagents and workflows that run or wait on their parent. One control, a button in the list or a key, shows all work instead, and each client remembers the last choice for the person who uses it.

## PI-INTERACTION-093: Background rows show progress and outcome

A workflow's row states how many of its agents are done of all and how many failed, and while it runs, how many agents run and their names. A finished command shows its exit status and how long it ran, or only that it ended when Flywheel did not record its end. A finished subagent or workflow shows its status: interrupted, completed, partial, failed, stopped, or canceled. A finished subagent also shows how long it ran, and finished rows are dimmed.

## PI-INTERACTION-094: A background row shows its card in the transcript

Clicking or tapping a row in the background list closes the list and shows the row's card at once in the middle of the transcript view, and loads older transcript when necessary. A card taller than the view shows from its top, and a nested row shows the card of the child that contains it. In the terminal, the card's background stays highlighted for three seconds.

## PI-INTERACTION-095: A background row opens or stops its work

Enter, or the Open control on the web client, opens a subagent in its viewer or a workflow's full-size card. A separate x control, and the x key in the terminal, stops a row that is still active, and on the web client Stop asks for confirmation first.

## PI-INTERACTION-096: Background command output expands in the list

Background commands in the background list start with their output collapsed. In the terminal, a person selects a running command with the arrow keys and presses Space to show or hide its recent live output directly under it, independently of other commands.

## PI-INTERACTION-038: Kill progress distinguishes planned and completed work

The kill command labels the processes it plans to stop before shutdown starts and confirms the result only after cleanup finishes.

## PI-INTERACTION-046: Kill stops only the account home it runs in

The kill command stops only the Flywheel processes of the account home it runs in. It leaves a process whose account home it cannot prove running and names it. The kill command with the installed or the dev argument stops only installed builds or only source runs, and leaves the other kind running. The kill command with the all argument stops every Flywheel process on the machine.

## PI-INTERACTION-039: Web session IDs can be copied

On Windows, Linux, macOS, Android, and iOS, a user can copy the current web session ID from the command menu and any web session ID from that session's list actions. Copy works with a pointer, keyboard, or touch and confirms whether it succeeded.

## PI-INTERACTION-040: Session navigation lists chats

Session navigation lists chats only. The terminal session picker, the web session list, tabs, and their counts never show a subagent, an agent of a workflow, or a workflow. A workflow is not a session. A person reaches a subagent or workflow from its card in the parent's transcript or from the chat's background list.

## PI-INTERACTION-041: Generated tab titles use title case

Automatically generated tab titles capitalize the first letter of every word. Their longer session titles keep natural sentence casing.

People can edit a session's tab title and longer description independently. Tab titles have a 14-character limit.

## PI-INTERACTION-042: An open session is always served

A session open in a tab is always served. After a runtime restart it returns on its own, idle or waiting for model capacity, with interrupted work marked in the transcript. The person never sees it unserved or has to act to bring it back. If its runner cannot start, as when its auth profile is gone, the tab stays open. The transcript shows one failure notice until the next successful start. The next activation or message retries, and a message sent meanwhile stays in the conversation. Escape on an idle chat with no question at the prompt does nothing.

## PI-INTERACTION-043: A chat turn is interrupted, never stopped

A running chat turn has one way to stop, which is interrupt, and a chat offers no terminal stop. Every surface's control interrupts the turn, and so does Escape while no question waits at the prompt. Interrupting cuts the turn at once, including a tool call or a wait that it is in, keeps everything already committed, and leaves the session idle. Subagents, workflows, and background commands that the turn started keep running, and each has its own Stop.

## PI-INTERACTION-101: Interrupted work says who interrupted it

An interrupted session shows whether a person, its parent, the runtime, or an unexpected exit interrupted it. It reads Interrupted, Interrupted by the parent, Interrupted by the runtime, or Interrupted by an unexpected exit. Continued work reads Resumed, and no surface calls interrupted work paused.

## PI-INTERACTION-102: An interrupted chat waits for the person

An interrupted chat does not wake on its own. A notification from background work or a message from another session is recorded and starts no turn, and it lands when the person resumes or sends a message. A turn that a restart or an unexpected exit cut while it waited on background work or model capacity still waits, and the completion or the stated time wakes it. The person's latest decision wins, so an interrupt that arrives after Resume or a message cuts the turn it opens, and an earlier interrupt never cuts it.

## PI-INTERACTION-103: Resume continues an interrupted chat turn

An interrupted turn is always resumable, also after an unexpected exit, which the transcript shows where it happened. Resume continues the turn from where it stopped without a new message and never runs a finished tool call again. A message typed while the turn ran is delivered as its continuation. In the terminal, Resume is a key hint beside the other session keys, and the status area shows no session controls.

## PI-INTERACTION-104: A new message after an interrupt starts a fresh turn

Sending a new message to an interrupted chat starts a fresh turn instead of resuming the old one. That message withdraws any approval that the person gave during the interrupted turn and that the turn did not use, such as approval of a workflow launch, so the agent asks again. Resume keeps those approvals.

## PI-INTERACTION-044: A workflow can be interrupted and resumed without a message

Interrupt stops the agents it names at once: from an agent view, that agent alone, and from the card's header, every running agent. The person and the workflow's parent agent can each interrupt and resume a workflow, but the parent never resumes a workflow that a person interrupted. Resume continues each interrupted agent without a new message and without starting its phase again, also after an unexpected exit or a planned replacement. When a workflow's saved progress is damaged and its request is still readable, its card offers Restart, which runs the workflow again from that request.

## PI-INTERACTION-114: An interrupted workflow waits for a module it needs

While a module that a workflow needs is off, Resume says which module is off and how to turn it on. A message that the person sends to an interrupted agent meanwhile stays in its agent view, marked as waiting. Once the module is on, the agent continues with that message, and the person does not send it again.

## PI-INTERACTION-115: Stop ends a workflow for its parent

Stop ends a workflow for its parent and resolves the parent's call as stopped. The parent's result includes the last handoff written before the Stop, as a record of finished work and not as a request to continue. An agent view has no Stop for its agent alone.

## PI-INTERACTION-116: Escape and Back in a workflow's views

In the terminal, Escape in a workflow's views goes back one level and never interrupts: from an agent view to where it opened, and from the full-size card to the chat. Close returns to the chat. On the web client, Escape in an agent view's composer interrupts only that agent and does nothing while the agent is parked or finished. On the web client, the full-size card has no Escape action, and the Back control and the browser back gesture go back one level.

## PI-INTERACTION-051: A workflow shows its whole plan on its card

In the terminal and on the web client, the parent chat shows every workflow it launched as a card in its transcript. A workflow has no transcript of its own, so its card alone shows its plan and progress. Each agent opens in an agent view. Opening the card from its header, the background list, or a link shows it full-size over its chat, with no composer. On a phone, the full-size card is the workflow's screen. The card's height is final from its first frame. Only run progress and the person's choices change it; width does not.

## PI-INTERACTION-161: A workflow card names each phase and round of its plan

From launch, the card lists every phase that the workflow can reach, in run order, by its short id. Pointing at a phase shows its longer name. Each stream phase and each repeat round shows as its own phase, and each later round carries its number, such as "verify · round 2". A phase that repairs what a check found belongs to the round of the check that it leads to. A phase that may not run reads "if needed" until an earlier phase decides, and a phase that the workflow can no longer reach reads skipped.

## PI-INTERACTION-162: Workflow progress reads as chits and a count

Progress shows one chit per agent, colored by its state, then a count of agents that finished well. A failed agent never reads as done. A phase with an unknown list shows no chits and counts as one unit until the list arrives. Each repeat round adds its units. While the run goes on, an agent held by its own interrupt counts as interrupted on the plan bar, its phase line, and the agent view. When agents outnumber a phase's chit slots, its chits fill in proportion with at least one per present state, and the exact count follows.

## PI-INTERACTION-163: Phase and agent lines show state, name, and time

Each phase is one line with its glyph, its short id, its chits, a status column, and its time. While any of its agents runs or is interrupted, its agents show under it as a tree, each named by its item key or its own id. A phase of one agent shows no chits, because its glyph is its state, and shows its agent's sentence on its own line. Every time on a workflow surface counts only active work and stops while the run is interrupted.

## PI-INTERACTION-164: A workflow line says what its agent or phase did

An agent's status column reads its newest call while it runs, what it waits for before it starts, and "interrupted" while an interrupt holds it. Once the agent settles, the column reads the first sentence of its handoff summary, which states its result, or the reason it failed or was skipped. When every agent of a phase settles, the phase folds to one line that says what it did and keeps each failed agent visible under it. A phase over an empty list reads zero targets and has no chits and no agent.

## PI-INTERACTION-165: A running call reads as one short sentence of what it does

A running call reads as one short sentence of a verb and its subject, such as "Read" and a file name. A shell command reads as what it does, with what it changes or runs first, and leaves out directory changes, environment wrappers, and output filters. A command that Flywheel does not recognize reads as the command it ran, and a call to an unknown tool reads as "Called" with the tool's name and subject. A command declared to change project files reads as "Edited" or "Wrote" and names the files that it changed once its changes land.

## PI-INTERACTION-166: The inline workflow card stays compact

The inline card opens with the plan bar and caps how many phase and agent lines it shows, folding finished and later phases into counting lines. It shows failed agents first, then interrupted ones, then the longest running, and counts the rest by state on one line. Selecting a phase expands or folds its agents until the person changes that choice, and selecting a counting line lists every agent of that phase in place.

## PI-INTERACTION-167: The full-size workflow card shows every agent

The full-size card shows every phase and every agent of an expanded phase in item order, scrolls, and pins the plan bar at its foot. It shows a phase's model and effort when all its agents share them, and otherwise each agent's own. Its agent lines add each agent's operations, and its persona and brief wherever the agents of a phase differ in them. Its lines take the whole width of its frame, so a summary is cut only once the line is full.

## PI-INTERACTION-168: A workflow card shows coverage and join results on settled lines

A settled phase's line and the plan bar show a survey's coverage in the same words, such as "Coverage: required 7 of 9, 2 unsurveyed". A workflow that completes with incomplete coverage keeps its completed status, and its card names the coverage beside it. A settled join's line shows how many results it kept and dropped, or how many verdicts passed, and how many agents failed. Each round's settled line names its round and, when the repeat stopped there, why it stopped.

## PI-INTERACTION-169: A workflow card's header names the run and holds its controls

The header names the run by its launch title, or else by the workflow's name, and every surface of the run uses that name. It shows the elapsed time and, at full size, the cost. At both sizes it shows the state of a run that is not running, and Interrupt, Resume, or Restart as the run admits. It also shows Open on the inline card, and Stop while the parent's call can stop the run. A narrow header shortens the name, then the state, but keeps the time and keeps every control reachable from its action menu.

## PI-INTERACTION-175: A workflow card hides inner tool calls and flags a changed or damaged run

The card shows no tool calls from inside the workflow. One notice line at the card's top says when the workflow's definition changed or its saved progress is damaged.

## PI-INTERACTION-170: Selecting a workflow agent opens it and follows its item

Selecting a started agent on either card opens its agent view in place of any open agent view, and an agent that has not started opens nothing. A running or interrupted agent of a stream, once opened, moves forward to its item's agent of each later phase as that agent starts, and never moves back. Selecting an agent by hand, or one that settled, keeps the view on that agent. The card counts each logical agent once and opens its current session, and its earlier sessions stay available as history without adding to progress or the Next agent order.

## PI-INTERACTION-171: The agent view's header separates the workflow from the agent

The agent view's header has a workflow band with a back control that names its destination, the workflow's name and progress, then a rule. Below the rule, the agent line names the phase, the agent's item key or id, persona, brief unless the agent is named after it, model, and effort. The line's right end shows the agent's state, elapsed time, operations, and own Interrupt or Resume, which act on that agent alone. No line lists the agent's siblings. A Next agent control opens the next agent and shows the open agent's place in its phase.

## PI-INTERACTION-172: Workflow lines give way on narrow screens without losing what matters

Workflow surface text is never cut while its line has room, and the workflow's name takes the free space. A narrow line drops its least needed parts one at a time, only while it has no room. It never drops the way back, a name, the count, the state, or a control. A band too narrow for one line moves the progress to a second line. A web agent line that still does not fit wraps at a part instead of cutting it. On every client, phase and agent names each have their own color, never a state's color.

## PI-INTERACTION-173: An agent view shows the agent's brief and takes its messages

The agent's transcript opens with one closed line for the brief that it received, which names its item or agent, the phase whose handoff it carries, and its length. The agent's state reads in the words of its line on the card, so a running agent never reads as interrupted. While the agent runs or waits, the view offers a words-only composer whose placeholder names the item or agent that its message reaches, and a finished agent shows no composer. The follow-up conversation's agent line reads "follow-up".

## PI-INTERACTION-174: Workflow surfaces answer the keyboard

In the terminal, the full-size card selects with Up and Down, opens an agent with Enter, expands and folds a phase with Enter, Right, and Left, and scrolls by page. With an empty composer, Left leaves an agent view. Tab and Shift+Tab move between agents in run order. On the web client, the full-size card's list answers the arrow keys, Home, End, and Enter. Outside a text field, the bracket keys open the previous and next agent. The back control looks and acts as a button with hover and keyboard-focus feedback. The keyboard shortcuts sheet lists them all.

## PI-INTERACTION-045: A running workflow agent keeps its own model seat

A running workflow agent's model picker identifies that agent and changes its session assignment, not a persistent default for its brief. The Workflow Agent role remains available for defaults. Persona defaults remain available.

## PI-INTERACTION-048: Restart brings everything back

The restart command in the terminal restarts the background service and the terminal in place, from the active release or, in a source run, the checkout's current source. The terminal returns with the same open tabs, foreground session, and unsent drafts, and other connected clients reconnect on their own. Running work continues as it does after an update, including shell commands that are still running. If the service cannot restart, the terminal stays as it was and says why.

## PI-INTERACTION-049: Every tap answers at once

On the web client, every tap or click shows a response at once on any connection, and a pressed control shows that it is pressed. A tap that opens a session, a subagent, a workflow, or a new chat moves there at once and shows a loading screen with its name until the content arrives. A control whose action waits on the runtime shows that it is working until the action settles, and tapping it again does not repeat the action. A tap that cannot complete says why, and none of this blocks other input or announces a reconnect.

## PI-INTERACTION-050: Sessions send each other messages

An agent in a chat, a subagent, or a workflow can message another session or a workflow in the same project, and it names which of the two it addresses. A message reaches a working session after its current action and starts a turn in an idle session that a client shows. A chat that no client shows and an interrupted or unexpectedly stopped session hold the message without starting work and tell the sender at once. A person's message continues interrupted work, and a parent's message continues its child unless a person made the latest interrupt.

## PI-INTERACTION-131: Senders find and address their message targets

A child knows its parent, and a parent can find its child sessions and the agents of its workflows. Lists of message targets tell session IDs apart from workflow IDs and name the workflow of each agent. A person's message in a subagent viewer addresses that session.

## PI-INTERACTION-132: A message that no one can read is refused or returned

A deleted or finished target refuses messages. The same message sent again from the same sender to the same target and address within 30 seconds is refused while the recipient has sent nothing back. A message that no intended reader read returns to its sender when its target finishes or is deleted.

## PI-INTERACTION-133: Session messages show as compact rows

Each session message, sent or received, shows in its transcript as a collapsed row that expands to show it. A delivered message adds no receipt. The row names the direction and the other session by its type and current name, or by its name at sending once that session is deleted. A workflow agent is labeled with its workflow. A message to a workflow names the workflow at the sender and shows in each reading agent's transcript. A failed send shows its cause, and a held send shows a notice with its reason, in the same words on every client.

## PI-INTERACTION-134: A parent's message stands out in its child's transcript

Only a message from the session's direct parent shows as a fully visible message block with its own bar and the sender's color, and the person's messages keep their own color. A subagent's brief opens its transcript as such a message from its parent and never returns to the person's composer. A reply that the parent sends after the person spoke to it shows what the person said.

## PI-INTERACTION-135: Peer messages cannot keep sessions working

After a short chain of peer messages, a further peer message starts no work in a session that answered its turn, also while that session waits on background work. The session reads the message later, and only a person's message ends the chain. The limit never holds a message between a session and its own parent or child. A peer message to a workflow is under the same limit.

## PI-INTERACTION-136: A parent and its own child can wait for each other's reply

A child can wait for its parent's reply without ending its turn, and its card and viewer say so while it waits. A parent can wait for its own child's reply the same way, and Flywheel refuses any other reply wait before it sends the message. A wait ends on a reply, when the addressee reads the message and yields without replying, or when the addressee can no longer read messages. An addressee that waits only on work that needs the waiting session has yielded, so that work cannot keep the wait open.

## PI-INTERACTION-137: Interrupts cut or pause reply waits

When the parent or the runtime interrupts a child, every reply wait on that child ends and no new one opens. A person's interrupt pauses those waits until the person resumes the child, and a new wait can open meanwhile. Interrupt cuts a session's own reply wait, Resume continues it, and a planned replacement keeps it open.

## PI-INTERACTION-138: A child reads no input after its handoff starts

A subagent or workflow agent ends its session when an admitted handoff starts. After that it reads no input and makes no tool call or model request, except to rewrite an invalid handoff. Its unread words stay in the parent transcript. They return only to the sending window's open parent composer, after any draft and a blank line. The finished subagent viewer hides its composer and says where those words are kept. A refused send keeps its draft. An unsent draft moves to the parent composer once its pending send settles.

## PI-INTERACTION-052: Desktop notifications page the person only when a session asks a question

While desktop notifications are on, the terminal and the web client page the person with the same words when any session starts waiting on a question. A turn that ends, and a workflow run that finishes, pauses, or fails, pages no one. Each new question pages again, also in the same session and in the session the person has open. A click on a terminal notification opens no view in the terminal.

## PI-INTERACTION-090: A web page notifies only with browser permission and opens the asking session on click

A web page asks the browser for permission once, when the person turns the Desktop notifications switch on in its Settings. While the browser does not allow the page to notify, the switch shows off. When the browser blocks notifications, the switch says so and says how to allow them in the browser. A click on a web page's notification brings that page to the front and opens the session that asks.

## PI-INTERACTION-053: A finished turn on the web client folds to its answer

On the web client, once the agent has answered and finished without an error, everything between the person's message and the final answer folds into one line. The terminal never folds turns. The line gives the start time, the duration, and what was run, edited, and delegated, such as "Worked 6m 12s · ran 14 commands, edited 5 files, 2 subagents". Cards of workflows that the turn launched stay visible after the line, in their finished form, before the answer. Opening the line, or a search hit inside it, shows every other row as it was.

## PI-INTERACTION-099: Long durations count hours

On every client, a duration of an hour or more counts hours, such as "6h 3m 41s".

## PI-INTERACTION-054: Running work previews its newest calls on the web client

While a stretch of calls runs on the web client, its heading shows how long the stretch has run, and its newest four calls show beneath it as they land. Between calls, the heading and preview stay in place. A following visible boundary or a settled turn ends the stretch, which then collapses to its heading. Idle completed work does not pulse or show running time.

## PI-INTERACTION-091: The activity line times only its current activity

The activity line at the end of the transcript shows how long its current activity has lasted, such as Thinking… 12s. It counts again from zero when the activity changes. Reconnecting, reloading, or opening the session on another client does not restart it. It never shows how long the turn has run.

## PI-INTERACTION-055: A finished turn lists the files it changed

On the web client, under the answer of a finished turn, the project files that the turn's own calls changed are listed with the lines added and removed. Opening a file shows the changes the turn made to it, in the order it made them. Files changed inside a subagent belong to that subagent's session and its own turns, not to the parent's turn. The whole session's changes, with the changes of every session it launched, stay in the one review (PI-INTERACTION-008).

## PI-INTERACTION-056: A wide web pane docks the workspace beside the transcript

On a web pane wide enough to keep the transcript column beside it, Changes, Background, and Status open as a panel docked at the right of the transcript rather than a sheet over it. The panel shows the selected session, stays open while the person moves between sessions, and closes with its own control or Escape. A narrower pane and the phone show them as sheets.

## PI-INTERACTION-057: The web session list leads with what needs the person

The web session list shows Needs you, then Working, then Recent, and only a question that waits for the person's answer puts a session in Needs you. An interrupted or crashed turn or a reported error keeps a session in its place by work and recency, and an error row keeps the error colour. Each group lists its newest first, and a row shows its state and only its line counts that are not zero. When the list first shows, the open session's row is in view.

## PI-INTERACTION-084: The web header names the open session and where it works

The web header always shows the open session's title, shortened when space is short, beside any sign that another session needs the person. Where the header has room, it also names the project, the linked worktree when the working directory is one, and the branch that directory is on now. A web client cannot choose a session's working directory.

## PI-INTERACTION-058: The phone prompt and long messages stay compact

The web prompt is one rounded card with text above a persistent row of controls, including on a phone before the keyboard opens. The row keeps separate commands and attachment controls, the model picker, the changed-file icon and count when nonzero, and the send or run controls. Context usage lives in the header, not the prompt. On every web pane a message from the person longer than eight lines shows those eight lines and a control that shows the rest.

## PI-INTERACTION-059: The system terminal theme follows the terminal

When the user selects the system terminal theme, Flywheel uses the terminal's reported colors and adjusts text colors for readability on their surfaces. Without reported colors, Flywheel still starts with a usable theme. The choice does not change the independent write syntax palette.

## PI-INTERACTION-060: Every terminal theme remains readable

Every built-in terminal theme keeps text, controls, and diff content readable on their surfaces, including subdued content. Each theme retains its palette character. Theme selection does not change the independent write syntax palette.

## PI-INTERACTION-061: Side questions leave the main chat in place

The btw command lets a person ask a temporary side question using the current chat's context without interrupting its work. Side questions cannot use tools and do not enter the main transcript or normal session list. Closing a side question stops its pending request and returns to the main chat without changing its draft or scroll position. Side history is temporary and bounded, and side requests keep normal request accounting and inspection.

## PI-INTERACTION-086: A person can continue or keep a side conversation

In a side conversation, the person can ask follow-up questions, reopen or copy answers, stop a side request, and clear the side history. The person can keep a side conversation as an independent chat that holds the main chat's current checkpoint, and a kept chat stays available.

## PI-INTERACTION-062: A surface on screen stays and updates in place

On every client (terminal, desktop web, phone web, editor), a surface stays mounted for as long as the thing it shows exists. What the person set on it, such as a minimized question, an open or closed row, a pick, a draft, focus, and the reading position, stays as they left it. Runtime updates, reconnection, and re-reads of the transcript only change the surface in place, even when redrawing it would show newer data sooner. While the client cannot yet trust what a surface shows, the surface stays and holds the actions that depend on it.

## PI-INTERACTION-098: The reader's place holds while content changes

When content above the reader changes size or older history loads, the row the reader looks at stays at the same place on the screen.

## PI-INTERACTION-063: A background read that fails is not announced on its own

When a client cannot read data for a surface in the background, the surface keeps what it shows and the client tries again by itself. Flywheel does not show a notice for each failed read. While such reads keep failing, one notice says in plain words that some views could not load and that Flywheel keeps trying, and it disappears once they load. A failed action that the person took still says why.

## PI-INTERACTION-064: Crashes report themselves

When a client of an official Flywheel release crashes or its runtime reports a fault, Flywheel sends a bug report to the maintainers automatically. The crash screen or fault notice says so, shows a short report id to quote, and says that turning off Bug reports in Settings stops automatic reports. Bug reports are on by default. While they are on, the person can also send a report with an optional note at any time through the report command. Unofficial builds send no report. When no report is sent, the screen says why and offers to copy the report.

## PI-INTERACTION-107: A bug report carries no conversation content

A bug report holds the error name, message, and stack, the app version and build, the operating system and architecture, the surface, and the session id. It also holds the recent warning and failure records of the client, the account service, and the project executor, which carry only ids, counts, and timings. Secrets and the home directory path are redacted, and the report holds no conversation, prompt, tool output, or file content.

## PI-INTERACTION-065: Unused chats can delete themselves

Settings offers automatic deletion of unused chats, off by default. When a person sets it to a whole number of days, Flywheel deletes each chat that no one has used and has done no work for that many days. This deletion is the same as a person's delete, including the workflows and child sessions it removes. A chat that is open in a tab, working, or owning running work is never deleted this way. Flywheel deletes in a project when the project opens, once a day while it stays open, and when the setting changes.

## PI-INTERACTION-066: An activity turns red only for a real stall

In the terminal, the status line shows how long the current activity has gone without progress from the model. Each activity starts in its neutral color when it appears and turns red only after time spent in it with no new output or activity change. A wait on subagents or a reply, compaction, a notice, or a lost connection builds no stall time, and the activity that follows starts neutral. A foreground tool call shows Executing until it ends, and a wait on background work shows Waiting, both in the neutral color.

## PI-INTERACTION-067: Settings save as they change

On every client, a change to a setting is saved as soon as the person makes it, and no settings surface has a Save key or a Save button. A choice, such as a checkbox, a switch, or a highlighted theme, saves when the person changes it. A typed value, such as a number or a name, saves when the person presses Enter or Escape, leaves the field, or closes the surface. Entering an API key is part of connecting an account and is submitted explicitly.

## PI-INTERACTION-100: Settings controls show the saved value

Each settings control shows the saved value, and while a change is being saved the control says so. A change that cannot be saved returns the control to the saved value with a notice that says why. A typed value that is not valid is not saved, and the field says why.

## PI-INTERACTION-068: A launch opens the nearest established project

A launch with the project root option, else a nonempty matching environment setting, opens that existing directory as the project. Otherwise Flywheel opens the nearest directory with a Flywheel state folder. It searches up from the starting directory through the nearest Git root, or only that directory outside Git. A monorepo package with its own folder stays its own project. When none exists and the Git root differs from the starting directory, an interactive terminal launch asks which to use. Otherwise it uses the Git root, else the starting directory. Deleting the state folder makes a later launch choose again.

## PI-INTERACTION-069: The account home opens as a project only when named

A launch that opens a project, such as a terminal launch, a headless launch, or the web command, never finds or falls back to the account home as its project. Such a launch refuses when the account home is the only candidate. The refusal says that the account home holds the account's settings and that running Flywheel elsewhere starts a project there. A paired terminal can open a project on a paired machine instead. Commands that work on the account, such as the serve and kill commands, still run from the account home.

## PI-INTERACTION-070: Status names the working directory apart from the project

When a session's working directory differs from its project root, status and session details show both, each with its own label. No surface labels the working directory as the project.

## PI-INTERACTION-071: CLI subcommands that act on a noun read noun then verb

A Flywheel CLI subcommand that acts on a noun reads noun then verb, separated by a space, such as events search and auth login. Every subcommand that takes a project directory takes it as the project root option.

## PI-INTERACTION-072: A dismissed notification stays dismissed

Dismissing a notification hides it on every client. While its condition stays unresolved, including across restarts, Flywheel does not raise it again; only a recurrence after the condition cleared raises a new notification.

## PI-INTERACTION-073: Each client announces new notifications and offers one list

The terminal shows one summary of open notifications at startup and one toast for each new notification. The web client shows a toolbar badge that counts the notifications that still need attention and opens their list, where resolved notifications stay as history. The notifications command opens the list on each client. A notification offers an action button only when it has an action, and every notification can be dismissed from the list.

## PI-INTERACTION-075: An empty chat leaves no row behind

An empty chat has no name that the person gave and no message from the person. It is removed when its tab closes and when its project stops with no client holding it. A runtime restart, planned or not, keeps every empty chat, and each open tab reattaches to the same chat.

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

In a project under Git, the project's Flywheel state folder is not offered for commit. Flywheel never edits the project's tracked files to achieve this, the rule does not reach a clone, and a project where it cannot be applied still starts normally.

## PI-INTERACTION-080: Terminal clicks land on a header's text and anywhere in a body

In the terminal, a transcript item's header, such as a tool's command line, a diff's file heading, or a workflow card row, takes a click or hover only on its drawn text, box, or image. A body, the text an item shows under its header, takes a click or hover anywhere in its area, including blank lines, the space after short lines, its padding, and its rail. When bodies nest, the innermost body under the pointer takes the click. List rows in dialogs and pickers take the whole band that their highlight paints, and buttons take their padding.

## PI-INTERACTION-081: Each command and setting has one name and one way in

Each command has one slash token and one name, and the terminal, desktop web, phone, and editor show that name in menus, palettes, and the heading of the surface it opens. Typing a command's token opens the same surface on every client that offers that surface. A typed token that names no command is refused with the same notice on every client and is never sent as a message. Settings shows the same sections, order, and row names on every client, apart from rows that describe the terminal or the browser itself.

## PI-INTERACTION-082: Closing a tab ends no work, and Close chat ends it now

Closing a chat's tab only stops showing the chat. Its running turn, its background commands, its subagents, and its workflows go on, and the chat stays active and shows as working while they do. When its turn comes to rest, the chat closes as Close chat closes it, unless the person opens the chat again before then. Close chat is the one action that ends a chat's work now, and in the terminal it also removes the chat's tab.

## PI-INTERACTION-119: Close chat interrupts the turn and leaves workflows running

Close chat is the close command, which acts on the chat in front in every client and is refused in a subagent or a workflow agent. Every client offers Close chat on an active chat's session row, and Close chat asks for no confirmation. It interrupts the running turn as the runtime so that Resume can continue it, stops the chat's background commands, pauses its subagents, and closes the chat. Workflows that the chat started keep running, each with its own Stop.
