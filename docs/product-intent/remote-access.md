# Remote Access Product Intent

This document states the current intended experience for pairing, the relay, sealed channels, and the phone client.

## PI-REMOTE-001: Pairing is the only credential

A user pairs a device by scanning a code that Flywheel shows on the machine, or by opening or pasting the link the code carries. Devices are phones, browsers, or terminals on other machines. No account, password, or login exists for remote access. A paired device lists the machine's open projects, reads their transcripts as they stream, and sends messages that appear as the next turn.

## PI-REMOTE-002: Nothing on the machine listens

Remote access adds no remotely reachable listener or tunnel to the machine. Flywheel's account service listens only on loopback for local clients and makes outbound relay connections only after a device is paired or a pairing code is showing.

## PI-REMOTE-003: The relay cannot read a conversation

Every frame between a phone and a runtime is sealed end to end. The relay, hosted or self-hosted, learns only that a machine is online, that a paired device is attached, and the names under which a device lists the machine and its projects. A device that was never paired, or whose pairing was revoked, cannot attach even with the relay's cooperation.

## PI-REMOTE-004: Remote reachability is always visible

On every surface, the user can see whether the machine is attached to the relay, how many devices are paired, and whether a remote device is attached now. The terminal shows a remote indicator, and the web client shows these readings in Status and Remote access, not as a header badge. Within 75 seconds, an attachment the relay no longer holds shows as not attached with its reason, and a machine that lost its network leaves the phone's machine list. A relay that refuses the machine raises a project notification, but a device that attaches raises none.

## PI-REMOTE-027: A failure to offer asleep projects is explained

When the machine cannot offer its asleep projects to a phone, the Remote view says why, and every local surface keeps working.

## PI-REMOTE-005: The phone shows the same client the editor shows

The phone renders the same web client the VS Code extension renders, so a feature added to that client appears on both. The phone differs only by what its host cannot do: open files in an editor, or show a camera for pairing. Provider sign-in, paid-use review, auth profiles, role models, provider model lists, and usage are the client's own sheets, so each works on the phone as it does in the editor. Every setting, action, and reading the TUI offers is available in the client, except settings that describe the terminal itself, which the client's host owns.

## PI-REMOTE-025: The phone moves between the session list and a chat

On the phone a chat sits one screen above the session list, and its header names the chat and the project. A back control, a sideways swipe from anywhere on the screen, and the browser's back and forward move between them. Back follows the session hierarchy, regardless of visit order: a child session returns to its immediate parent, and a top-level session returns to the session list. Text selection has generous grab targets and takes priority over swipe navigation and transcript touch scrolling until the user clears it.

## PI-REMOTE-026: Session rows show each session's state and changes

Every session row and the chat header show whether the session is closed, open and idle, or open and running, by the rule the terminal's tab spinner uses. Each row shows the session's short title, its longer description beneath it, and the lines the session added, changed, and removed. On a touch screen, swiping a row left reveals its rename, close, and delete controls, on one row at a time. With a pointer, these controls appear on hover.

## PI-REMOTE-006: A user can host their own relay

A user with their own Cloudflare account deploys the relay with one command and pairs against it by passing its URL. The hosted phone app works against that relay unchanged.

## PI-REMOTE-007: A slow phone stays attached

A paired phone that is slow to draw or on a slow link stays attached to its machine while a turn streams. The machine never drops a device for falling behind, and the transcript on the phone catches up in place without reattaching or reloading. Unsupported updates from another runtime version are skipped without interrupting supported views or actions, and diagnostic searches identify each one and any session it names. A reconnect happens only when the network itself is gone.

## PI-REMOTE-008: Leaving or revisiting a session keeps the reader's place

Switching away from the phone app and back keeps the chat's scroll position, opened rows, and loaded history on screen while the phone reattaches, and reattaching starts the moment the app returns. Switching between open sessions does not reload the app, and a recently shown session appears at once with no loading screen and its draft as the person left it. Output that arrived while the reader was away appears in place. The selected session, the reader's place, and opened rows survive a runtime replacement and a switch between sessions of different runtime versions.

## PI-REMOTE-009: A paired phone can open an asleep known project

When the machine's account service is installed and the machine is awake, a paired phone lists every project this machine has opened from any local or remote surface. It shows each project as open or asleep and opens an asleep project with one tap. The row says Flywheel is starting until the project reports open, and says when Flywheel could not open it. A device is offered only projects the machine has opened and never names a path on the machine.

## PI-REMOTE-021: A paired device can create a project from a repository

A paired device can create a project on the machine by naming a repository to clone, and the machine then offers it like any project it has opened. The machine clones only over https or ssh, with its own git credentials and never a prompt. It clones into a new folder named for the repository, numbered when that name is taken. The clone finishes even if the device leaves.

## PI-REMOTE-022: A person can forget a dormant project

A person can forget a dormant project with the remote projects command, from the machine's Remote view or fixed local page, or from a phone attached to that machine. A project whose directory is gone is forgotten on its own. Opening a forgotten project again on the machine offers it again.

## PI-REMOTE-023: The machine stays awake for a phone

The machine stays awake while a phone uses a project that the phone opened, and while that project stays open after the phone leaves. A phone that comes back then finds the machine and its sessions ready. Turning off Keep Awake For Phone stops this.

## PI-REMOTE-024: Process initiation controls login startup

On installed surfaces, the account service's login startup is an explicit action named Process initiation, which reads on or off and says how to change it. A status failure reads unavailable and offers to repair the service. A failed repair says to run the serve install command on the machine and to report a bug if that command also fails. A source build omits Process initiation.

## PI-REMOTE-010: A paired phone opens straight into its session

Opening the app on a phone that has paired and chosen a project shows a Flywheel loading screen and then the session itself. The loading screen shows the app's icon with its mark in motion and names the project and machine it opens. Pairing instructions appear only when the phone has no paired machine, or when the relay reports that the remembered machine is offline or no longer offers the project.

## PI-REMOTE-028: Tapping a phone notification opens what it is about

Tapping a notification opens its machine and project on the chat or workflow it is about. A chat opens at its newest output, and a workflow opens as its full-size card over its chat. A question the notification is about shows open at the prompt. Back follows ordinary navigation, so Back from a workflow returns to its chat.

## PI-REMOTE-011: The machine's Remote view shows a code or the remote state, never both

While a pairing code is showing, the machine's Remote view shows only the code, its link, and its lifetime. The view returns to the remote state when a phone pairs or the code expires. The remote state lists each paired phone, whether it is attached, and when it paired. A phone appears under the name the person gave it on the phone before pairing or on the machine after. The remote state also lists each known project a phone can open, with paths under the account home shortened to ~. It omits relay reachability, which the prompt frame already shows.

## PI-REMOTE-029: Process initiation decides whether Flywheel starts at login

On installed surfaces, the Remote view shows Process initiation. On starts Flywheel at login, so the fixed local page and a paired phone can wake a project until the person logs out. Off does not start Flywheel at login, though a terminal or editor can start it for the current login session.

## PI-REMOTE-030: On Linux, Process initiation keeps Flywheel running after logout

On Linux, turning Process initiation on also keeps Flywheel running after the person logs out. Where the machine does not allow that, the Remote view says that Flywheel stops at logout and names the command that keeps it running.

## PI-REMOTE-012: Every surface reaches the same live session

A project appears once and offers all its sessions through one serving runtime. A requested planned replacement moves running work, subagents and workflows included, to the new runtime, which resumes it with no visible interruption or user action. Every surface then uses the new runtime and keeps its session state. Closing a surface does not end work.

## PI-REMOTE-019: A planned replacement keeps shell commands running

A planned replacement never cuts or reruns a running shell command, foreground or background. The new runtime takes the command over, Stop and the command's timeout still end it, and its result reaches the session that ran it. A foreground command still running at the handover continues in the background, as at its foreground time limit. Every other running tool call is interrupted with its turn and runs again when the turn resumes.

## PI-REMOTE-020: A planned replacement waits for no work and asks nothing of the person

No running command, turn, subagent, or workflow delays a planned replacement. A question that waits on a person stays open: the new runtime shows it unanswered, and the person's answer continues the turn. A session a person interrupted stays interrupted. The replacement never stops a person from sending a message or starting work, asks nothing of them, and shows nothing beyond a foreground command moving to the background.

## PI-REMOTE-013: One account service opens projects on demand

While a person is logged in, each machine with Flywheel installed runs one lightweight Flywheel service for the account. On Linux with lingering on, it also runs while the person is logged out. It opens no terminal or console window when it starts, and never needs one to stay open. A project backend is open only while a surface is attached or work is active, or for up to 20 minutes after a surface that showed sessions leaves. A surface that returns within that time finds its sessions ready. Any surface can open an asleep project through the service.

## PI-REMOTE-014: The phone shows the client of the machine it reaches

The phone shows the client of the runtime serving the chosen project, loaded from that machine through the relay. A newer release on the machine replaces the phone's client without a phone app update or any action by the person. The page redraws in place with the same session, reading position, and opened rows, and says nothing about the change. A phone that loaded a machine's client before, or whose relay has served it, still opens while that machine or its projects sleep, and offers wake as PI-REMOTE-009 describes. Pairing a phone for the first time needs the machine awake.

## PI-REMOTE-015: A phone is told when a chat needs it

While notifications are on, a chat that starts waiting on a question shows a notification on each paired phone, on the lock screen too, whatever any phone has open. That is the only moment a phone is notified: a turn that ends, a workflow that pauses, and a run that fails send nothing. A question answered before the notification goes out sends none, and each new question alerts again, also in the same chat. A phone receives notifications from one machine at a time, and the installed Flywheel and a source run on that machine count as one.

## PI-REMOTE-031: The phone app guides a person to turn notifications on

Flywheel has no notification setting of its own, so allowing notifications on the phone is the only step. While a phone cannot receive notifications, the phone app says why and offers the one next step that fixes it. The person can dismiss that offer, and it stays dismissed until a chat waits on them while notifications are still off.

## PI-REMOTE-016: A terminal on another machine reaches the runtime through the relay

A paired terminal on another machine lists the projects of the runtime's machine as open or asleep, and opens or wakes them. It opens one through the remote option or an added answer to its directory question, and creates nothing in a local project directory. A terminal on an older release than the machine updates itself to the machine's release and continues. A newer terminal says the machine has not updated yet and attaches once it has. A terminal on the runtime's own machine attaches locally without the relay. A remote terminal never stops, replaces, or retires that machine's runtime.

## PI-REMOTE-017: A version mismatch is explained, not hidden

A machine whose Flywheel is too old or too new for the relay is refused, and the person is told to update Flywheel, or to deploy the newest relay when they host their own. A phone whose app page is too old for the machine's client says so instead of opening the client.

## PI-REMOTE-018: A source run pairs devices on its own

The installed Flywheel and a source run of Flywheel on the same machine pair devices separately, and both can be attached to the relay at once. A paired device lists the installed Flywheel under the machine's name, and the source run as its own machine named dev followed by the machine's name in parentheses, as in "dev (Studio)". Neither is named after a project. A paired device shows each machine's current name, which it learns whenever that machine is awake, without pairing again.
