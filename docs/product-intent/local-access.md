# Local Access Product Intent

This document states the current intended experience for opening a project's sessions in a browser on the machine that runs the runtime.

## PI-LOCAL-001: One command opens the project in the browser

A user opens a project's sessions in their own browser with one command on the machine. The page shows the same web client as the editor and phone, attached to the same live runtime as the terminal and editor. The command starts the project's runtime when none is serving.

## PI-LOCAL-002: The page is reachable only from that machine, through the project's own link

The runtime listens for the browser on the loopback address alone. Each known project has its own link, the same on every start and never shared with another project, and only a page opened through that link can connect. A browser that opened the link once reaches the project again from a bookmark, a new tab, a reload, or a tab left open across a runtime restart, without the command. Opening the link of a known project that is asleep starts it, and the page says it is starting until the project serves.

## PI-LOCAL-006: A project page that cannot reach its project says why

A page whose browser never opened the project's link, or whose link no longer opens the project, says so and names the command that opens the project with a fresh link. A project that failed to open shows the cause and a link to the project list, and does not start again.

## PI-LOCAL-003: The browser tab names the session and shows its state

In the browser, the tab's title names the selected session. The title says up front when that session is working or when the page has lost the runtime. The tab's icon is Flywheel's tile, marked while the session works and dimmed while the runtime is lost. The page can be installed from the browser as an app with that name and icon.

## PI-LOCAL-004: The page's address names the session

In the browser, the address names the session in view. A reload, a bookmark, or a link opens that session, even a subagent or workflow agent that the session list does not show. The back button returns to the previous session. A reload also returns to the reader's place in the session. Only when the runtime says that the named session no longer exists does the page open the project's usual first session, correct the address, and say so in a notice.

## PI-LOCAL-005: One fixed local address reaches every open project

A machine has one fixed local address that lists every known project and tells open, asleep, starting, and closing projects apart. The address opens an open project and starts an asleep project before opening it. With exactly one known project, the address opens or starts it directly, and retries it once when it failed to start. With no known project, the address says how to open one.

## PI-LOCAL-007: The project list offers Retry and Remove for projects that do not open

When an open project's browser page cannot start, the list shows the cause and a Retry control, and the project stays usable from the terminal and editor. When the automatic retry of the only known project fails too, the address shows the list with that cause and a Retry control. The list removes an asleep or failed project on request, so no surface offers it again until the machine opens it.

## PI-LOCAL-008: The local address looks like Flywheel

While an asleep project starts, the page keeps Flywheel's visual theme and shows the animated Flywheel tile with the project name. The list page shows Flywheel's tile as its icon, so its bookmark carries the same icon as a project page.

## PI-LOCAL-009: The desktop app shows projects in one window

Each installed release on macOS, Windows, and Linux with the GNU C library includes a desktop app. It shows the same web client as a browser in one window, one project at a time, and the person switches projects without a browser. The app starts the account service when none is serving.

## PI-LOCAL-010: The desktop app stays in the menu bar or tray

While the desktop app runs, its icon stays in the menu bar or system tray, also with no window open. The icon's menu lists known projects with their state and the sessions waiting on a question, and opens any of them in the window. Closing the window releases its project, and the menu quits the app.
